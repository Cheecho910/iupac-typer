import { describe, it, expect } from 'vitest';
import {
  hexToOklab, oklabToHex, blend, deltaE, mix, indexGroups, resolveRecipe, groupColor,
  fragmentColor, palette, closePairs, minDeltaE, simulate, WARN_DELTA_E, themed, forLight, presetPins,
} from '../src/color.js';
import registry from '../data/groups.json';

const groups = indexGroups(registry.groups); // dark theme
const light = themed(groups, 'light');
// a registry whose composites have no color of their own, to test blending
const plain = indexGroups(registry.groups.map(({ color, colorLight, ...g }) => (g.recipe ? g : { ...g, color })));

describe('OKLab', () => {
  it('matches reference values', () => {
    const near = (hex, lab) => hexToOklab(hex).forEach((v, i) => expect(v).toBeCloseTo(lab[i], 3));
    near('#ffffff', [1, 0, 0]);
    near('#000000', [0, 0, 0]);
    near('#ff0000', [0.628, 0.2249, 0.1258]);
    near('#0000ff', [0.452, -0.0325, -0.3115]);
  });

  it('round-trips', () => {
    for (const h of ['#ff0000', '#00ff00', '#0000ff', '#98a0aa', '#123456', '#c9ce34'])
      expect(oklabToHex(hexToOklab(h))).toBe(h);
  });

  it('deltaE: 0 for identical, 100 for black/white, symmetric', () => {
    expect(deltaE('#336699', '#336699')).toBe(0);
    expect(deltaE('#000000', '#ffffff')).toBeCloseTo(100, 1);
    expect(deltaE('#ff0000', '#00ff00')).toBeCloseTo(deltaE('#00ff00', '#ff0000'), 9);
  });
});

describe('blending', () => {
  it('is the OKLab midpoint, not the sRGB one', () => {
    const b = blend(['#ff0000', '#0000ff']);
    const lab = hexToOklab(b), r = hexToOklab('#ff0000'), u = hexToOklab('#0000ff');
    lab.forEach((v, i) => expect(v).toBeCloseTo((r[i] + u[i]) / 2, 2));
    expect(b).not.toBe('#800080');
    expect(blend(['#123456'])).toBe('#123456');
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff');
  });
});

describe('recipe resolution', () => {
  it('composites resolve to base groups', () => {
    expect(resolveRecipe('carboxylic-acid', groups)).toEqual(['carbonyl', 'hydroxyl']);
    expect(resolveRecipe('ester', groups)).toEqual(['carbonyl', 'ether-oxygen']);
    expect(resolveRecipe('amide', groups)).toEqual(['carbonyl', 'amine']);
    expect(resolveRecipe('hydroxyl', groups)).toEqual(['hydroxyl']);
  });

  it('resolves nested recipes', () => {
    const g = indexGroups([
      { id: 'a', color: '#ff0000' }, { id: 'b', color: '#00ff00' }, { id: 'c', color: '#0000ff' },
      { id: 'ab', recipe: ['a', 'b'] }, { id: 'abc', recipe: ['ab', 'c'] },
    ]);
    expect(resolveRecipe('abc', g)).toEqual(['a', 'b', 'c']);
    expect(groupColor('abc', g)).toBe(blend(['#ff0000', '#00ff00', '#0000ff']));
  });

  it('a composite without its own color is the blend of its recipe, and follows its bases', () => {
    const ester = blend([plain.carbonyl.color, plain['ether-oxygen'].color]);
    expect(groupColor('ester', plain)).toBe(ester);
    expect(groupColor('ester', plain, { carbonyl: '#ffffff' })).toBe(blend(['#ffffff', plain['ether-oxygen'].color]));
  });

  it('a composite with a default color keeps it; a pin beats everything', () => {
    expect(groupColor('amide', groups)).toBe(groups.amide.color);
    expect(groupColor('amide', groups, { carbonyl: '#ffffff' })).toBe(groups.amide.color);
    expect(groupColor('ester', groups, { ester: '#00ff00', carbonyl: '#ffffff' })).toBe('#00ff00');
    expect(groupColor('hydroxyl', groups, { hydroxyl: '#111111' })).toBe('#111111');
  });

  it('fragment color = average over its groupIds; none -> null', () => {
    expect(fragmentColor(['hydroxyl'], groups)).toBe(groups.hydroxyl.color.toLowerCase());
    expect(fragmentColor(['carbonyl', 'carbonyl'], groups)).toBe(groups.carbonyl.color.toLowerCase());
    expect(fragmentColor(['carbonyl', 'hydroxyl'], plain)).toBe(groupColor('carboxylic-acid', plain));
    expect(fragmentColor([], groups)).toBe(null);
  });
});

