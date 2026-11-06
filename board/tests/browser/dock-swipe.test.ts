// The phone's dock while a 終端分頁 is open: a swipe left on the command line brings the 按鍵面板 in
// its place, a swipe right brings the line back. In a real browser with touch emulated, finger moves
// sent as touch events: the panel follows one to one, goes past a quarter of the width or a quick
// flick (the ticket's numbers, also pinned in unit/swipe), a mostly vertical drag does nothing, the box while it has the
// focus keeps its own drags, a swipe over the screen scrolls it and never switches, the dots show
// the panel that shows. `SCREEN_TAB_SHOTS` names a folder for screenshots.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { sleep, startFixture, type Fixture } from '../harness.ts';
import { launchChrome, type Browser, type Tab } from '../browser.ts';
/** The ticket's numbers, written here as they are: a quarter of the width, 0.3px/ms. */
const QUARTER = 0.25;
const FLICK = 0.3;

const SHOTS = process.env.SCREEN_TAB_SHOTS;
const PANE = 'wA:p-s-plain';
const WIDE = Array.from({ length: 50 }, (_, index) => `row ${index + 1} ${'x'.repeat(120)}`).join('\r\n');

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;

beforeAll(async () => {
	fixture = await startFixture({ env: { LAT_BOARD_HERDR_TIMEOUT_SECONDS: '2' } });
	cookie = await fixture.login('dock-swipe');
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', 's-plain.jsonl'), JSON.stringify({ kind: 'user', time: new Date().toISOString(), text: '跑一下單元測試' }) + '\n');
	fixture.setHcom({ agents: [] });
	const agent = { agent: 'claude', agent_session: { kind: 'id', value: 's-plain' }, agent_status: 'idle', cwd: '/home/someone/projects/s-plain', pane_id: PANE, tab_id: 'wA:t-s-plain', workspace_id: 'wA' };
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents: [agent],
			panes: [{ pane_id: PANE, workspace_id: 'wA', cwd: agent.cwd, tab_id: agent.tab_id }],
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
			tabs: [{ tab_id: agent.tab_id, workspace_id: 'wA', label: '分頁-plain' }],
			screens: { [PANE]: [WIDE] }
		})
	);
	await fixture.refresh(cookie);
	if (SHOTS) mkdirSync(SHOTS, { recursive: true });
}, 30_000);
afterAll(async () => {
	await fixture?.cleanup();
});
afterEach(async () => {
	await browser?.close();
	browser = undefined;
});

