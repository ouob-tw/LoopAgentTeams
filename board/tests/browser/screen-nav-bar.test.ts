// A phone's 畫面分頁 hides the top bar: the panel takes its height, the folded status card carries the
// "←", a notice sits at the very top clear of "←" and "展開", and another tab brings the bar back. A
// computer keeps the bar and has no "←" in the card. `SCREEN_TAB_SHOTS` names a folder for screenshots.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';
import { launchChrome, type Browser, type Tab } from '../browser.ts';

const SHOTS = process.env.SCREEN_TAB_SHOTS;
const PANE = 'wA:p-s-plain';
const MOUSE = '--blink-settings=primaryPointerType=4,primaryHoverType=2,availablePointerTypes=4,availableHoverTypes=2';

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;

function setHerdr(extra: object = {}) {
	const agent = { agent: 'claude', agent_session: { kind: 'id', value: 's-plain' }, agent_status: 'idle', cwd: '/home/someone/projects/s-plain', pane_id: PANE, tab_id: 'wA:t-s-plain', workspace_id: 'wA' };
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents: [agent],
			panes: [{ pane_id: agent.pane_id, workspace_id: 'wA', cwd: agent.cwd, tab_id: agent.tab_id }],
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
			tabs: [{ tab_id: agent.tab_id, workspace_id: 'wA', label: '分頁-plain' }],
			screens: { [PANE]: ['row 1\r\nrow 2\r\nrow 3'] },
			...extra
		})
	);
}

beforeAll(async () => {
	fixture = await startFixture({ env: { LAT_BOARD_HERDR_TIMEOUT_SECONDS: '2' } });
	cookie = await fixture.login('screen-nav-bar');
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', 's-plain.jsonl'), JSON.stringify({ kind: 'user', time: new Date().toISOString(), text: '跑一下單元測試' }) + '\n');
	fixture.setHcom({ agents: [] });
	setHerdr();
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

async function visit({ width, height, phone, theme }: { width: number; height: number; phone: boolean; theme: 'light' | 'dark' }) {
	setHerdr();
	browser = await launchChrome({ screen: `document.querySelector('.detail')?.innerText ?? ''`, args: phone ? [] : [MOUSE] });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: phone });
	if (phone) await tab.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
	await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('lat-board-theme', '${theme}')` });
	await tab.send('Page.navigate', { url: `${fixture.url}/?agent=s-plain` });
	await tab.until(`JSON.stringify(history.state).includes('depth')`, 'the board to start');
}
async function shot(name: string) {
	if (!SHOTS) return;
	const { data } = (await tab.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
	writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
}
const openTab = (label: string) => tab.eval(`[...document.querySelectorAll('.detail [role=tab]')].find((tab) => tab.firstChild.textContent.trim() === '${label}').click()`);
const openScreen = async () => {
	await openTab('畫面');
	await tab.until(`!!document.querySelector('.screen-panel pre') && !!document.querySelector('.detail .bar')`, 'the screen');
};
const topbarShown = () => tab.eval<boolean>(`(() => { const bar = document.querySelector('.detail .topbar'); return !!bar && getComputedStyle(bar).display !== 'none'; })()`);
const rect = (selector: string) => `(() => { const r = document.querySelector('${selector}').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; })()`;
type Box = { left: number; right: number; top: number; bottom: number };

for (const theme of ['dark', 'light'] as const) {
	test(`phone, ${theme}: the top bar is gone on the 畫面 tab, the box reaches the top, "←" is the card's first thing and goes back`, async () => {
		await visit({ width: 390, height: 844, phone: true, theme });
		expect(await topbarShown()).toBe(true);
		const withBar = (await tab.eval<Box>(rect('.detail [role=tablist]'))).top;
		await shot(`phone-${theme}-transcript-bar`);
		await openScreen();
		expect(await topbarShown()).toBe(false);
		const bar = await tab.eval<Box>(rect('.detail .bar'));
		expect(bar.top).toBeLessThan(8);
		expect((await tab.eval<Box>(rect('.detail [role=tablist]'))).top).toBeLessThan(withBar);
		// "←" is the card's leftmost thing and big enough to tap.
		const back = await tab.eval<Box>(rect('.detail .bar .back'));
		expect(back.left - bar.left).toBeLessThan(16);
		expect(back.bottom - back.top).toBeGreaterThanOrEqual(30);
		expect(await tab.eval<string>(`document.querySelector('.detail .bar .back').innerText`)).toBe('←');
		await shot(`phone-${theme}-screen`);
		// The page does not scroll: the box ends at the command line.
		expect(await tab.eval<number>(`document.documentElement.scrollHeight - innerHeight`)).toBeLessThanOrEqual(0);
		await tab.eval(`document.querySelector('.detail .bar .back').click()`);
		await tab.until(`location.search === '?tab=agents' || location.search === ''`, 'the list');
		expect(await tab.eval(`getComputedStyle(document.querySelector('.detail')).display`)).toBe('none');
	}, 30_000);

	test(`phone, ${theme}: the bar comes back on the 對話紀錄 tab and goes again on returning to 畫面`, async () => {
		await visit({ width: 390, height: 844, phone: true, theme });
		await openScreen();
		expect(await topbarShown()).toBe(false);
		await openTab('對話紀錄');
		await tab.until(`!document.querySelector('.detail .bar')`, 'the card back');
		expect(await topbarShown()).toBe(true);
		expect(await tab.eval(`!!document.querySelector('.detail .topbar button[aria-label="返回"]')`)).toBe(true);
		await shot(`phone-${theme}-transcript-again`);
		await openScreen();
		expect(await topbarShown()).toBe(false);
	}, 30_000);
}

