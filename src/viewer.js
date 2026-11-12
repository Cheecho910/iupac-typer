// 3Dmol wrapper: one molecule, atoms colored by the fragment that owns them.
// Coordinates arrive pre-oriented from build_data.py (parent chain flat in XY).

import * as $3Dmol from '3dmol/build/3Dmol.es6-min.js';
import { mix, hexToOklab } from './color.js';

const PULSE_MS = 480;
const ROCK_DEG = 22; // gentle rock keeps the parent chain facing the camera
const ROCK_PERIOD_MS = 9000;
const IDLE_MS = 3500; // resume auto-rotate this long after the last interaction
const WIGGLE_GAP_MS = [1400, 3600]; // pause between end-group motions (min, max)
const SPIN_MS = 1100; // one full turn of a methyl / hydroxyl / amino group
const WAG_MS = 1300; // a small end group swinging back and forth
const WAG_DEG = 30;
const DOUBLE_BOND = 0.7; // 3Dmol default 0.4: each line of a double bond, relative to a single bond
const TRIPLE_BOND = 0.45; // default 0.25

export function createViewer(el, { background, neutral, text }) {
  const viewer = $3Dmol.createViewer(el, { backgroundColor: background, antialias: true });
  viewer.setHoverDuration(40);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let mol = null;
  let atoms = [];
  let colors = []; // per fragment hex (null -> neutral)
  let opts = { style: 'ball', locants: true, badges: true, wiggle: true };
  let base = []; // resting coordinates [x, y, z] per atom
  let rotors = []; // single bonds an end group can turn about
  let motion = null; // { rotor, t0 }
  let nextMotion = Infinity;
  let highlight = null; // fragment index or null
  const pulses = new Map(); // fragment -> start time
  let dirty = false;
  let lastTouch = -Infinity;
  let rockClock = 0;
  let rockAngle = 0;
  let lastFrame = performance.now();
  let hoverCb = () => {};
  let raf = 0;

  let moved = false; // user has rotated/zoomed this molecule: stop re-fitting it
  const touch = () => ((lastTouch = performance.now()), (moved = true));

  // Frame the molecule ourselves: zoomTo() fits a sphere and never zooms closer
  // than a 10 A view, which leaves small molecules tiny and clips tall ones.
  function fit() {
    if (!mol || !el.clientHeight) return;
    viewer.zoomTo(); // sets clipping planes
    const fov = viewer.camera?.fov;
    const camZ = viewer.CAMERA_Z;
    if (!fov || !camZ) return void viewer.zoom(1.2);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const a of atoms) [a.x, a.y, a.z].forEach((v, i) => ((lo[i] = Math.min(lo[i], v)), (hi[i] = Math.max(hi[i], v))));
    const half = lo.map((v, i) => (hi[i] - v) / 2);
    const pad = opts.style === 'space' ? 2.0 : 1.0; // atom radius + breathing room, in A
    const halfW = half[0] + half[2] * Math.sin((ROCK_DEG * Math.PI) / 180) + pad; // rocking swings Z into X
    const halfH = half[1] + pad;
    const usable = Math.max(120, el.clientHeight - (el.clientWidth < 600 ? 170 : 96)) / el.clientHeight; // overlays top and bottom
    const view = 2 * Math.max(halfH / usable, halfW / (el.clientWidth / el.clientHeight));
    const z = -((view * 0.5) / Math.tan((Math.PI / 180) * (fov / 2)) - camZ);
    viewer.setView([-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -(lo[2] + hi[2]) / 2, z, 0, 0, 0, 1]);
  }
  for (const ev of ['pointerdown', 'wheel', 'touchstart']) el.addEventListener(ev, touch, { passive: true });

  const pulseScale = (frag, now) => {
    const t0 = pulses.get(frag);
    if (t0 == null) return 1;
    const t = (now - t0) / PULSE_MS;
    if (t >= 1) return pulses.delete(frag), 1;
    return 1 + 0.55 * Math.sin(Math.PI * t);
  };

  function styleFor(atom, now) {
    const frag = mol.atomFragment[atom.index];
    const isH = atom.elem === 'H';
    let color = colors[frag] ?? neutral;
    if (highlight != null && frag !== highlight) color = mix(color, background, 0.72);
    else if (isH) color = mix(color, background, 0.5);
    const k = pulseScale(frag, now);
    if (opts.style === 'space') return { sphere: { scale: (isH ? 0.7 : 0.92) * (1 + (k - 1) * 0.35), color } };
    if (opts.style === 'wire') return { stick: { radius: 0.045 * (1 + (k - 1) * 3), color } };
    return {
      stick: { radius: isH ? 0.07 : 0.13, color, doubleBondScaling: DOUBLE_BOND, tripleBondScaling: TRIPLE_BOND },
      sphere: { scale: (isH ? 0.15 : 0.3) * k, color },
    };
  }

  function restyle(now) {
    for (const atom of atoms) viewer.setStyle({ index: atom.index }, styleFor(atom, now));
    dirty = false;
  }

  // ---- end-group motion: single bonds rotate, and the picture should say so.
  // A rotor is an acyclic single bond a-b whose b side is small: just b and its
  // hydrogens (CH3, OH, NH2: spins a full turn) or up to 3 heavy atoms (wags).
  // Bonds from a C=O carbon to N or O are left alone (amide/ester/acid: restricted).
  function findRotors() {
    const out = [];
    const carbonyl = (c) => c.elem === 'C' && c.bonds.some((j, k) => c.bondOrder[k] === 2 && atoms[j].elem === 'O');
    for (const b of atoms) {
      if (b.elem === 'H') continue;
      b.bonds.forEach((ai, k) => {
        const a = atoms[ai];
        if (a.elem === 'H' || b.bondOrder[k] !== 1) return;
        if ((carbonyl(a) && 'NO'.includes(b.elem)) || (carbonyl(b) && 'NO'.includes(a.elem))) return;
        const side = new Set([b.index]);
        const queue = [b.index];
        while (queue.length) {
          for (const j of atoms[queue.pop()].bonds) {
            if (j === a.index) continue;
            if (!side.has(j)) (side.add(j), queue.push(j));
          }
        }
        // ring bond: the b side loops back round to a through another neighbour
        if ([...side].some((j) => j !== b.index && atoms[j].bonds.includes(a.index))) return;
        const heavy = [...side].filter((j) => atoms[j].elem !== 'H').length;
        const moving = [...side].filter((j) => j !== b.index);
        if (!moving.length || heavy > 3 || side.size > atoms.length / 2) return;
        out.push({ a: a.index, b: b.index, moving, spin: heavy === 1 });
      });
    }
    return out;
  }

  function turn(rotor, angle) {
    const [ax, ay, az] = base[rotor.a];
    const [bx, by, bz] = base[rotor.b];
    let ux = bx - ax, uy = by - ay, uz = bz - az;
    const len = Math.hypot(ux, uy, uz) || 1;
    (ux /= len), (uy /= len), (uz /= len);
    const c = Math.cos(angle), s = Math.sin(angle);
    for (const i of rotor.moving) {
      const px = base[i][0] - bx, py = base[i][1] - by, pz = base[i][2] - bz;
      const dot = ux * px + uy * py + uz * pz;
      // Rodrigues rotation about the bond axis
      atoms[i].x = bx + px * c + (uy * pz - uz * py) * s + ux * dot * (1 - c);
      atoms[i].y = by + py * c + (uz * px - ux * pz) * s + uy * dot * (1 - c);
      atoms[i].z = bz + pz * c + (ux * py - uy * px) * s + uz * dot * (1 - c);
    }
  }

  const schedule = (now) => (nextMotion = now + WIGGLE_GAP_MS[0] + Math.random() * (WIGGLE_GAP_MS[1] - WIGGLE_GAP_MS[0]));

  function startMotion(now) {
    if (!rotors.length) return;
    motion = { rotor: rotors[Math.floor(Math.random() * rotors.length)], t0: now };
  }

  function stepMotion(now) {
    const { rotor, t0 } = motion;
    const t = (now - t0) / (rotor.spin ? SPIN_MS : WAG_MS);
    if (t >= 1) {
      turn(rotor, 0); // back to rest exactly
      motion = null;
      schedule(now);
    } else if (rotor.spin) {
      turn(rotor, 2 * Math.PI * (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t))); // ease in and out
    } else {
      turn(rotor, ((WAG_DEG * Math.PI) / 180) * Math.sin(4 * Math.PI * t) * (1 - t)); // two swings, dying away
    }
    dirty = true;
    if (!rotor.spin) relabel(); // its heavy atoms carry labels
  }

  // One label per heavy atom, drawn on the atom itself so labels can never
  // collide: chain number on carbons, element symbol on everything else
  // ("N1" when a ring nitrogen is also numbered). Ink flips to stay readable
  // on the atom's group color.
  function relabel() {
    viewer.removeAllLabels();
    if (!mol) return;
    const onAtom = opts.style !== 'wire';
    for (const a of atoms) {
      if (a.elem === 'H') continue;
      const label = mol.locants[a.index];
      const loc = opts.locants && /^\d+$/.test(label ?? '') ? label : null;
      const el = opts.badges && a.elem !== 'C' ? a.elem : null;
      if (!loc && !el) continue;
      const frag = mol.atomFragment[a.index];
      const base = colors[frag] ?? neutral;
      const dimmed = highlight != null && frag !== highlight;
      const ink = hexToOklab(base)[0] > 0.6 ? background : text;
      viewer.addLabel(`${el ?? ''}${loc ?? ''}`, {
        position: { x: a.x, y: a.y, z: a.z },
        inFront: true, alignment: 'center', bold: true, font: 'ui-monospace, Menlo, Consolas, monospace',
        fontSize: el && loc ? 13 : 15,
        fontColor: dimmed ? mix(text, background, 0.6) : onAtom ? ink : base,
        showBackground: !onAtom, backgroundColor: background, backgroundOpacity: 0.85, borderThickness: 0, padding: 2,
      });
    }
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = now - lastFrame;
    lastFrame = now;
    if (!mol) return;
    if (opts.wiggle && !reducedMotion) {
      if (motion) stepMotion(now);
      else if (now >= nextMotion) startMotion(now);
    }
    // render() rebuilds geometry for restyled atoms; rotate() only redraws.
    if (dirty || pulses.size) (restyle(now), viewer.render());
    if (!reducedMotion && now - lastTouch > IDLE_MS) {
      rockClock += dt;
      const target = ROCK_DEG * Math.sin((2 * Math.PI * rockClock) / ROCK_PERIOD_MS);
      viewer.rotate(target - rockAngle, 'y');
      rockAngle = target;
    }
  }
  raf = requestAnimationFrame(frame);

  return {
    load(entry, fragColors) {
      mol = entry;
      colors = fragColors;
      highlight = null;
      pulses.clear();
      rockClock = rockAngle = 0;
      viewer.removeAllModels();
      const model = viewer.addModel(entry.molblock, 'sdf');
      atoms = model.selectedAtoms({});
      base = atoms.map((a) => [a.x, a.y, a.z]);
      rotors = findRotors();
      motion = null;
      schedule(performance.now());
      viewer.setHoverable({}, true, (atom) => hoverCb(mol.atomFragment[atom.index]), () => hoverCb(null));
      restyle(performance.now());
      relabel();
      moved = false;
      fit(); // face-on, as oriented by the build
      viewer.render();
    },
    setColors(fragColors) {
      colors = fragColors;
      dirty = true;
      relabel();
    },
    setOptions(next) {
      const restyled = next.style && next.style !== opts.style;
      opts = { ...opts, ...next };
      if (!opts.wiggle && motion) (turn(motion.rotor, 0), (motion = null));
      dirty = true;
      relabel();
      if (restyled && !moved) (fit(), (rockAngle = rockClock = 0));
    },
    highlight(frag) {
      if (frag === highlight) return;
      highlight = frag;
      dirty = true;
      relabel();
    },
    pulse(frag) {
      if (reducedMotion) return;
      pulses.set(frag, performance.now());
    },
    /** For tests: start an end-group motion now. Returns how many rotors the molecule has. */
    wiggleNow() {
      if (motion) (turn(motion.rotor, 0), (motion = null));
      startMotion(performance.now());
      return rotors.length;
    },
    onHover(cb) {
      hoverCb = cb;
    },
    resize() {
      viewer.resize();
      if (!moved) (fit(), (rockAngle = rockClock = 0));
    },
    destroy() {
      cancelAnimationFrame(raf);
    },
  };
}
