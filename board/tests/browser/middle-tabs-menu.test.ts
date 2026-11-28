// The middle column's tab bar in a real browser: headless Chrome over its DevTools protocol on the
// built board. Three or more buttons in view keep the row of buttons (past the edge it scrolls);
// fewer than three become one switch button (current tab, count, caret) with a menu of every tab.
// The form follows the column's measured width live. Frames go to LAT_BOARD_SHOTS when it is set.
// Skipped when the host has no Chrome.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, shot, TEST_MS, type Browser, type Tab } from '../browser.ts';

const ROW = `getComputedStyle(document.querySelector('.middle-tabs')).visibility === 'visible'`;
const SWITCH = `document.querySelector('.middle-switch')`;
const MENU = `document.querySelector('.middle-menu')`;
/** Nothing on the page reaches past the window, and the switch and its menu never scroll sideways. */
const NO_SIDEWAYS = `document.documentElement.scrollWidth <= window.innerWidth && (!${SWITCH} || ${SWITCH}.scrollWidth <= ${SWITCH}.clientWidth) && (!${MENU} || ${MENU}.scrollWidth <= ${MENU}.clientWidth)`;

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;

beforeAll(async () => {
	fixture = await startFixture();
	cookie = await fixture.login();
}, 60_000);
afterEach(async () => {
	await browser?.close();
});
afterAll(async () => {
	await fixture?.cleanup();
});

async function visit(width: number) {
	browser = await launchChrome();
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 761 });
	await tab.send('Page.navigate', { url: `${fixture.url}/` });
	await tab.boardStarted();
	await tab.until(`!!document.querySelector('.middle-tabs')`, 'the tab bar');
}
/** Drag the middle column to `px`, as its handle does: the width is kept on the root element. */
const dragTo = (px: number) => tab.eval(`document.documentElement.style.setProperty('--inbox-w', '${px}px')`);
const theme = (name: string) => tab.eval(`document.documentElement.dataset.theme = '${name}'`);

test.skipIf(!CHROME)(
	'a phone: three or more buttons fit, so the row stays, with readable text and touch-sized buttons',
	async () => {
		await visit(390);
		expect(await tab.eval(ROW)).toBe(true);
		expect(await tab.eval(SWITCH)).toBe(null);
		// ui-baseline on a phone: text at least 16px, targets at least 44px tall and wide.
		const sizes = await tab.eval<{ font: number; height: number; width: number }[]>(
			`[...document.querySelectorAll('.middle-tabs button')].map((b) => ({ font: parseFloat(getComputedStyle(b).fontSize), height: b.getBoundingClientRect().height, width: b.getBoundingClientRect().width }))`
		);
		expect(sizes.length).toBe(6);
		for (const size of sizes) {
			expect(size.font).toBeGreaterThanOrEqual(16);
			expect(size.height).toBeGreaterThanOrEqual(44);
			expect(size.width).toBeGreaterThanOrEqual(44);
		}
		expect(await tab.eval(`parseFloat(getComputedStyle(document.querySelector('.middle-tabs small')).fontSize)`)).toBeGreaterThanOrEqual(16);
		expect(await tab.eval(`document.documentElement.scrollWidth <= window.innerWidth`)).toBe(true);
		await shot(tab, 'tabs-390-row');
		await theme(((await tab.eval<string>(`document.documentElement.dataset.theme`)) === 'dark') ? 'light' : 'dark');
		await shot(tab, 'tabs-390-row-other-theme');
	},
	TEST_MS
);

test.skipIf(!CHROME)(
	'a wide window: the row as before; dragged narrow it becomes one switch button, and back again live',
	async () => {
		await visit(1400);
		expect(await tab.eval(ROW)).toBe(true);
		expect(await tab.eval(SWITCH)).toBe(null);
		expect(await tab.eval(`[...document.querySelectorAll('.middle-tabs button')].map((b) => b.dataset.middle)`)).toEqual(['inbox', 'agents', 'quota', 'automation', 'events', 'resource']);
		await shot(tab, 'tabs-1400-row');

		// Dragged to a width where fewer than three buttons fit: the row is replaced, nothing scrolls sideways.
		await dragTo(200);
		await tab.until(`!!${SWITCH}`, 'the switch button');
		expect(await tab.eval(ROW)).toBe(false);
		expect(await tab.eval(`${SWITCH}.innerText.replace(/\\s+/g, ' ').trim()`)).toMatch(/^待辦 ▾$/);
		expect(await tab.eval(`${SWITCH}.getAttribute('aria-expanded')`)).toBe('false');
		expect(await tab.eval(NO_SIDEWAYS)).toBe(true);
		await shot(tab, 'tabs-dragged-switch');

		// Wider again: three fit, the row is back.
		await dragTo(400);
		await tab.until(`!${SWITCH}`, 'the row again');
		expect(await tab.eval(ROW)).toBe(true);
		await dragTo(200);
		await tab.until(`!!${SWITCH}`, 'the switch again');
	},
	TEST_MS
);

