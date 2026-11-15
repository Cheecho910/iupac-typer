// App wiring: modes, global key capture, rendering. All game rules live in the
// pure modules (engine, mastery, color); this file only connects them to the DOM.

import data from '../public/molecules.json';
import registry from '../data/groups.json';
import { createRun, press, hint, stats, isDone, isPunct, shiftClock, emptyTally, addToTally, tallyStats } from './engine.js';
import { indexGroups, themed, presetPins, fragmentColor, groupColor, closePairs, ownColorIds, WARN_DELTA_E, VISIONS } from './color.js';
import { newRecord, applyRun, pick, isClean, isMastered, unlockedCount, RAMP_WINDOW } from './mastery.js';
import { load, save, defaults } from './storage.js';
import { createViewer } from './viewer.js';
import './style.css';

const MOLS = data.molecules;
const BY_ID = Object.fromEntries(MOLS.map((m) => [m.id, m]));
const PLAYLISTS = data.playlists;
const ALL_GROUPS = indexGroups(registry.groups);
const PRESETS = registry.presets ?? {};
const LEVELS = { 1: 'Copy', 2: 'Slots', 3: 'Recall' };
const SPRINT_MS = 60_000;
const MAX_COMBO = 5;
const NBSP = ' ';

const store = load();
const S = store.settings;
document.documentElement.dataset.theme = S.theme;
let GROUPS = themed(ALL_GROUPS, S.theme); // the registry with this theme's colors
const pins = () => store.pins[S.theme]; // the player's own colors for this theme

const $ = (sel) => document.querySelector(sel);
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  e.append(...kids.flat().filter((x) => x != null && x !== false));
  return e;
};
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const pct = (x) => `${Math.round(x * 100)}%`;
const clock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const now = () => performance.now();

// ---------------------------------------------------------------- state

let mode = 'title'; // title | zen | sprint | explore
let mol = null;
let run = null;
let level = 1;
let finished = false;
let practice = false; // Show name was on at some point in this run -> ungraded
let result = null; // { st, change } after a finished run
let panel = null; // menu | settings | sprint-end | null  (key capture is paused while set)
let pausedAt = null;
let sprint = null;
let advancing = 0; // timeout id while a sprint molecule hands over
let hot = null; // fragment under the pointer (name or atoms)
let charEls = [];
let tokEls = [];
let colors = []; // per fragment of the current molecule
let session = emptyTally(); // every keystroke since page load
let tallied = false; // current run already added to the session

const viewer = createViewer($('#viewer'), { background: css('--ink'), neutral: css('--muted'), text: css('--text') });

const fragColors = () => mol.fragments.map((f) => fragmentColor(f.groupIds, GROUPS, pins()));
const typing = () => mode !== 'explore' && !finished && !panel;
/** Atoms a token stands for: its own, or for a locant/descriptor the fragment it points at. */
const targetOf = (f) => {
  const frag = mol.fragments[f];
  return frag.target != null ? frag.target : frag.role === 'separator' ? null : f;
};

// ---------------------------------------------------------------- playlists

const playlist = () => PLAYLISTS.find((p) => p.id === S.playlist) ?? PLAYLISTS[0];
const playlistMols = () => playlist().molecules.map((id) => BY_ID[id]);
const openCount = () => (S.ramp ? unlockedCount(playlist().molecules, store.mastery) : playlist().molecules.length);
/** What the picker draws from: the open part of the active playlist. */
const pool = () => playlistMols().slice(0, openCount());

// ---------------------------------------------------------------- molecule lifecycle

function startMolecule(m) {
  clearTimeout(advancing);
  advancing = 0;
  if (run && !tallied && run.startedAt != null) session = addToTally(session, stats(run, now())); // abandoned run
  tallied = false;
  mol = m;
  level = mode === 'explore' ? 0 : mode === 'title' ? 1 : (store.mastery[m.id]?.level ?? 1);
  run = createRun(m.fragments, { autoPunct: S.autoPunct });
  finished = false;
  practice = S.showName;
  result = null;
  hot = null;
  colors = fragColors();
  viewer.load(m, colors);
  if (mode === 'title') $('#toast').hidden = true;
  $('#viewer').dataset.mol = m.id; // for end-to-end tests
  buildName();
  render();
}

const next = () => startMolecule(pick(pool(), store.mastery, mol?.id));

function record(st, skipped) {
  const bucket = practice ? store.stats.practice : store.stats.graded;
  bucket.runs++;
  bucket.correct += st.correct;
  bucket.wrong += st.wrong;
  bucket.ms += st.ms;
  st.errors.forEach((n, i) => {
    const key = mol.fragments[i].text;
    if (n) store.stats.fragErrors[key] = (store.stats.fragErrors[key] ?? 0) + n;
  });
  let change = 0;
  if (!practice) {
    const out = applyRun(store.mastery[mol.id] ?? newRecord(), { accuracy: st.accuracy, hints: st.hints, skipped });
    store.mastery[mol.id] = out.record;
    change = out.change;
  }
  save(store);
  return change;
}