async function visit() {
	browser = await launchChrome({ screen: `document.querySelector('.detail')?.innerText ?? ''` });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
	await tab.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
	await tab.send('Page.navigate', { url: `${fixture.url}/?agent=s-plain` });
	await tab.until(`[...document.querySelectorAll('.detail [role=tab]')].some((tab) => tab.firstChild.textContent.trim() === '終端')`, 'the page');
	await sleep(500);
	await tab.eval(`[...document.querySelectorAll('.detail [role=tab]')].find((tab) => tab.firstChild.textContent.trim() === '終端').click()`);
	await tab.until(`!!document.querySelector('.screen-panel pre') && !!document.querySelector('.dock .keys-pane')`, 'the screen');
}
async function shot(name: string) {
	if (!SHOTS) return;
	const { data } = (await tab.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
	writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
}
/** How far the key panel's left edge lies from the dock's right edge: the dock's width while the line shows, 0 for the keys. */
const offset = () => tab.eval<number>(`(() => { const dock = document.querySelector('.dock').getBoundingClientRect(); return Math.round((document.querySelector('.dock .keys-pane').getBoundingClientRect().left - dock.left) * 10) / 10; })()`);
const dockWidth = () => tab.eval<number>(`document.querySelector('.dock').getBoundingClientRect().width`);
const dots = () => tab.eval<number[]>(`[...document.querySelectorAll('.dock .dots i')].map((dot) => (dot.classList.contains('on') ? 1 : 0))`);
const showing = async () => ((await offset()) < 2 ? 'keys' : 'bar');
const settle = () => sleep(350);
/** A point of the command line that is not its box: the strip under the controls. */
const edge = () => tab.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector('.dock .cmd').getBoundingClientRect(); return { x: r.right - 6, y: r.bottom - 5 }; })()`);
const box = () => tab.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector('.dock textarea').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);

test('a slow swipe left past a quarter of the width shows the keys, a slow swipe right shows the line; the dots follow', async () => {
	await visit();
	const width = await dockWidth();
	const start = await box();
	expect(await showing()).toBe('bar');
	expect(await dots()).toEqual([1, 0]);
	const far = Math.ceil(width * QUARTER) + 12;
	await tab.swipe(start.x, start.y, -far, { ms: 700 });
	await settle();
	expect(await showing()).toBe('keys');
	expect(await offset()).toBeLessThan(2);
	expect(await dots()).toEqual([0, 1]);
	await shot('swipe-keys-dark');
	// Back: from the keys, right.
	await tab.swipe(width / 2, (await edge()).y, far, { ms: 700 });
	await settle();
	expect(await showing()).toBe('bar');
	expect(await dots()).toEqual([1, 0]);
}, 30_000);

test('a slow swipe short of a quarter of the width goes back; a quick flick of the same distance switches', async () => {
	await visit();
	const width = await dockWidth();
	const start = await box();
	const short = Math.floor(width * QUARTER) - 12;
	// Slow: about 0.04px per ms.
	await tab.swipe(start.x, start.y, -short, { ms: 2_000, steps: 20 });
	await settle();
	expect(await showing()).toBe('bar');
	// Quick: the same distance in 60ms is 1.5px per ms, five times the flick speed.
	expect(short / 60).toBeGreaterThan(FLICK * 4);
	await tab.swipe(start.x, start.y, -short, { ms: 60, steps: 6 });
	await settle();
	expect(await showing()).toBe('keys');
	// And a quick flick right brings the line back.
	await tab.swipe(width / 2, (await edge()).y, short, { ms: 60, steps: 6 });
	await settle();
	expect(await showing()).toBe('bar');
}, 30_000);

test('while the finger is down the panel is where the finger moved it, to the pixel, with no pull back; past the end it stays at the end', async () => {
	await visit();
	const width = await dockWidth();
	const start = await box();
	await tab.swipe(start.x, start.y, -120, { ms: 300, hold: true });
	await sleep(100);
	expect(await offset()).toBeCloseTo(width - 120, 0);
	await shot('swipe-mid-drag');
	await tab.liftFinger();
	await settle();
	expect(await showing()).toBe('keys');
	// Dragging the keys further left, where there is nothing after them: they stay at the end.
	await tab.swipe(width - 40, (await edge()).y, -150, { ms: 300, hold: true });
	await sleep(100);
	expect(await offset()).toBeCloseTo(0, 0);
	await tab.liftFinger();
	await settle();
	// Back to the line by a slow swipe right, then:
	await tab.swipe(30, (await edge()).y, width - 60, { ms: 600 });
	await settle();
	// Dragging the line right, where there is nothing before it: it does not move.
	expect(await showing()).toBe('bar');
	await tab.swipe(80, start.y, 150, { ms: 300, hold: true });
	await sleep(100);
	expect(await offset()).toBeCloseTo(width, 0);
	await tab.liftFinger();
}, 30_000);

test('a drag that is mostly vertical does nothing, and no key panel appears', async () => {
	await visit();
	const start = await edge();
	await tab.swipe(start.x - 100, start.y, -9, { dy: -80, ms: 300 });
	await settle();
	expect(await showing()).toBe('bar');
	await tab.swipe(start.x - 100, start.y, -60, { dy: -90, ms: 300 });
	await settle();
	expect(await showing()).toBe('bar');
}, 30_000);

test('while the box has the focus its drags are the text\'s; from the rest of the line, or with no focus, a swipe switches', async () => {
	await visit();
	const width = await dockWidth();
	const start = await box();
	await tab.eval(`document.querySelector('.dock textarea').focus()`);
	await tab.swipe(start.x, start.y, -(width / 2), { ms: 400 });
	await settle();
	expect(await showing()).toBe('bar');
	expect(await tab.eval(`document.activeElement === document.querySelector('.dock textarea')`)).toBe(true);
	// Another part of the line still switches, with the keyboard up.
	const rest = await edge();
	await tab.swipe(rest.x, rest.y, -(width / 2), { ms: 400 });
	await settle();
	expect(await showing()).toBe('keys');
	await tab.swipe(width / 2, rest.y, width / 2, { ms: 400 });
	await settle();
	// With the box unfocused a swipe that starts on it switches.
	await tab.eval(`document.activeElement.blur()`);
	await tab.swipe(start.x, start.y, -(width / 2), { ms: 400 });
	await settle();
	expect(await showing()).toBe('keys');
}, 30_000);

test('a swipe over the screen scrolls a long line and never switches the panel', async () => {
	await visit();
	const before = await tab.eval<number>(`document.querySelector('.screen-panel .scroller').scrollLeft`);
	const middle = await tab.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector('.screen-panel .scroller').getBoundingClientRect(); return { x: r.x + r.width - 40, y: r.y + r.height / 2 }; })()`);
	await tab.swipe(middle.x, middle.y, -250, { ms: 400 });
	await settle();
	expect(await showing()).toBe('bar');
	expect(await tab.eval<number>(`document.querySelector('.screen-panel .scroller').scrollLeft`)).toBeGreaterThan(before + 50);
	await shot('swipe-over-screen');
}, 30_000);

test('the swipe ending on a key does not press it; another tab gives the line back; a press on a key still goes', async () => {
	await visit();
	const width = await dockWidth();
	const start = await box();
	await tab.swipe(start.x, start.y, -(width / 2), { ms: 400 });
	await settle();
	expect(await showing()).toBe('keys');
	// A swipe right that starts on a key is a swipe, not a press.
	await tab.swipeOn('.dock .keys-pane button.key', width / 2, { ms: 400 });
	await settle();
	expect(await showing()).toBe('bar');
	await tab.swipe(start.x, start.y, -(width / 2), { ms: 400 });
	await settle();
	await tab.eval(`[...document.querySelectorAll('.detail [role=tab]')].find((tab) => tab.firstChild.textContent.trim() === '對話紀錄').click()`);
	await tab.until(`!document.querySelector('.dock .keys-pane')`, 'the panel gone');
	expect(await tab.eval(`document.querySelector('.dock textarea').getBoundingClientRect().left >= 0`)).toBe(true);
}, 30_000);