test.skipIf(!CHROME)(
	'the switch menu: every tab, the current one marked, picking switches and closes, Esc and a click outside close',
	async () => {
		await visit(1400);
		await dragTo(200);
		await tab.until(`!!${SWITCH}`, 'the switch button');
		expect(await tab.eval(MENU)).toBe(null);

		await tab.pointerClick('.middle-switch');
		await tab.until(`!!${MENU}`, 'the menu');
		expect(await tab.eval(`${SWITCH}.getAttribute('aria-expanded')`)).toBe('true');
		expect(await tab.eval(`[...${MENU}.querySelectorAll('button')].map((b) => b.innerText.replace(/\\s+/g, ' ').trim())`)).toEqual(['✓ 待辦', 'Herdr 0', '額度', '週期任務', '事件任務', '資源']);
		expect(await tab.eval(`[...${MENU}.querySelectorAll('button')].map((b) => b.getAttribute('aria-current'))`)).toEqual(['true', null, null, null, null, null]);
		const items = await tab.eval<{ font: number; height: number }[]>(
			`[...${MENU}.querySelectorAll('button')].map((b) => ({ font: parseFloat(getComputedStyle(b).fontSize), height: b.getBoundingClientRect().height }))`
		);
		for (const item of items) {
			expect(item.font).toBeGreaterThanOrEqual(16);
			expect(item.height).toBeGreaterThanOrEqual(44);
		}
		expect(await tab.eval(NO_SIDEWAYS)).toBe(true);
		await shot(tab, 'tabs-menu-open');
		const other = (await tab.eval<string>(`document.documentElement.dataset.theme`)) === 'dark' ? 'light' : 'dark';
		await theme(other);
		await shot(tab, 'tabs-menu-open-other-theme');
		await theme(other === 'dark' ? 'light' : 'dark');

		// Esc closes it and the switch button has the focus again.
		await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
		await tab.until(`!${MENU}`, 'the menu closed by Esc');
		expect(await tab.eval(`document.activeElement === ${SWITCH}`)).toBe(true);

		// A click outside closes it.
		await tab.pointerClick('.middle-switch');
		await tab.until(`!!${MENU}`, 'the menu again');
		await tab.eval(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
		await tab.until(`!${MENU}`, 'the menu closed by a click outside');

		// Picking a tab switches to it, closes the menu and names it on the switch button.
		await tab.pointerClick('.middle-switch');
		await tab.until(`!!${MENU}`, 'the menu a third time');
		await tab.pointerClick('.middle-menu [data-pick="quota"]');
		await tab.until(`!${MENU} && location.search === '?tab=quota'`, 'the 額度 tab');
		expect(await tab.eval(`${SWITCH}.innerText.replace(/\\s+/g, ' ').trim()`)).toBe('額度 ▾');
		await tab.pointerClick('.middle-switch');
		await tab.until(`!!${MENU}`, 'the menu on 額度');
		expect(await tab.eval(`[...${MENU}.querySelectorAll('button')].map((b) => b.getAttribute('aria-current'))`)).toEqual([null, null, 'true', null, null, null]);
		await shot(tab, 'tabs-menu-quota-current');

		// Wide again while open: the menu goes with the switch button.
		await dragTo(400);
		await tab.until(`!${SWITCH} && !${MENU}`, 'the row, without the menu');
		expect(await tab.eval(`document.querySelector('[data-middle="quota"]').getAttribute('aria-pressed')`)).toBe('true');
	},
	TEST_MS
);

test.skipIf(!CHROME)(
	'the Herdr count is on the switch button and in the menu when Herdr is the tab shown',
	async () => {
		await visit(1400);
		await tab.eval(`document.querySelector('[data-middle="agents"]').click()`);
		await dragTo(200);
		await tab.until(`!!${SWITCH}`, 'the switch button');
		expect(await tab.eval(`${SWITCH}.innerText.replace(/\\s+/g, ' ').trim()`)).toBe('Herdr 0 ▾');
		expect(await tab.eval(NO_SIDEWAYS)).toBe(true);
		await shot(tab, 'tabs-switch-herdr');
	},
	TEST_MS
);