function finish(skipped) {
  const st = stats(run, now());
  session = addToTally(session, st);
  tallied = true;
  const openBefore = openCount();
  const change = record(st, skipped);
  const unlocked = openCount() > openBefore;
  if (mode === 'sprint' && sprint) {
    const clean = isClean({ accuracy: st.accuracy, hints: st.hints, skipped });
    sprint.combo = clean ? sprint.combo + 1 : 0;
    sprint.maxCombo = Math.max(sprint.maxCombo, sprint.combo);
    sprint.correct += st.correct;
    sprint.wrong += st.wrong;
    st.errors.forEach((n, i) => n && sprint.frag.set(mol.fragments[i].text, (sprint.frag.get(mol.fragments[i].text) ?? 0) + n));
    if (!skipped) {
      sprint.cleared++;
      sprint.score += mol.name.length * Math.max(1, Math.min(sprint.combo, MAX_COMBO));
    }
  }
  if (skipped) return next();
  finished = true;
  result = { st, change, unlocked };
  st.errors.forEach((n, f) => n && (tokEls[f].dataset.miss = n)); // which fragments cost you
  const rec = store.mastery[mol.id];
  if (!practice && (change || (isMastered(rec) && rec.streak === 2))) {
    const text = change > 0 ? `Level ${rec.level} · ${LEVELS[rec.level]}` : change < 0 ? `Back to level ${rec.level}` : 'Mastered';
    toast(text, change < 0 ? 'down' : 'up');
    if (change >= 0) mol.fragments.forEach((f, i) => f.atoms.length && viewer.pulse(i));
  }
  if (mode === 'sprint') advancing = setTimeout(next, 340); // let the last pulse land
  render();
}

// ---------------------------------------------------------------- typing

function handleChar(key) {
  if (!typing() || advancing) return;
  const t = now();
  if (mode === 'sprint' && sprint && sprint.endsAt == null) sprint.endsAt = t + SPRINT_MS;
  const r = press(run, key, t);
  run = r.state;
  if (r.result !== 'ignored') flashKey(key, r.result === 'error');
  if (r.result === 'error') flashError();
  celebrate(r.completed);
  if (r.result === 'done') finish(false);
  else render();
}

/** A fragment was just completed: its atoms pulse and its token pops. */
function celebrate(completed) {
  for (const f of completed) {
    if (mol.fragments[f].atoms.length) viewer.pulse(f);
    const tok = tokEls[f];
    tok.classList.remove('pop');
    void tok.offsetWidth; // restart the animation
    tok.classList.add('pop');
  }
}

function doHint() {
  // Nothing to reveal in Copy level, and Show name disables hints (and their penalty).
  if (!typing() || level === 1 || S.showName) return;
  run = hint(run).state;
  render();
}

let toastTimer = 0;
function toast(text, kind) {
  const el = $('#toast');
  el.className = kind;
  el.textContent = text;
  el.hidden = false;
  void el.offsetWidth; // restart the animation
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 1700);
}

function flashError() {
  const el = $('#name');
  el.classList.remove('err');
  void el.offsetWidth;
  el.classList.add('err');
}

/** One entry point for physical and on-screen keys. Returns true if the key was used. */
function handleKey(key) {
  if (mode === 'title') {
    if (key === 'Enter' || key.length === 1) setMode('zen'); // any typing key starts; the key itself is not counted
    return key !== 'Tab';
  }
  if (key === 'Escape') return (panel ? closePanel() : openPanel('menu'), true);
  if (panel === 'sprint-end' && key === 'Enter') return (setMode('sprint'), true);
  if (panel || mode === 'explore') return false;
  if (key === 'Tab') return (doHint(), true);
  if (key === 'Enter') {
    if (!advancing) finished ? next() : finish(true);
    return true;
  }
  if (key.length === 1) return (handleChar(key), true); // also keeps Space from scrolling
  return false;
}

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  // A focused form control owns its keys (arrows/Enter/Esc in the playlist
  // dropdown). Exception: typing a character while the playlist picker still
  // has focus means the player went back to the game.
  const control = e.target.closest?.('select, input, textarea');
  if (control) {
    if (control.id !== 'playlist' || e.key.length !== 1) return;
    control.blur();
  }
  if (handleKey(e.key)) e.preventDefault();
});

// ---------------------------------------------------------------- on-screen keyboard

