// Color math. Pure. Everything perceptual happens in OKLab.

const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp01 = (x) => Math.min(1, Math.max(0, x));

/** '#rrggbb' -> linear-light [r,g,b] in 0..1 */
export function hexToLinear(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => lin(v / 255));
}

export function linearToHex(rgb) {
  return '#' + rgb.map((v) => Math.round(clamp01(gam(clamp01(v))) * 255).toString(16).padStart(2, '0')).join('');
}

export function linearToOklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToLinear([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export const hexToOklab = (hex) => linearToOklab(hexToLinear(hex));
export const oklabToHex = (lab) => linearToHex(oklabToLinear(lab));

/** OKLab average of hex colors. */
export function blend(hexes) {
  const sum = [0, 0, 0];
  for (const h of hexes) hexToOklab(h).forEach((v, i) => (sum[i] += v));
  return oklabToHex(sum.map((v) => v / hexes.length));
}

/** Mix a toward b by t (0..1) in OKLab. Used for dimming. */
export function mix(a, b, t) {
  const A = hexToOklab(a), B = hexToOklab(b);
  return oklabToHex(A.map((v, i) => v + (B[i] - v) * t));
}

/** OKLab Euclidean distance x100 (about 2 = just noticeable). */
export function deltaE(a, b) {
  const A = hexToOklab(a), B = hexToOklab(b);
  return 100 * Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
}

// ---------------------------------------------------------------- registry

/** [{id,...}] -> {id: group} */
export const indexGroups = (list) => Object.fromEntries(list.map((g) => [g.id, g]));

/** Composite -> flat list of base group ids. */
export function resolveRecipe(id, groups) {
  const g = groups[id];
  return g.recipe ? g.recipe.flatMap((r) => resolveRecipe(r, groups)) : [id];
}

/** A group's color: user pin > own color > blend of its recipe. */
export function groupColor(id, groups, pins = {}) {
  const g = groups[id];
  if (g.alias) return groupColor(g.alias, groups, pins); // shares another group's color
  if (pins[id]) return pins[id];
  if (g.color) return g.color;
  return blend(resolveRecipe(id, groups).map((b) => groupColor(b, groups, pins)));
}

/** A fragment's color: OKLab average of its groups' colors. null if it has none. */
export function fragmentColor(groupIds, groups, pins = {}) {
  if (!groupIds.length) return null;
  return blend(groupIds.map((id) => groupColor(id, groups, pins)));
}

/** Groups that have a color of their own (aliases borrow one). */
export const ownColorIds = (groups) => Object.keys(groups).filter((id) => !groups[id].alias);

/** Every distinct group color, derived blends included. */
export function palette(groups, pins = {}) {
  return Object.fromEntries(ownColorIds(groups).map((id) => [id, groupColor(id, groups, pins)]));
}

// ---------------------------------------------------------------- color vision

// Machado, Oliveira & Fernandes (2009), severity 1.0, applied in linear RGB.
const CVD = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};
export const VISIONS = ['normal', 'protan', 'deutan', 'tritan'];

export function simulate(hex, vision) {
  if (vision === 'normal') return hex;
  const rgb = hexToLinear(hex);
  return linearToHex(CVD[vision].map((row) => row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]));
}

/** Pairs of groups whose colors are closer than `threshold` under `vision`. */
export function closePairs(groups, pins = {}, threshold = WARN_DELTA_E, vision = 'normal') {
  const pal = Object.entries(palette(groups, pins)).map(([id, hex]) => [id, simulate(hex, vision)]);
  const out = [];
  for (let i = 0; i < pal.length; i++)
    for (let j = i + 1; j < pal.length; j++) {
      const dE = deltaE(pal[i][1], pal[j][1]);
      if (dE < threshold) out.push({ a: pal[i][0], b: pal[j][0], dE });
    }
  return out.sort((x, y) => x.dE - y.dE);
}

/** Smallest pairwise distance in the palette under `vision`. */
export function minDeltaE(groups, pins = {}, vision = 'normal') {
  const [worst] = closePairs(groups, pins, Infinity, vision);
  return worst ? worst.dE : Infinity;
}

export const WARN_DELTA_E = 8;
