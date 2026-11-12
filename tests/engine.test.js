import { describe, it, expect } from 'vitest';
import { createRun, press, hint, stats, isDone, currentFragment, shiftClock, emptyTally, addToTally, tallyStats } from '../src/engine.js';
import molecules from '../public/molecules.json';

const frags = (...texts) => texts.map((text) => ({ text }));
const type = (s, keys, t = 0) => {
  let last;
  for (const k of keys) {
    last = press(s, k, t);
    s = last.state;
  }
  return { ...last, state: s };
};

// "2-" "methyl" "propan" "-1-" "ol"
const MP = frags('2-', 'methyl', 'propan', '-1-', 'ol');

describe('stop-on-error', () => {
  it('a wrong key does not advance and is counted', () => {
    const s0 = createRun(frags('eth', 'ol'));
    const r = press(s0, 'x', 0);
    expect(r.result).toBe('error');
    expect(r.state.pos).toBe(0);
    expect(r.state.wrong).toBe(1);
    expect(press(r.state, 'e', 1).state.pos).toBe(1);
  });

  it('is case-insensitive', () => {
    expect(press(createRun(frags('eth')), 'E', 0).result).toBe('ok');
  });

  it('finishes exactly at the last character and then ignores input', () => {
    const r = type(createRun(frags('eth', 'ol')), 'ethol');
    expect(r.result).toBe('done');
    expect(isDone(r.state)).toBe(true);
    expect(press(r.state, 'x', 9).result).toBe('ignored');
    expect(press(r.state, 'x', 9).state.wrong).toBe(0);
  });

  it('ignores non-character keys', () => {
    const s = createRun(frags('eth'));
    for (const k of ['Shift', 'Tab', 'Enter', 'Escape', '']) expect(press(s, k, 0).result).toBe('ignored');
  });
});

describe('per-fragment error attribution', () => {
  it('charges the fragment that owns the character being typed', () => {
    let s = createRun(MP);
    s = press(s, 'x', 0).state; // at "2-"
    s = type(s, '2-').state;
    s = press(s, 'x', 0).state; // at "methyl"
    s = press(s, 'y', 0).state;
    s = type(s, 'methylpropan').state;
    s = press(s, '1', 0).state; // expected '-', owned by "-1-"
    expect(s.errors).toEqual([1, 2, 0, 1, 0]);
    expect(currentFragment(s)).toBe(3);
  });

  it('reports each fragment completion once, at its last character', () => {
    let s = createRun(MP);
    expect(press(s, '2', 0).completed).toEqual([]);
    s = press(s, '2', 0).state;
    expect(press(s, '-', 0).completed).toEqual([0]);
    const end = type(s, '-methylpropan-1-ol');
    expect(end.completed).toEqual([4]);
  });
});

describe('punctuation setting', () => {
  it('OFF: hyphens, spaces must be typed', () => {
    const s = createRun(frags('ethyl', ' ', 'ethan', 'oate'));
    const r = type(s, 'ethyle');
    expect(r.result).toBe('error'); // wanted the space
    expect(r.state.errors).toEqual([0, 1, 0, 0]);
  });

  it('ON: punctuation is typed for you, including leading and trailing', () => {
    const s = createRun(MP, { autoPunct: true });
    const a = press(s, '2', 0);
    expect(a.state.pos).toBe(2); // skipped '-'
    expect(a.completed).toEqual([0]);
    const end = type(s, '2methylpropan1ol');
    expect(end.result).toBe('done');
    expect(end.state.correct).toBe(16);
    expect(end.state.wrong).toBe(0);
  });

  it('ON: a locant made only of auto-typed edges completes with its digit', () => {
    let s = createRun(frags('propan', '-2-', 'one'), { autoPunct: true });
    s = type(s, 'propan').state;
    expect(s.pos).toBe(7); // already past the leading '-'
    expect(press(s, '2', 0).completed).toEqual([1]);
  });

  it('ON: typed punctuation is ignored, not an error', () => {
    const s = createRun(MP, { autoPunct: true });
    const r = type(s, '2-');
    expect(r.result).toBe('ignored');
    expect(r.state.wrong).toBe(0);
  });

  it('ON: a whole-punctuation fragment (ester space) is skipped', () => {
    const r = type(createRun(frags('ethyl', ' ', 'ethan', 'oate'), { autoPunct: true }), 'ethylethanoate');
    expect(r.result).toBe('done');
  });
});