const KEY_ROWS = ['1234567890-', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm,()'];
const keyEls = {};

function buildKeyboard() {
  const key = (k, label, cls = '') => {
    const el = h('button', { type: 'button', class: `key ${cls}`, 'data-k': k, tabindex: '-1' }, label);
    // pointerdown, not click: no focus change, no 300 ms delay on touch
    el.addEventListener('pointerdown', (e) => (e.preventDefault(), handleKey(k)));
    keyEls[k.toLowerCase()] = el;
    return el;
  };
  $('#keyboard').replaceChildren(
    ...KEY_ROWS.map((row) => h('div', { class: 'krow' }, [...row].map((c) => key(c, c)))),
    h('div', { class: 'krow' },
      key('Escape', 'esc · menu', 'wide'), key('Tab', 'tab · hint', 'wide'),
      key(' ', 'space', 'space'), key('Enter', 'enter · skip', 'wide')),
  );
}

function flashKey(k, bad) {
  const el = keyEls[k.toLowerCase()];
  if (!el) return;
  el.classList.remove('down', 'bad');
  void el.offsetWidth;
  el.classList.add(bad ? 'bad' : 'down');
}

function renderKeyboard() {
  const kb = $('#keyboard');
  kb.hidden = !S.keyboard || mode === 'explore' || mode === 'title';
  $('#keys').hidden = !kb.hidden;
  if (kb.hidden) return;
  // Light the next key only when that character is on screen anyway;
  // in Slots and Recall the keyboard must not give the answer away.
  let nextKey = null;
  let color = '';
  if (typing() && !isDone(run)) {
    const c = run.chars[run.pos];
    const visible = level === 1 || S.showName || run.revealed.includes(c.frag) || (level === 2 && isPunct(c.ch));
    if (visible) (nextKey = c.ch.toLowerCase()), (color = colors[c.frag] ?? css('--text'));
  }
  for (const [k, el] of Object.entries(keyEls)) {
    el.classList.toggle('next', k === nextKey);
    el.style.setProperty('--kc', k === nextKey ? color : '');
  }
  keyEls.tab.disabled = finished || level === 1 || S.showName;
  keyEls.enter.textContent = finished ? 'enter · next' : 'enter · skip';
}

// ---------------------------------------------------------------- name line

function buildName() {
  const el = $('#name');
  el.textContent = '';
  el.setAttribute('aria-label', mode === 'explore' ? mol.name : 'IUPAC name to type');
  charEls = [];
  tokEls = mol.fragments.map((f, fi) => {
    const tok = h('span', { class: 'tok', 'data-f': fi });
    for (const _ of f.text) {
      const c = h('span', { class: 'ch' });
      charEls.push(c);
      tok.append(c);
    }
    el.append(tok);
    return tok;
  });
  paintName();
  fitName();
}

function paintName() {
  tokEls.forEach((tok, fi) => (tok.style.color = colors[fi] ?? css('--muted')));
}

/** Shrink the type so the whole name fits on one line (down to 14 px, then it wraps). */
function fitName() {
  if (!mol) return;
  const el = $('#name');
  const base = Math.min(46, Math.max(20, window.innerWidth * 0.035));
  el.style.fontSize = `${base}px`;
  const probe = h('span', { class: 'ch done' }, '0');
  el.append(probe);
  const perChar = probe.getBoundingClientRect().width || base * 0.62;
  probe.remove();
  const avail = el.parentElement.clientWidth - 48;
  const fit = Math.floor((avail / (mol.name.length * perChar)) * base);
  el.style.fontSize = `${Math.max(14, Math.min(base, fit))}px`;
}

function renderName() {
  const showAll = mode === 'explore' || finished || level === 1 || S.showName;
  run.chars.forEach((c, i) => {
    const typed = i < run.pos || mode === 'explore';
    const cur = i === run.pos && typing();
    const visible = showAll || run.revealed.includes(c.frag);
    let cls;
    let txt = c.ch === ' ' ? NBSP : c.ch;
    if (typed) cls = 'done';
    else if (visible || (level === 2 && isPunct(c.ch))) cls = 'ghost';
    else if (level === 2) (cls = 'slot'), (txt = NBSP);
    else (cls = cur ? 'caret' : 'hidden'), (txt = NBSP);
    const el = charEls[i];
    const name = `ch ${cls}${cur ? ' cur' : ''}`;
    if (el.className !== name) el.className = name;
    if (el.textContent !== txt) el.textContent = txt;
  });
  const hotTarget = hot;
  tokEls.forEach((tok, fi) => tok.classList.toggle('hot', hotTarget != null && targetOf(fi) === hotTarget));
}

function setHot(f) {
  if (f === hot) return;
  hot = f;
  viewer.highlight(f);
  renderName();
}
$('#name').addEventListener('mouseover', (e) => {
  const tok = e.target.closest('.tok');
  setHot(tok ? targetOf(+tok.dataset.f) : null);
});
$('#name').addEventListener('mouseleave', () => setHot(null));
viewer.onHover(setHot);

// ---------------------------------------------------------------- HUD

function renderHud() {
  const hud = $('#hud');
  hud.textContent = '';
  const chip = $('#level');
  const rec = store.mastery[mol.id];
  chip.classList.toggle('practice', mode !== 'explore' && S.showName);

  if (mode === 'explore') {
    chip.replaceChildren(rec ? `Level ${rec.level} · ${LEVELS[rec.level]}${isMastered(rec) ? ' · mastered' : ''}` : 'Not played yet');
    hud.append(h('span', { class: 'note' }, 'Hover a part of the name or an atom to see what it stands for.'));
    $('#keys').textContent = '';
    return;
  }

  // level as three pips, clean-run streak as two ticks: two clean runs promote
  const streak = store.mastery[mol.id]?.streak ?? 0;
  const lv = store.mastery[mol.id]?.level ?? 1;
  chip.replaceChildren(...(S.showName
    ? ['Practice · not graded']
    : [
        h('span', { class: 'pips', title: `Level ${lv} of 3` }, [1, 2, 3].map((n) => h('i', { class: n <= lv ? 'on' : '' }))),
        `Level ${level} · ${LEVELS[level]}`,
        h('span', { class: 'ticks', title: `${Math.min(streak, 2)} of 2 clean runs toward the next level` },
          [1, 2].map((n) => h('i', { class: n <= streak ? 'on' : '' })), ' clean'),
      ]));
  const st = result?.st ?? stats(run, now());
  const stat = (label, value) => h('span', { class: 'stat' }, h('b', {}, value), ` ${label}`);
  hud.append(stat('accuracy', pct(st.accuracy)), stat('wpm', String(Math.round(st.wpm))), stat('time', clock(st.ms)));
  if (st.hints) hud.append(stat(st.hints === 1 ? 'hint' : 'hints', String(st.hints)));

  if (finished && result) {
    const { change } = result;
    const clean = isClean({ accuracy: st.accuracy, hints: st.hints, skipped: false });
    let verdict = practice
      ? 'Practice run, not graded'
      : change > 0
        ? `Promoted to level ${store.mastery[mol.id].level} · ${LEVELS[store.mastery[mol.id].level]}`
        : change < 0
          ? `Back to level ${store.mastery[mol.id].level} · ${LEVELS[store.mastery[mol.id].level]}`
          : clean
            ? isMastered(store.mastery[mol.id]) ? 'Clean. Mastered.' : level === 3 ? 'Clean' : 'Clean. One more to level up.'
            : st.accuracy < 0.95 ? 'Under 95%, streak reset' : 'Hint used, streak reset';
    if (result.unlocked) verdict += ' · new molecule unlocked';
    hud.append(h('span', { class: `verdict ${change > 0 ? 'up' : change < 0 ? 'down' : ''}` }, verdict));
    if (mode === 'zen') hud.append(h('button', { type: 'button', class: 'next', onclick: next }, 'Next ', h('kbd', {}, 'Enter')));
  }

  $('#keys').replaceChildren(
    ...(finished
      ? []
      : [
          level > 1 && !S.showName ? h('span', {}, h('kbd', {}, 'Tab'), ' hint') : null,
          h('span', {}, h('kbd', {}, 'Enter'), ' skip'),
          h('span', {}, h('kbd', {}, 'Esc'), ' menu'),
        ].filter(Boolean)),
  );
}

/** Color key: every group color; the ones in this molecule are lit. */
function renderLegend() {
  const el = $('#legend');
  el.hidden = !S.legend || mode === 'title';
  if (el.hidden) return;
  const own = (id) => ALL_GROUPS[id].alias ?? id;
  const present = new Set(mol.fragments.filter((f) => f.atoms?.length).flatMap((f) => f.groupIds.map(own)));
  el.replaceChildren(...ownColorIds(GROUPS).map((id) =>
    h('li', { class: present.has(id) ? 'on' : '' }, h('i', { style: `background:${groupColor(id, GROUPS, pins())}` }), GROUPS[id].name)));
}

/** Second HUD row: everything typed since the page loaded, live. */
function renderSession() {
  const el = $('#session');
  el.hidden = mode !== 'zen' || !finished; // between molecules only; always in the pause menu
  if (el.hidden) return;
  const t = tallied || !run ? session : addToTally(session, stats(run, now()));
  const st = tallyStats(t);
  el.replaceChildren(
    h('span', { class: 'label' }, 'session'),
    h('span', {}, h('b', {}, pct(st.accuracy)), ' accuracy'),
    h('span', {}, h('b', {}, String(Math.round(st.wpm))), ' wpm'),
    h('span', {}, h('b', {}, clock(st.ms)), ' time'),
  );
}

function renderCommon() {
  const show = mol.commonName && (mode === 'explore' || level < 3 || finished || S.commonInL3 || S.showName);
  $('#common').replaceChildren(...(show ? [h('span', {}, 'also called'), ` ${mol.commonName}`] : []));
}

function renderSprint() {
  const on = mode === 'sprint' && sprint;
  $('#sprint-bar').hidden = !on;
  $('#sprint-hud').hidden = !on;
  if (!on) return;
  const left = sprint.endsAt == null ? SPRINT_MS : Math.max(0, sprint.endsAt - (pausedAt ?? now()));
  $('#sprint-bar i').style.transform = `scaleX(${left / SPRINT_MS})`;
  $('#sprint-hud').replaceChildren(
    h('b', {}, String(sprint.score)),
    ' pts',
    ...(sprint.combo > 1 ? [h('span', { class: 'combo' }, `×${Math.min(sprint.combo, MAX_COMBO)}`)] : []),
    h('span', { class: 'left' }, sprint.endsAt == null ? 'type to start · 60 s' : `${Math.ceil(left / 1000)} s`),
  );
}

// ---------------------------------------------------------------- title screen
// Attract mode: the game plays itself (a name types out, atoms pulse) above
// the playlist cards. Nothing typed here is recorded.

let demoTimer = 0;

function startDemo() {
  const options = MOLS.filter((m) => m !== mol && m.fragments.length >= 3 && m.name.length <= 30);
  startMolecule(options[Math.floor(Math.random() * options.length)]);
  tallied = true; // never counts toward the session
}

function demoStep() {
  if (mode !== 'title' || finished) return;
  const r = press(run, run.chars[run.pos].ch, now());
  run = r.state;
  celebrate(r.completed);
  if (r.result === 'done') {
    finished = true;
    setTimeout(() => mode === 'title' && startDemo(), 1700);
  }
  renderName();
}

function renderTitle() {
  const box = $('#title-menu');
  box.hidden = mode !== 'title';
  if (box.hidden) return;
  const total = MOLS.length;
  const mastered = MOLS.filter((m) => isMastered(store.mastery[m.id])).length;
  box.replaceChildren(
    h('div', { class: 'tcards' }, PLAYLISTS.map((p, i) => {
      const passed = p.molecules.filter((id) => (store.mastery[id]?.level ?? 1) >= 2).length;
      return h('button', {
        type: 'button', class: 'tcard', 'aria-pressed': String(p.id === playlist().id),
        onclick: () => ((S.playlist = p.id), save(store), ($('#playlist').value = p.id), setMode('zen')),
      },
        h('span', { class: 'num' }, String(i + 1).padStart(2, '0')),
        h('b', {}, p.name),
        h('span', { class: 'meta' }, `${p.molecules.length} molecules${passed ? ` · ${passed} past Copy` : ''}`),
        h('i', { class: 'bar-fill', style: `--p:${(passed / p.molecules.length) * 100}%` }));
    })),
    h('div', { class: 'row tactions' },
      h('button', { type: 'button', class: 'primary', onclick: () => setMode('zen') }, `Play ${playlist().name} `, h('kbd', {}, 'Enter')),
      h('button', { type: 'button', onclick: () => setMode('sprint') }, 'Sprint · 60 s'),
      h('button', { type: 'button', onclick: () => setMode('explore') }, 'Explore'),
      h('span', { class: 'note' }, `${mastered} of ${total} mastered`)),
  );
}

function render() {
  renderTitle();
  renderName();
  renderHud();
  renderSession();
  renderCommon();
  renderSprint();
  renderKeyboard();
  renderLegend();
}

setInterval(() => {
  if (panel || !mol) return;
  if (mode === 'sprint' && sprint?.endsAt != null && now() >= sprint.endsAt) return endSprint();
  if (mode !== 'explore' && !finished && run.startedAt != null) (renderHud(), renderSession(), renderSprint());
}, 100);

// ---------------------------------------------------------------- modes

function setMode(m) {
  closePanel(true);
  clearInterval(demoTimer);
  mode = m;
  sprint = m === 'sprint' ? { endsAt: null, score: 0, combo: 0, maxCombo: 0, cleared: 0, correct: 0, wrong: 0, frag: new Map() } : null;
  for (const b of $('#modes').children) b.setAttribute('aria-pressed', String(b.dataset.mode === m));
  $('#explore-list').hidden = m !== 'explore';
  document.body.dataset.mode = m;
  if (m === 'title') (startDemo(), (demoTimer = setInterval(demoStep, 115)));
  else if (m === 'explore') startMolecule(mol && playlist().molecules.includes(mol.id) ? mol : playlistMols()[0]);
  else next();
  renderExploreList();
  viewer.resize();
  fitName();
}

function endSprint() {
  clearTimeout(advancing);
  advancing = 0;
  const st = stats(run, now()); // the unfinished molecule still counts toward accuracy/WPM
  if (!finished) (sprint.correct += st.correct), (sprint.wrong += st.wrong);
  const keys = sprint.correct + sprint.wrong;
  const best = Math.max(store.stats.sprintBest, practice ? 0 : sprint.score);
  const isBest = !practice && sprint.score > store.stats.sprintBest && sprint.score > 0;
  store.stats.sprintBest = best;
  save(store);
  const worst = [...sprint.frag.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  openPanel('sprint-end', [
    h('p', { class: 'eyebrow' }, 'Sprint · 60 seconds'),
    h('h2', { class: 'big' }, String(sprint.score), h('small', {}, isBest ? ' new best' : ` best ${best}`)),
    h('div', { class: 'grid' },
      tile('molecules', String(sprint.cleared)),
      tile('accuracy', keys ? pct(sprint.correct / keys) : '–'),
      tile('wpm', String(Math.round(sprint.correct / 5 / (SPRINT_MS / 60000)))),
      tile('best combo', `×${Math.min(Math.max(sprint.maxCombo, 1), MAX_COMBO)}`),
    ),
    worstList(worst, 'Worst fragments this sprint'),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'primary', onclick: () => setMode('sprint') }, 'Again ', h('kbd', {}, 'Enter')),
      h('button', { type: 'button', onclick: () => setMode('zen') }, 'Zen'),
    ),
  ]);
}