describe('deltaE warning', () => {
  it('flags close pairs, derived blends included, sorted worst first', () => {
    const pins = { hydroxyl: plain.carbonyl.color }; // acid blend collapses onto carbonyl
    const pairs = closePairs(plain, pins);
    expect(pairs[0].dE).toBe(0);
    const ids = pairs.map((p) => [p.a, p.b].sort().join('+'));
    expect(ids).toContain('carbonyl+hydroxyl');
    expect(ids).toContain('carbonyl+carboxylic-acid');
  });

  it('threshold is exclusive and configurable', () => {
    const g = indexGroups([{ id: 'a', color: '#808080' }, { id: 'b', color: '#868686' }]);
    const d = deltaE('#808080', '#868686');
    expect(closePairs(g, {}, d)).toEqual([]);
    expect(closePairs(g, {}, d + 0.01)).toHaveLength(1);
  });
});

const hue = (hex) => {
  const [, a, b] = hexToOklab(hex);
  return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
};

describe.each([['dark', groups, 0.6, 0.93], ['light', light, 0.4, 0.7]])('default palette, %s theme', (theme, reg, minL, maxL) => {
  it('has 13 colors (alias groups add none)', () => {
    expect(Object.keys(palette(reg))).toHaveLength(13);
    expect(groupColor('heteroaromatic', reg)).toBe(groupColor('aromatic', reg));
    expect(groupColor('oxo', reg)).toBe(groupColor('carbonyl', reg));
    expect(closePairs(reg, {}, 1).some((p) => reg[p.a].alias || reg[p.b].alias)).toBe(false);
  });

  it('follows element conventions: O red/orange/pink, N blue, halogen green, amide purple', () => {
    const h = (id) => hue(groupColor(id, reg));
    expect(h('hydroxyl')).toBeGreaterThan(15);
    expect(h('hydroxyl')).toBeLessThan(40); // red
    expect(h('carbonyl')).toBeGreaterThan(50);
    expect(h('carbonyl')).toBeLessThan(90); // orange, not red
    expect(h('amine')).toBeGreaterThan(240);
    expect(h('amine')).toBeLessThan(275); // blue
    expect(h('halide')).toBeGreaterThan(130);
    expect(h('halide')).toBeLessThan(160); // green
    expect(h('amide')).toBeGreaterThan(288);
    expect(h('amide')).toBeLessThan(320); // purple, between blue and red
  });

  it('raises no warnings in normal vision', () => {
    expect(closePairs(reg, {}, WARN_DELTA_E)).toEqual([]);
  });

  // Element conventions put five oxygen groups in the red-orange-pink range, so
  // separation for red-green colour blindness is lower than the preset below.
  it.each([['normal', 11], ['protan', 5], ['deutan', 5], ['tritan', 3]])('every pair stays apart under %s vision (min deltaE >= %d)', (vision, floor) =>
    expect(minDeltaE(reg, {}, vision)).toBeGreaterThanOrEqual(floor));

  it(`is readable on the ${theme} stage`, () => {
    for (const hex of Object.values(palette(reg))) {
      expect(hexToOklab(hex)[0]).toBeGreaterThanOrEqual(minL);
      expect(hexToOklab(hex)[0]).toBeLessThanOrEqual(maxL);
    }
  });
});

describe('colorblind-safe preset', () => {
  const pins = presetPins(registry.presets.colorblind.colors, groups, 'dark');

  it('pins all 13 colors, composites as blends of their recipe', () => {
    expect(Object.keys(pins)).toHaveLength(13);
    expect(pins.ester).toBe(blend([pins.carbonyl, pins['ether-oxygen']]));
  });

  it.each([['normal', 9], ['protan', 7], ['deutan', 7], ['tritan', 4.5]])('every pair stays apart under %s vision (min deltaE >= %d)', (vision, floor) =>
    expect(minDeltaE(groups, pins, vision)).toBeGreaterThanOrEqual(floor));

  it('has a darker variant for the light theme', () => {
    const lp = presetPins(registry.presets.colorblind.colors, groups, 'light');
    for (const [id, hex] of Object.entries(registry.presets.colorblind.colors)) {
      expect(lp[id]).toBe(forLight(hex));
      expect(hexToOklab(lp[id])[0]).toBeLessThan(hexToOklab(hex)[0]);
    }
  });
});

describe('colour-vision simulation', () => {
  it('actually changes red/green', () => {
    expect(deltaE(simulate('#ff0000', 'deutan'), simulate('#00a000', 'deutan'))).toBeLessThan(deltaE('#ff0000', '#00a000') / 2);
    expect(simulate('#808080', 'protan')).toBe('#808080');
  });
});
