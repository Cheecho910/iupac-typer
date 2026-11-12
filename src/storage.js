// localStorage persistence. Storage can be missing or throw (private mode,
// sandboxed frames), so every access is guarded and the game runs without it.

const KEY = 'iupac-typer:v1';

const zero = () => ({ runs: 0, correct: 0, wrong: 0, ms: 0 });

export const defaults = () => ({
  settings: {
    autoPunct: false, // type hyphens/commas/spaces/parentheses yourself
    commonInL3: false, // common name hidden in L3 until finished
    showName: false, // copy-along practice, ungraded
    locants: true,
    badges: true,
    style: 'ball', // ball | space | wire
    keyboard: true, // on-screen keyboard under the name
    playlist: 'foundations',
    ramp: true, // unlock a playlist's molecules in order
  },
  pins: {}, // groupId -> hex: explicit user colors
  mastery: {}, // moleculeId -> { level, streak, runs, acc }
  stats: { graded: zero(), practice: zero(), fragErrors: {}, sprintBest: 0 },
});

export function load() {
  const base = defaults();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    return {
      settings: { ...base.settings, ...saved.settings },
      pins: { ...saved.pins },
      mastery: { ...saved.mastery },
      stats: { ...base.stats, ...saved.stats },
    };
  } catch {
    return base;
  }
}

export function save(store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* play on without persistence */
  }
}