const tile = (label, value) => h('div', { class: 'tile' }, h('b', {}, value), h('span', {}, label));

function worstList(entries, title) {
  if (!entries.length) return h('p', { class: 'note' }, 'No fragment errors.');
  const colorOf = (text) => {
    for (const m of MOLS) {
      const f = m.fragments.find((x) => x.text === text);
      if (f) return fragmentColor(f.groupIds, GROUPS, pins()) ?? css('--muted');
    }
    return css('--muted');
  };
  return h('div', { class: 'worst' },
    h('h3', {}, title),
    h('ol', {}, entries.map(([text, n]) =>
      h('li', {}, h('code', { style: `color:${colorOf(text)}` }, text === ' ' ? '␣' : text), h('span', {}, `${n} ${n === 1 ? 'error' : 'errors'}`)))),
  );
}

let exploreQuery = '';
const matches = (m) => !exploreQuery || `${m.name} ${m.commonName}`.toLowerCase().includes(exploreQuery);

function renderExploreItems() {
  const open = openCount();
  const items = playlistMols().map((m, i) => [m, i]).filter(([m]) => matches(m));
  $('#explore-items').replaceChildren(
    ...(items.length ? [] : [h('p', { class: 'note' }, 'No molecule in this playlist matches.')]),
    ...items.map(([m, i]) => {
      const rec = store.mastery[m.id];
      const locked = i >= open;
      return h('button', {
        type: 'button', class: locked ? 'locked' : '', 'aria-current': m === mol ? 'true' : null,
        title: locked ? 'Not in the Zen/Sprint pool yet. Opens as earlier molecules reach level 2.' : null,
        onclick: () => (startMolecule(m), renderExploreItems()),
      }, h('span', {}, m.name), h('i', { class: `lv lv${rec?.level ?? 0}${isMastered(rec) ? ' m' : ''}`, title: rec ? `Level ${rec.level}` : 'Not played' }));
    }),
  );
}

