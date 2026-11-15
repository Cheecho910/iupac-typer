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
    theme: 'dark', // dark | light
    legend: true, // color key beside the molecule
    wiggle: true, // end groups spin/wag now and then
    keyboard: true, // on-screen keyboard under the name
    playlist: 'foundations',
    ramp: true, // unlock a playlist's molecules in order
  },
  pins: { dark: {}, light: {} }, // per theme: groupId -> hex, explicit user colors
  mastery: {}, // moleculeId -> { level, streak, runs, acc }
  stats: { graded: zero(), practice: zero(), fragErrors: {}, sprintBest: 0 },
});

/** Before themes, pins were one flat {groupId: hex} map; those belonged to the dark theme. */
function migratePins(pins = {}) {
  const flat = Object.keys(pins).some((k) => k !== 'dark' && k !== 'light');
  return flat ? { dark: { ...pins }, light: {} } : { dark: { ...pins.dark }, light: { ...pins.light } };
}

export function load() {
  const base = defaults();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    return {
      settings: { ...base.settings, ...saved.settings },
      pins: migratePins(saved.pins),
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
