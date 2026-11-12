// Per-molecule levels and the adaptive picker. Pure.
//
// L1 Copy -> L2 Slots -> L3 Recall.

export const CLEAN_ACCURACY = 0.95;
export const DEMOTE_ACCURACY = 0.7;
export const PROMOTE_STREAK = 2;
export const MAX_LEVEL = 3;

export const newRecord = () => ({ level: 1, streak: 0, runs: 0, acc: null });

export const isClean = ({ accuracy, hints, skipped }) => !skipped && hints === 0 && accuracy >= CLEAN_ACCURACY;

/** Apply one graded run. Returns { record, change } with change in {-1, 0, +1}. */
export function applyRun(rec, run) {
  const a = run.skipped ? 0 : run.accuracy;
  let { level, streak } = rec;
  let change = 0;
  if (run.skipped || run.accuracy < DEMOTE_ACCURACY) {
    if (level > 1) (level--, (change = -1));
    streak = 0;
  } else if (isClean(run)) {
    streak++;
    if (streak >= PROMOTE_STREAK && level < MAX_LEVEL) (level++, (streak = 0), (change = 1));
  } else {
    streak = 0;
  }
  const acc = rec.acc == null ? a : 0.6 * rec.acc + 0.4 * a; // recent accuracy
  return { record: { level, streak, runs: rec.runs + 1, acc }, change };
}

export const isMastered = (rec) => !!rec && rec.level === MAX_LEVEL && rec.streak >= PROMOTE_STREAK;

export const RAMP_WINDOW = 4;

/**
 * How many molecules of an ordered playlist are open: the first RAMP_WINDOW,
 * plus one more for every molecule that has reached level 2.
 */
export function unlockedCount(ids, mastery, window = RAMP_WINDOW) {
  const passed = ids.filter((id) => (mastery[id]?.level ?? 1) >= 2).length;
  return Math.min(ids.length, window + passed);
}

/** Higher = shown more. Weak and low-level molecules first; unseen ones enter easiest tier first. */
export function weight(rec, tier) {
  if (!rec || rec.runs === 0) return 3 / tier ** 2;
  if (isMastered(rec)) return 0.5;
  return (MAX_LEVEL + 1 - rec.level) * (1 + 2 * (1 - rec.acc));
}

/** Weighted random pick, never the same molecule twice in a row. rnd: () => [0,1). */
export function pick(molecules, mastery, lastId, rnd = Math.random) {
  const pool = molecules.length > 1 ? molecules.filter((m) => m.id !== lastId) : molecules;
  const weights = pool.map((m) => weight(mastery[m.id], m.tier));
  let r = rnd() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r < 0) return pool[i];
  }
  return pool[pool.length - 1];
}