function renderExploreList() {
  const list = $('#explore-list');
  if (list.hidden) return;
  const p = playlist();
  const open = openCount();
  const passed = p.molecules.filter((id) => (store.mastery[id]?.level ?? 1) >= 2).length;
  const mastered = p.molecules.filter((id) => isMastered(store.mastery[id])).length;
  list.replaceChildren(
    h('header', {},
      h('h2', {}, p.name),
      h('p', {}, p.description),
      h('p', { class: 'progress' }, `${passed} of ${p.molecules.length} past Copy · ${mastered} mastered${S.ramp && open < p.molecules.length ? ` · ${open} open` : ''}`)),
    h('input', {
      type: 'search', id: 'explore-search', placeholder: 'Search this playlist', 'aria-label': 'Search this playlist', value: exploreQuery,
      oninput: (ev) => ((exploreQuery = ev.target.value.trim().toLowerCase()), renderExploreItems()),
    }),
    h('div', { id: 'explore-items' }),
  );
  renderExploreItems();
}

function setPlaylist(id) {
  exploreQuery = '';
  S.playlist = id;
  save(store);
  $('#playlist').value = id;
  $('#playlist').blur();
  if (mode === 'explore') startMolecule(playlistMols()[0]);
  else if (mode === 'sprint') setMode('sprint');
  else next();
  renderExploreList();
}

