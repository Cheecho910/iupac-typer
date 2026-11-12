import { describe, it, expect } from 'vitest';
import { newRecord, applyRun, pick, weight, isMastered, unlockedCount } from '../src/mastery.js';

const clean = { accuracy: 0.97, hints: 0, skipped: false };
const run = (rec, ...runs) => runs.reduce((r, x) => applyRun(r, x).record, rec);

describe('levels', () => {
  it('promotes after 2 consecutive clean runs', () => {
    const one = applyRun(newRecord(), clean);
    expect(one.record.level).toBe(1);
    expect(one.change).toBe(0);
    const two = applyRun(one.record, clean);
    expect(two.record.level).toBe(2);
    expect(two.change).toBe(1);
    expect(two.record.streak).toBe(0);
  });

  it('a hint or <95% breaks the streak without demoting', () => {
    expect(run(newRecord(), clean, { ...clean, hints: 1 }, clean).level).toBe(1);
    expect(run(newRecord(), clean, { ...clean, accuracy: 0.9 }, clean).level).toBe(1);
    expect(run({ ...newRecord(), level: 2 }, { ...clean, accuracy: 0.8 }).level).toBe(2);
  });

  it('demotes one level on <70% or a skip, never below 1', () => {
    const l3 = { ...newRecord(), level: 3, streak: 1 };
    expect(applyRun(l3, { accuracy: 0.69, hints: 0, skipped: false }).record).toMatchObject({ level: 2, streak: 0 });
    expect(applyRun(l3, { accuracy: 1, hints: 0, skipped: true }).change).toBe(-1);
    expect(applyRun(newRecord(), { accuracy: 0.1, hints: 0, skipped: false }).record.level).toBe(1);
  });

  it('caps at L3 and marks mastery after 2 clean runs there', () => {
    const r = run({ ...newRecord(), level: 3 }, clean, clean, clean);
    expect(r.level).toBe(3);
    expect(isMastered(r)).toBe(true);
  });
});

describe('picker', () => {
  const mols = [
    { id: 'a', tier: 1 },
    { id: 'b', tier: 1 },
    { id: 'c', tier: 4 },
  ];

  it('weights weak above strong, unseen easy tiers above unseen hard tiers', () => {
    const weak = { level: 1, streak: 0, runs: 4, acc: 0.6 };
    const strong = { level: 3, streak: 0, runs: 4, acc: 0.99 };
    expect(weight(weak, 1)).toBeGreaterThan(weight(strong, 1));
    expect(weight(undefined, 1)).toBeGreaterThan(weight(undefined, 4));
    expect(weight({ level: 3, streak: 2, runs: 9, acc: 1 }, 1)).toBeLessThan(weight(strong, 1));
  });

  it('never repeats the last molecule and follows the weights', () => {
    const mastery = { a: { level: 1, streak: 0, runs: 5, acc: 0.5 }, b: { level: 3, streak: 2, runs: 9, acc: 1 } };
    for (let i = 0; i < 50; i++) expect(pick(mols, mastery, 'a').id).not.toBe('a');
    const counts = { a: 0, b: 0, c: 0 };
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647), seed / 2147483647);
    for (let i = 0; i < 2000; i++) counts[pick(mols, mastery, null, rnd).id]++;
    expect(counts.a).toBeGreaterThan(counts.b * 5);
  });

  it('works with a single molecule', () => {
    expect(pick([mols[0]], {}, 'a').id).toBe('a');
  });
});

describe('playlist ramp', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const at = (level) => ({ level, streak: 0, runs: 3, acc: 1 });

  it('opens the first 4, then one more per molecule at level 2+', () => {
    expect(unlockedCount(ids, {})).toBe(4);
    expect(unlockedCount(ids, { a: at(1) })).toBe(4);
    expect(unlockedCount(ids, { a: at(2), c: at(3) })).toBe(6);
  });

  it('never exceeds the playlist, and counts progress made elsewhere', () => {
    expect(unlockedCount(['a', 'b'], {})).toBe(2);
    expect(unlockedCount(ids, Object.fromEntries(ids.map((id) => [id, at(3)])))).toBe(7);
    expect(unlockedCount(ids, { zzz: at(3) })).toBe(4); // other playlists' molecules don't count
    expect(unlockedCount(ids, { g: at(2) })).toBe(5); // but a shared molecule mastered elsewhere does
  });
});
