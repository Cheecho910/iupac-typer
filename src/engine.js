// Typing engine. Pure: every function returns a new state, no DOM, no clock.
//
// Stop-on-error: a wrong key does not advance and is charged to the fragment
// that owns the character being typed.

export const isPunct = (ch) => ch === '-' || ch === ',' || ch === ' ' || ch === '(' || ch === ')';

/** fragments: [{text}] in name order. */
export function createRun(fragments, { autoPunct = false } = {}) {
  const chars = [];
  fragments.forEach((f, frag) => {
    for (const ch of f.text) chars.push({ ch, frag });
  });
  const state = {
    chars,
    pos: 0,
    autoPunct,
    errors: fragments.map(() => 0), // per fragment
    correct: 0,
    wrong: 0,
    hints: 0,
    revealed: [], // fragment indices shown by a hint
    startedAt: null,
    endedAt: null,
  };
  return { ...state, pos: skipPunct(state, 0) };
}

const skipPunct = (s, pos) => {
  if (s.autoPunct) while (pos < s.chars.length && isPunct(s.chars[pos].ch)) pos++;
  return pos;
};

export const isDone = (s) => s.pos >= s.chars.length;

/** Index of the fragment being typed (or -1 when done). */
export const currentFragment = (s) => (isDone(s) ? -1 : s.chars[s.pos].frag);

/** Fragments whose last character lies in [from, to). */
function completedBetween(s, from, to) {
  const out = [];
  for (let i = from; i < to; i++) {
    if (i === s.chars.length - 1 || s.chars[i + 1].frag !== s.chars[i].frag) out.push(s.chars[i].frag);
  }
  return out;
}

/**
 * Feed one key. Returns { state, result, completed }.
 * result: 'ok' | 'error' | 'done' | 'ignored'. completed: fragment indices just finished.
 */
export function press(s, key, now) {
  const ignored = { state: s, result: 'ignored', completed: [] };
  if (isDone(s) || typeof key !== 'string' || key.length !== 1) return ignored;
  if (s.autoPunct && isPunct(key)) return ignored;

  const startedAt = s.startedAt ?? now;
  const target = s.chars[s.pos];
  if (key.toLowerCase() !== target.ch.toLowerCase()) {
    const errors = s.errors.slice();
    errors[target.frag]++;
    return { state: { ...s, startedAt, errors, wrong: s.wrong + 1 }, result: 'error', completed: [] };
  }
  const pos = skipPunct(s, s.pos + 1);
  const state = { ...s, startedAt, pos, correct: s.correct + 1 };
  const completed = completedBetween(s, s.pos, pos);
  if (isDone(state)) return { state: { ...state, endedAt: now }, result: 'done', completed };
  return { state, result: 'ok', completed };
}

/** Reveal the next not-yet-revealed fragment at or after the cursor. */
export function hint(s) {
  if (isDone(s)) return { state: s, revealed: -1 };
  const last = s.chars[s.chars.length - 1].frag;
  for (let f = currentFragment(s); f <= last; f++) {
    if (!s.revealed.includes(f)) {
      return { state: { ...s, hints: s.hints + 1, revealed: [...s.revealed, f] }, revealed: f };
    }
  }
  return { state: s, revealed: -1 };
}

// Running totals over many runs (the session row). Same definitions as stats().
export const emptyTally = () => ({ correct: 0, wrong: 0, ms: 0 });

export const addToTally = (t, st) => ({ correct: t.correct + st.correct, wrong: t.wrong + st.wrong, ms: t.ms + st.ms });

export function tallyStats(t) {
  const keys = t.correct + t.wrong;
  return {
    accuracy: keys ? t.correct / keys : 1,
    wpm: t.ms > 0 ? t.correct / 5 / (t.ms / 60000) : 0,
    ms: t.ms,
  };
}

/** Shift the clock forward (used when un-pausing). */
export const shiftClock = (s, ms) => (s.startedAt == null ? s : { ...s, startedAt: s.startedAt + ms });

export function stats(s, now) {
  const keys = s.correct + s.wrong;
  const ms = s.startedAt == null ? 0 : (s.endedAt ?? now) - s.startedAt;
  return {
    accuracy: keys ? s.correct / keys : 1,
    wpm: ms > 0 ? s.correct / 5 / (ms / 60000) : 0,
    ms,
    correct: s.correct,
    wrong: s.wrong,
    hints: s.hints,
    errors: s.errors,
  };
}