// ---------------------------------------------------------------- panels (pause key capture + clocks)

function openPanel(name, content) {
  if (!panel) pausedAt = now();
  panel = name;
  $('#btn-settings').setAttribute('aria-pressed', String(name === 'settings'));
  $('#settings').hidden = name !== 'settings';
  $('#overlay').hidden = name === 'settings';
  if (name === 'menu') content = menuContent();
  if (name === 'settings') renderSettings();
  else ($('#card').replaceChildren(...content), $('#card').querySelector('button')?.focus());
  viewer.resize();
  fitName();
  render();
}

function closePanel(silent) {
  if (!panel) return;
  const was = panel;
  panel = null;
  $('#overlay').hidden = true;
  $('#settings').hidden = true;
  $('#btn-settings').setAttribute('aria-pressed', 'false');
  const dt = now() - pausedAt;
  pausedAt = null;
  if (run) run = shiftClock(run, dt);
  if (sprint?.endsAt != null) sprint.endsAt += dt;
  document.activeElement?.blur();
  viewer.resize();
  fitName();
  if (was === 'sprint-end' && !silent) return setMode('sprint');
  if (!silent) render();
}

function menuContent() {
  const g = store.stats.graded, p = store.stats.practice;
  const line = (b) => (b.runs && b.correct + b.wrong ? `${b === g || b === p ? `${b.runs} runs · ` : ''}${pct(b.correct / Math.max(1, b.correct + b.wrong))} · ${Math.round(b.correct / 5 / Math.max(b.ms / 60000, 1e-9))} wpm` : 'no runs yet');
  const lv = [0, 0, 0, 0, 0];
  for (const m of MOLS) {
    const rec = store.mastery[m.id];
    lv[isMastered(rec) ? 4 : (rec?.level ?? 0)]++;
  }
  const worst = Object.entries(store.stats.fragErrors).sort((a, b) => b[1] - a[1]).slice(0, 5);
  return [
    h('p', { class: 'eyebrow' }, 'Paused'),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'primary', onclick: () => closePanel() }, 'Resume ', h('kbd', {}, 'Esc')),
      h('button', { type: 'button', onclick: () => setMode('zen') }, 'Zen'),
      h('button', { type: 'button', onclick: () => setMode('sprint') }, 'Sprint'),
      h('button', { type: 'button', onclick: () => setMode('explore') }, 'Explore'),
      h('button', { type: 'button', onclick: () => (closePanel(true), openPanel('settings')) }, 'Settings'),
      h('button', { type: 'button', onclick: () => setMode('title') }, 'Title screen'),
    ),
    h('dl', { class: 'facts' },
      h('dt', {}, 'Graded'), h('dd', {}, line(g)),
      h('dt', {}, 'Practice'), h('dd', {}, line(p)),
      h('dt', {}, 'Session'), h('dd', {}, line({ runs: 1, ...session })),
      h('dt', {}, 'Playlist'), h('dd', {}, `${playlist().name} · ${openCount()} of ${playlist().molecules.length} open`),
      h('dt', {}, 'All molecules'), h('dd', {}, `${lv[0]} new · ${lv[1]} copy · ${lv[2]} slots · ${lv[3]} recall · ${lv[4]} mastered`),
      h('dt', {}, 'Sprint best'), h('dd', {}, String(store.stats.sprintBest)),
    ),
    worstList(worst, 'Worst fragments, all time'),
  ];
}

// ---------------------------------------------------------------- settings

function applyTheme() {
  document.documentElement.dataset.theme = S.theme;
  GROUPS = themed(ALL_GROUPS, S.theme);
  viewer.setTheme({ background: css('--ink'), neutral: css('--muted'), text: css('--text') });
  colors = fragColors();
  viewer.setColors(colors);
  paintName();
  if (panel === 'settings') renderColorRows();
  render();
}

