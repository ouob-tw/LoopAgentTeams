// The 畫面字體 setting: the 畫面分頁's text takes the chosen size (10 to 28px, 16px by default) whatever
// 整體大小 and 最小字體 say, at once, kept on the device across a reload, and it lines up still. On a
// phone it is set from another tab and holds on coming back. `SCREEN_TAB_SHOTS` names a folder for screenshots.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { sleep, startFixture, type Fixture } from '../harness.ts';
import { launchChrome, type Browser, type Tab } from '../browser.ts';

const SHOTS = process.env.SCREEN_TAB_SHOTS;
const PANE = 'wA:p-s-plain';
const MOUSE = '--blink-settings=primaryPointerType=4,primaryHoverType=2,availablePointerTypes=4,availableHoverTypes=2';
const SCREEN = Array.from({ length: 60 }, (_, index) => `row ${index + 1} ${'─'.repeat(30)}`).join('\r\n');

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;

beforeAll(async () => {
	fixture = await startFixture({ env: { LAT_BOARD_HERDR_TIMEOUT_SECONDS: '2' } });
	cookie = await fixture.login('screen-font');
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
			screens: { [PANE]: [SCREEN] }
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

async function visit({ width, height, phone, scripts = [] }: { width: number; height: number; phone: boolean; scripts?: string[] }) {
	browser = await launchChrome({ screen: `document.querySelector('.detail')?.innerText ?? ''`, args: phone ? [] : [MOUSE] });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: phone });
	if (phone) await tab.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
	for (const source of scripts) await tab.send('Page.addScriptToEvaluateOnNewDocument', { source });
	await tab.send('Page.navigate', { url: `${fixture.url}/?agent=s-plain` });
	await tab.until(`[...document.querySelectorAll('.detail [role=tab]')].some((tab) => tab.firstChild.textContent.trim() === '畫面')`, 'the page');
	await sleep(500);
}
async function shot(name: string) {
	if (!SHOTS) return;
	const { data } = (await tab.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
	writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
}
const openTab = (label: string) => tab.eval(`[...document.querySelectorAll('.detail [role=tab]')].find((tab) => tab.firstChild.textContent.trim() === '${label}').click()`);
const openScreen = async () => {
	await openTab('畫面');
	await tab.until(`!!document.querySelector('.screen-panel pre')`, 'the screen');
};
const font = () => tab.eval<number>(`parseFloat(getComputedStyle(document.querySelector('.screen-panel pre')).fontSize)`);
/** The board's own text next to it, for what the setting must not touch. */
const otherFont = () => tab.eval<number>(`parseFloat(getComputedStyle(document.querySelector('.detail [role=tab]')).fontSize)`);
const settings = (action: string) => tab.eval(`(() => { const dialog = document.querySelector('dialog'); if (!dialog.open) document.querySelector('[aria-label="設定"]').click(); ${action} })()`);
const press = (label: string, times = 1) => settings(`for (let i = 0; i < ${times}; i++) dialog.querySelector('[aria-label="${label}"]').click();`);
const reset = () => settings(`[...dialog.querySelectorAll('[aria-label="畫面字體"] button')].find((button) => button.textContent.trim() === '還原預設').click();`);
const shown = () => tab.eval<string>(`document.querySelector('dialog [aria-label="畫面字體"] output').textContent`);
const closeSettings = () => tab.eval(`document.querySelector('dialog').close()`);

/** Rows still line up: each row is one line tall, 1.2 × the size. */
const lines = () =>
	tab.eval<{ pitch: number }>(`(() => {
		const pre = document.querySelector('.screen-panel pre');
		const range = document.createRange(); range.selectNodeContents(pre);
		const rows = [...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => rect.top);
		const gaps = rows.slice(1).map((top, index) => top - rows[index]).filter((gap) => gap > 1);
		return { pitch: Math.min(...gaps) };
	})()`);

test('computer: 10, 16 and 28px apply at once beside 整體大小 and 最小字體, and 還原預設 goes back to 16px', async () => {
	await visit({ width: 1280, height: 800, phone: false, scripts: [`localStorage.setItem('lat-board-min-font', '24')`, `localStorage.setItem('lat-board-scale', '150')`] });
	await openScreen();
	// Neither the overall size nor the 24px floor touches it: 16px, and the other text is the big one.
	expect(await font()).toBe(16);
	expect(await otherFont()).toBeGreaterThanOrEqual(24);
	await settings('');
	expect(await shown()).toBe('16px');
	await press('畫面字調小', 6);
	await sleep(100);
	expect(await shown()).toBe('10px');
	expect(await font()).toBe(10);
	expect((await lines()).pitch).toBeCloseTo(12, 0);
	await closeSettings();
	await shot('computer-font-10');
	await reset();
	await sleep(100);
	expect(await font()).toBe(16);
	await press('畫面字調大', 12);
	await sleep(100);
	expect(await shown()).toBe('28px');
	expect(await font()).toBe(28);
	expect((await lines()).pitch).toBeCloseTo(33.6, 0);
	// At the end of its range the button stops.
	expect(await tab.eval<boolean>(`document.querySelector('dialog [aria-label="畫面字調大"]').disabled`)).toBe(true);
	await closeSettings();
	await shot('computer-font-28');
	// The other text kept its own size.
	expect(await otherFont()).toBeGreaterThanOrEqual(24);
	// Kept on this device across a reload.
	await tab.send('Page.reload');
	await tab.until(`[...document.querySelectorAll('.detail [role=tab]')].some((tab) => tab.firstChild.textContent.trim() === '畫面')`, 'the page');
	await sleep(500);
	await openScreen();
	expect(await font()).toBe(28);
	await reset();
	await sleep(100);
	expect(await font()).toBe(16);
	expect(await tab.eval<string | null>(`localStorage.getItem('lat-board-screen-font')`)).toBeNull();
}, 60_000);

test('computer: the box still fills the height, slides sideways and the bottom row sits on its bottom at 28px', async () => {
	await visit({ width: 1280, height: 800, phone: false, scripts: [`localStorage.setItem('lat-board-screen-font', '28')`] });
	await openScreen();
	expect(await font()).toBe(28);
	const at = await tab.eval<{ boxBottom: number; dockTop: number; scrollerBottom: number; lastBottom: number; lineHeight: number; wide: number; client: number; pageWide: number; viewport: number }>(`(() => {
		const box = document.querySelector('.screen-panel .box').getBoundingClientRect();
		const scroller = document.querySelector('.screen-panel .scroller');
		const range = document.createRange(); range.selectNodeContents(document.querySelector('.screen-panel pre'));
		const rows = [...range.getClientRects()].filter((rect) => rect.width > 0);
		return { boxBottom: box.bottom, dockTop: document.querySelector('.dock').getBoundingClientRect().top, scrollerBottom: scroller.getBoundingClientRect().top + scroller.clientHeight, lastBottom: Math.max(...rows.map((rect) => rect.bottom)), lineHeight: 28 * 1.2, wide: scroller.scrollWidth, client: scroller.clientWidth, pageWide: document.documentElement.scrollWidth, viewport: innerWidth };
	})()`);
	expect(Math.abs(at.boxBottom - at.dockTop)).toBeLessThan(2);
	expect(at.scrollerBottom - at.lastBottom).toBeLessThan(at.lineHeight);
	expect(at.pageWide).toBeLessThanOrEqual(at.viewport);
}, 30_000);

test('phone: set from the 對話紀錄 tab, it holds on coming back to the 畫面 tab, whose top bar is gone', async () => {
	await visit({ width: 390, height: 844, phone: true });
	await openScreen();
	expect(await font()).toBe(16);
	await shot('phone-font-16');
	await openTab('對話紀錄');
	await tab.until(`!!document.querySelector('.detail .topbar') && getComputedStyle(document.querySelector('.detail .topbar')).display !== 'none'`, 'the top bar');
	await settings('');
	await press('畫面字調大', 4);
	expect(await shown()).toBe('20px');
	await closeSettings();
	await openScreen();
	expect(await font()).toBe(20);
	expect(await tab.eval(`getComputedStyle(document.querySelector('.detail .topbar')).display`)).toBe('none');
	await shot('phone-font-20');
	// Overall size and the floor leave it alone on a phone too.
	await tab.eval(`document.documentElement.style.setProperty('--min-font', '24px'); document.documentElement.style.setProperty('--ui-scale', '1.5')`);
	await sleep(100);
	expect(await font()).toBe(20);
}, 60_000);