test('phone: a notice sits at the very top and covers neither "←" nor "展開"', async () => {
	await visit({ width: 390, height: 844, phone: true, theme: 'dark' });
	await openScreen();
	await tab.eval(`document.querySelector('.screen-panel .round').click()`);
	await tab.until(`!!document.querySelector('.screen-panel [role=toolbar]')`, 'the panel');
	setHerdr({ fail: { 'pane send-keys': { exit: 1, stderr: JSON.stringify({ error: { code: 'x', message: 'pane is busy' } }) } } });
	await tab.eval(`document.querySelector('.screen-panel [role=toolbar] .groups button').click()`);
	await tab.until(`!!document.querySelector('.toasts .toast')`, 'a notice');
	const toast = await tab.eval<Box>(rect('.toasts .toast'));
	const back = await tab.eval<Box>(rect('.detail .bar .back'));
	const expand = await tab.eval<Box>(rect('.detail .bar button[aria-expanded]'));
	expect(toast.top).toBeLessThan(8);
	expect(toast.left).toBeGreaterThanOrEqual(back.right);
	expect(toast.right).toBeLessThanOrEqual(expand.left);
	await shot('phone-dark-notice');
}, 30_000);

test('computer: the top bar stays on the 畫面 tab and the card has no "←"', async () => {
	await visit({ width: 1280, height: 800, phone: false, theme: 'dark' });
	await openScreen();
	expect(await tab.eval(`!!document.querySelector('.detail .bar .back')`)).toBe(false);
	await shot('computer-screen');
	// A narrow window with a mouse is a computer too: its top bar stays.
	await tab.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 800, deviceScaleFactor: 1, mobile: false });
	await tab.until(`getComputedStyle(document.querySelector('.detail .topbar')).display !== 'none'`, 'the bar at 420px');
	expect(await tab.eval(`!!document.querySelector('.detail .bar .back')`)).toBe(false);
}, 30_000);

test('phone: with the command line put away the box runs down to the bottom, the keys sit above its round button, and it all returns when reopened', async () => {
	await visit({ width: 390, height: 844, phone: true, theme: 'dark' });
	await openScreen();
	const edge = () => tab.eval<{ boxBottom: number; dockTop: number; inner: number; tall: number }>(`({ boxBottom: document.querySelector('.screen-panel .box').getBoundingClientRect().bottom, dockTop: document.querySelector('.dock').getBoundingClientRect().top, inner: innerHeight, tall: document.documentElement.scrollHeight })`);
	const open = await edge();
	expect(Math.abs(open.boxBottom - open.dockTop)).toBeLessThan(2);
	await tab.eval(`document.querySelector('.dock .hide').click()`);
	await tab.until(`!!document.querySelector('.dock .reopen')`, 'the round button');
	await tab.until(`Math.abs(document.querySelector('.screen-panel .box').getBoundingClientRect().bottom - innerHeight) < 2`, 'the box at the bottom');
	expect((await edge()).tall).toBeLessThanOrEqual(open.inner);
	const reopen = await tab.eval<Box>(rect('.dock .reopen'));
	const round = await tab.eval<Box>(rect('.screen-panel .round'));
	expect(round.bottom).toBeLessThanOrEqual(reopen.top);
	await shot('phone-dark-bar-away');
	// The opened key panel is above it too, and the lines stay above the panel.
	await tab.eval(`document.querySelector('.screen-panel .round').click()`);
	await tab.until(`!!document.querySelector('.screen-panel [role=toolbar]')`, 'the panel');
	await new Promise((resolve) => setTimeout(resolve, 150));
	expect((await tab.eval<Box>(rect('.screen-panel [role=toolbar]'))).bottom).toBeLessThanOrEqual(reopen.top);
	await shot('phone-dark-bar-away-menu');
	await tab.eval(`document.querySelector('.screen-panel .close').click()`);
	await tab.eval(`document.querySelector('.dock .reopen').click()`);
	await tab.until(`!document.querySelector('.dock .reopen')`, 'the command line back');
	await tab.until(`Math.abs(document.querySelector('.screen-panel .box').getBoundingClientRect().bottom - document.querySelector('.dock').getBoundingClientRect().top) < 2`, 'the box above it');
}, 30_000);