function applyPreset(key) {
  store.pins[S.theme] = key ? presetPins(PRESETS[key].colors, ALL_GROUPS, S.theme) : {};
  applyColors();
  renderColorRows();
  say(key ? `${PRESETS[key].name} palette applied. ${PRESETS[key].note}` : 'Back to the element-convention palette.');
}

function applyColors() {
  save(store);
  colors = fragColors();
  viewer.setColors(colors);
  paintName();
  renderKeyboard();
}

function renderSettings() {
  const box = $('#settings');
  const check = (id, label, key, onchange) =>
    h('label', { class: 'check', for: id },
      h('input', { type: 'checkbox', id, checked: S[key], onchange: (e) => ((S[key] = e.target.checked), save(store), onchange?.(), render()) }),
      h('span', {}, label));

  box.replaceChildren(
    h('div', { class: 'set-head' }, h('h2', {}, 'Settings'), h('button', { type: 'button', onclick: () => closePanel() }, 'Close ', h('kbd', {}, 'Esc'))),
    h('h3', {}, 'Typing'),
    check('set-autopunct', 'Type hyphens, commas, spaces and parentheses for me', 'autoPunct', () => startMolecule(mol)),
    check('set-common', 'Show the common name during Recall (level 3)', 'commonInL3'),
    h('h3', {}, 'Molecule'),
    h('label', { class: 'pick', for: 'set-style' }, 'Draw atoms as ',
      h('select', { id: 'set-style', onchange: (e) => ((S.style = e.target.value), save(store), syncButtons()) },
        [['ball', 'ball and stick'], ['space', 'spacefill'], ['wire', 'wireframe']].map(([v, label]) =>
          h('option', { value: v, selected: S.style === v }, label)))),
    h('h3', {}, 'Motion'),
    check('set-wiggle', 'End groups spin and wag now and then (single bonds rotate)', 'wiggle', syncButtons),
    h('h3', {}, 'Playlists'),
    check('set-ramp', `Unlock a playlist in order: ${RAMP_WINDOW} molecules open, one more for each that reaches level 2`, 'ramp', () => renderExploreList()),
    h('h3', {}, 'Colors'),
    h('p', { class: 'note' }, `Oxygen groups are red, orange and pink; nitrogen is blue; halogens green; amide purple, as carbonyl plus amine. These are the ${S.theme}-theme colors; the molecule on the left updates as you pick.`),
    h('div', { class: 'row' },
      h('button', { type: 'button', onclick: () => applyPreset(null) }, 'Element colors'),
      ...Object.entries(PRESETS).map(([key, p]) => h('button', { type: 'button', onclick: () => applyPreset(key) }, p.name))),
    h('div', { id: 'color-rows' }),
    h('label', { class: 'pick', for: 'set-vision' }, 'Check distinctness for ',
      h('select', { id: 'set-vision', onchange: renderWarnings }, VISIONS.map((v) =>
        h('option', { value: v }, { normal: 'typical vision', protan: 'protanopia', deutan: 'deuteranopia', tritan: 'tritanopia' }[v])))),
    h('div', { id: 'color-warn' }),
    h('div', { class: 'row' },
      h('button', { type: 'button', onclick: () => (($('#set-json').value = JSON.stringify({ version: 1, pins: pins() }, null, 1)), say('Palette written to the box.')) }, 'Export'),
      h('button', { type: 'button', onclick: copyPalette }, 'Copy'),
      h('button', { type: 'button', onclick: importPalette }, 'Import'),
    ),
    h('textarea', { id: 'set-json', rows: 4, spellcheck: 'false', 'aria-label': 'Palette JSON', placeholder: 'Export writes palette JSON here. To import, paste JSON and press Import.' }),
    h('p', { id: 'set-msg', class: 'note', role: 'status' }),
    h('h3', {}, 'Progress'),
    h('button', { type: 'button', id: 'set-reset', onclick: resetProgress }, 'Reset levels and stats'),
  );
  renderColorRows();
}

const say = (msg) => ($('#set-msg').textContent = msg);

function renderColorRows() {
  $('#color-rows').replaceChildren(
    ...ownColorIds(GROUPS).map((gid) => {
      const g = GROUPS[gid];
      const id = `color-${g.id}`;
      const pinned = pins()[g.id] != null;
      return h('div', { class: 'crow', 'data-id': g.id },
        h('input', {
          type: 'color', id, value: groupColor(g.id, GROUPS, pins()),
          oninput: (e) => ((pins()[g.id] = e.target.value), applyColors(), syncColorRows()),
        }),
        h('label', { for: id }, g.name, g.recipe ? h('small', {}, ` ${g.recipe.map((r) => GROUPS[r].name.toLowerCase()).join(' + ')}`) : null),
        h('button', {
          type: 'button', class: 'unpin', hidden: !pinned, 'aria-label': `Reset ${g.name}`,
          onclick: () => (delete pins()[g.id], applyColors(), renderColorRows()),
        }, 'reset'),
      );
    }),
  );
  renderWarnings();
}

/** Refresh values in place (keeps the picker being dragged alive). */
function syncColorRows() {
  for (const row of $('#color-rows').children) {
    const id = row.dataset.id;
    const input = row.querySelector('input');
    const value = groupColor(id, GROUPS, pins());
    if (input.value !== value && document.activeElement !== input) input.value = value;
    row.querySelector('.unpin').hidden = pins()[id] == null;
  }
  renderWarnings();
}

