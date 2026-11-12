// End-to-end check in a real browser: every on-screen control gets a REAL
// mouse click (never a programmatic value change), plus one typed run.
//   npm run e2e          (builds, serves dist/, drives Chromium)
// Locally without a Playwright browser: CHROME_PATH=/path/to/chrome npm run e2e
import { readFileSync } from 'node:fs';
import { preview } from 'vite';
import { chromium } from 'playwright';

const DATA = JSON.parse(readFileSync(new URL('../../public/molecules.json', import.meta.url)));
const MOLS = Object.fromEntries(DATA.molecules.map((m) => [m.id, m]));

const server = await preview({ preview: { port: 4174, strictPort: true } });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
let failed = 0;
page.on('pageerror', (e) => errors.push(e.message));
const ok = (cond, msg) => (console.log(cond ? 'PASS' : 'FAIL', msg), cond || failed++);
const cur = async () => MOLS[await page.getAttribute('#viewer', 'data-mol')];
const focused = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
const pressed = (sel) => page.getAttribute(sel, 'aria-pressed');
const realClick = async (sel) => {
  await page.locator(sel).scrollIntoViewIfNeeded();
  const b = await page.locator(sel).boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(250);
};
const typeName = async (m) => {
  for (const ch of m.name) await page.keyboard.press(ch === ' ' ? 'Space' : ch);
};

await page.goto('http://localhost:4174/');
await page.waitForTimeout(800);

// typing: wrong key does not advance, clean name finishes
let m = await cur();
await page.keyboard.press('~');
ok((await page.locator('#name .ch.done').count()) === 0, 'wrong key does not advance');
await typeName(m);
await page.waitForTimeout(150);
ok((await page.innerText('#hud')).includes('Next'), `typed ${m.name} to the end`);
await page.keyboard.press('Enter');

// playlist dropdown: a real click must leave it open (regression: it used to be blurred shut)
await realClick('#playlist');
ok((await focused()) === 'playlist', 'playlist dropdown stays open on click');
await page.keyboard.press('ArrowDown');
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
ok((await page.inputValue('#playlist')) === DATA.playlists[1].id, 'choosing switches playlist');
ok(DATA.playlists[1].molecules.includes((await cur()).id), 'picker draws from the chosen playlist');
m = await cur();
await page.keyboard.press(m.name[0]);
ok((await page.locator('#name .ch.done').count()) === 1, 'typing works straight after choosing');
await realClick('#playlist');
await page.keyboard.press('Escape');
ok(!(await page.isVisible('#overlay')), 'Esc inside the dropdown does not open the menu');
await page.keyboard.press(m.name[1] === ' ' ? 'Space' : m.name[1]);
ok((await page.locator('#name .ch.done').count()) === 2, 'typing after dismissing the dropdown goes to the game');

// every button
for (const [sel, check, label] of [
  ['#modes [data-mode=sprint]', async () => (await pressed('#modes [data-mode=sprint]')) === 'true', 'Sprint'],
  ['#modes [data-mode=explore]', () => page.isVisible('#explore-list'), 'Explore'],
  ['#modes [data-mode=zen]', async () => !(await page.isVisible('#explore-list')), 'Zen'],
  ['#btn-showname', async () => (await pressed('#btn-showname')) === 'true', 'Show name on'],
  ['#btn-showname', async () => (await pressed('#btn-showname')) === 'false', 'Show name off'],
  ['[data-style=space]', async () => (await pressed('[data-style=space]')) === 'true', 'Spacefill'],
  ['[data-style=wire]', async () => (await pressed('[data-style=wire]')) === 'true', 'Wireframe'],
  ['[data-style=ball]', async () => (await pressed('[data-style=ball]')) === 'true', 'Ball and stick'],
  ['#btn-locants', async () => (await pressed('#btn-locants')) === 'false', 'Locants off'],
  ['#btn-locants', async () => (await pressed('#btn-locants')) === 'true', 'Locants on'],
  ['#btn-badges', async () => (await pressed('#btn-badges')) === 'false', 'Elements off'],
  ['#btn-badges', async () => (await pressed('#btn-badges')) === 'true', 'Elements on'],
  ['#btn-keyboard', async () => !(await page.isVisible('#keyboard')), 'Keyboard off'],
  ['#btn-keyboard', () => page.isVisible('#keyboard'), 'Keyboard on'],
  ['#btn-settings', () => page.isVisible('#settings'), 'Settings opens'],
]) {
  await realClick(sel);
  ok(await check(), `click: ${label}`);
}
await realClick('#set-ramp');
ok(!(await page.isChecked('#set-ramp')), 'click: unlock-in-order checkbox');
await realClick('#set-ramp');
await realClick('#set-vision');
ok((await focused()) === 'set-vision', 'click: vision dropdown stays open');
await page.keyboard.press('Escape');
await realClick('.set-head button');
ok(!(await page.isVisible('#settings')), 'click: Settings closes');

// on-screen keyboard and pause menu
m = await cur();
const before = await page.locator('#name .ch.done').count();
await realClick(`.key[data-k="${m.name[before] === ' ' ? ' ' : m.name[before].toLowerCase()}"]`);
ok((await page.locator('#name .ch.done').count()) === before + 1, 'click: on-screen key types');
await page.keyboard.press('Escape');
ok(await page.isVisible('#overlay'), 'Esc opens the pause menu');
await page.keyboard.press('Escape');
ok(!(await page.isVisible('#overlay')), 'Esc closes it');

ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
await browser.close();
await new Promise((r) => server.httpServer.close(r));
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