describe('hints', () => {
  it('reveals the current fragment, then the next, and counts each', () => {
    let s = type(createRun(MP), '2-me').state;
    let h = hint(s);
    expect(h.revealed).toBe(1);
    h = hint(h.state);
    expect(h.revealed).toBe(2);
    expect(h.state.hints).toBe(2);
    expect(h.state.pos).toBe(s.pos); // a hint types nothing
  });

  it('does nothing once everything is revealed or the run is done', () => {
    let s = createRun(frags('eth', 'ol'));
    s = hint(hint(s).state).state;
    expect(hint(s).revealed).toBe(-1);
    expect(hint(s).state.hints).toBe(2);
    expect(hint(type(createRun(frags('a')), 'a').state).revealed).toBe(-1);
  });
});

describe('metrics', () => {
  it('accuracy = correct / all keys; WPM = chars / 5 / minutes from first key', () => {
    let s = createRun(frags('ethan', 'ol'));
    s = press(s, 'x', 1000).state; // clock starts on the first key, even a wrong one
    s = type(s, 'ethano', 2000).state;
    s = press(s, 'l', 13000).state;
    const st = stats(s, 99999);
    expect(st.ms).toBe(12000);
    expect(st.accuracy).toBeCloseTo(7 / 8);
    expect(st.wpm).toBeCloseTo(7 / 5 / (12 / 60));
    expect(st.errors).toEqual([1, 0]);
  });

  it('untouched run: 100% accuracy, 0 WPM; pausing shifts the clock', () => {
    const s = createRun(frags('a', 'b'));
    expect(stats(s, 5).accuracy).toBe(1);
    expect(stats(s, 5).wpm).toBe(0);
    const t = press(s, 'a', 100).state;
    expect(stats(shiftClock(t, 400), 1100).ms).toBe(600);
    expect(shiftClock(s, 400).startedAt).toBe(null);
  });
});

describe('session tally', () => {
  it('sums runs and uses the same definitions as stats()', () => {
    expect(tallyStats(emptyTally())).toEqual({ accuracy: 1, wpm: 0, ms: 0 });
    let s = createRun(frags('ethan', 'ol'));
    s = press(s, 'x', 0).state;
    s = type(s, 'ethanol', 6000).state; // 7 correct, 1 wrong, 6 s
    let t = addToTally(emptyTally(), stats(s, 6000));
    expect(tallyStats(t)).toEqual(expect.objectContaining({ ms: 6000 }));
    expect(tallyStats(t).accuracy).toBeCloseTo(7 / 8);
    let s2 = type(createRun(frags('abc')), 'abc', 1000).state; // first key at t=1000 -> 0 ms
    s2 = { ...s2, startedAt: 0, endedAt: 6000 };
    t = addToTally(t, stats(s2, 6000));
    expect(t).toEqual({ correct: 10, wrong: 1, ms: 12000 });
    expect(tallyStats(t).wpm).toBeCloseTo(10 / 5 / 0.2);
    expect(tallyStats(t).accuracy).toBeCloseTo(10 / 11);
  });
});

describe('long punctuated names (built data)', () => {
  const byId = Object.fromEntries(molecules.molecules.map((m) => [m.id, m]));
  it('auto-punctuation handles parentheses, commas and letter locants', () => {
    const m = byId.lidocaine;
    const end = type(createRun(m.fragments, { autoPunct: true }), m.name.replace(/[-, ()]/g, ''));
    expect(end.result).toBe('done');
    expect(end.state.wrong).toBe(0);
  });
  it('letter locants are case-insensitive', () => {
    const m = byId['n-phenylethanamide'];
    expect(type(createRun(m.fragments), m.name.toLowerCase()).result).toBe('done');
  });
});

describe('fragment/name invariant (built data)', () => {
  it.each(molecules.molecules.map((m) => [m.name, m]))('%s', (_, m) => {
    expect(m.fragments.map((f) => f.text).join('')).toBe(m.name);
    const s = createRun(m.fragments);
    expect(s.chars.map((c) => c.ch).join('')).toBe(m.name);
    expect(type(s, m.name).result).toBe('done'); // the canonical string is typeable
    // every atom maps to a fragment that is allowed to own atoms
    for (const f of m.atomFragment) expect(['locant', 'separator', 'descriptor']).not.toContain(m.fragments[f].role);
  });
});