function renderWarnings() {
  const vision = $('#set-vision')?.value ?? 'normal';
  const pairs = closePairs(GROUPS, pins(), WARN_DELTA_E, vision);
  const flagged = new Set(pairs.flatMap((p) => [p.a, p.b]));
  for (const row of $('#color-rows').children) row.classList.toggle('warn', flagged.has(row.dataset.id));
  $('#color-warn').replaceChildren(
    pairs.length
      ? h('ul', { class: 'warnlist' }, pairs.slice(0, 8).map((p) =>
          h('li', {}, `${GROUPS[p.a].name} and ${GROUPS[p.b].name} are hard to tell apart (ΔE ${p.dE.toFixed(1)}, want ${WARN_DELTA_E}+)`)),
          pairs.length > 8 ? h('li', {}, `and ${pairs.length - 8} more pairs`) : null)
      : h('p', { class: 'ok' }, `All ${ownColorIds(GROUPS).length} colors are distinct (ΔE ${WARN_DELTA_E}+).`),
  );
}

async function copyPalette() {
  const text = JSON.stringify({ version: 1, pins: pins() }, null, 1);
  $('#set-json').value = text;
  try {
    await navigator.clipboard.writeText(text);
    say('Copied.');
  } catch {
    $('#set-json').select();
    say('Copy is blocked here. The JSON is selected in the box; press Ctrl/Cmd+C.');
  }
}

function importPalette() {
  try {
    const { pins: imported } = JSON.parse($('#set-json').value);
    if (!imported || typeof imported !== 'object') throw new Error('expected {"pins": {...}}');
    for (const [id, hex] of Object.entries(imported)) {
      if (!GROUPS[id]) throw new Error(`unknown group "${id}"`);
      if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`"${hex}" is not a #rrggbb color`);
    }
    store.pins[S.theme] = Object.fromEntries(Object.entries(imported).map(([k, v]) => [k, v.toLowerCase()]));
    applyColors();
    renderColorRows();
    say(`Imported ${Object.keys(imported).length} colors.`);
  } catch (err) {
    say(`Could not import: ${err.message}. Paste the JSON that Export produced.`);
  }
}

let resetArmed = 0;
function resetProgress() {
  const btn = $('#set-reset');
  if (!resetArmed) {
    btn.textContent = 'Press again to erase all progress';
    resetArmed = setTimeout(() => ((resetArmed = 0), (btn.textContent = 'Reset levels and stats')), 4000);
    return;
  }
  clearTimeout(resetArmed);
  resetArmed = 0;
  store.mastery = {};
  store.stats = defaults().stats;
  save(store);
  btn.textContent = 'Reset levels and stats';
  say('Progress erased.');
  startMolecule(mol);
}

// ---------------------------------------------------------------- on-screen buttons

const pressed = (el, on) => el.setAttribute('aria-pressed', String(on));

function syncButtons() {
  pressed($('#btn-showname'), S.showName);
  pressed($('#btn-locants'), S.locants);
  pressed($('#btn-badges'), S.badges);
  pressed($('#btn-keyboard'), S.keyboard);
  pressed($('#btn-legend'), S.legend);
  pressed($('#btn-theme'), S.theme === 'light');
  viewer.setOptions({ style: S.style, locants: S.locants, badges: S.badges, wiggle: S.wiggle });
}

$('#brand').addEventListener('click', () => setMode('title'));
$('#modes').addEventListener('click', (e) => e.target.dataset.mode && setMode(e.target.dataset.mode));
$('#btn-legend').addEventListener('click', () => ((S.legend = !S.legend), save(store), syncButtons(), render()));
$('#btn-theme').addEventListener('click', () => ((S.theme = S.theme === 'light' ? 'dark' : 'light'), save(store), syncButtons(), applyTheme()));
$('#btn-locants').addEventListener('click', () => ((S.locants = !S.locants), save(store), syncButtons()));
$('#btn-badges').addEventListener('click', () => ((S.badges = !S.badges), save(store), syncButtons()));
$('#btn-keyboard').addEventListener('click', () => ((S.keyboard = !S.keyboard), save(store), syncButtons(), render(), viewer.resize()));
$('#playlist').append(...PLAYLISTS.map((p) => h('option', { value: p.id }, `${p.name} (${p.molecules.length})`)));
$('#playlist').value = playlist().id;
$('#playlist').addEventListener('change', (e) => setPlaylist(e.target.value));
$('#btn-showname').addEventListener('click', () => {
  S.showName = !S.showName;
  if (S.showName) practice = true; // this run can no longer be graded
  save(store);
  syncButtons();
  render();
});
$('#btn-settings').addEventListener('click', () => (panel === 'settings' ? closePanel() : (closePanel(true), openPanel('settings'))));
$('#overlay').addEventListener('click', (e) => e.target === e.currentTarget && panel === 'menu' && closePanel());
// Play-area buttons must not keep focus: typing owns the keyboard.
document.querySelector('.bar').addEventListener('click', (e) => {
  if (e.target.closest('.playlist')) return; // blurring a <select> on click closes its dropdown
  if (!panel) document.activeElement?.blur();
});
document.querySelector('.stage-tools').addEventListener('click', () => document.activeElement?.blur());
window.addEventListener('resize', () => (viewer.resize(), fitName()));
document.fonts?.ready.then(fitName);

window.iupacDebug = { wiggle: () => viewer.wiggleNow() }; // used by tests/e2e

buildKeyboard();
syncButtons();
setMode('title');
