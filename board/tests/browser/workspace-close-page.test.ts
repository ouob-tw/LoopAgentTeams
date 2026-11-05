// The Herdr tab's workspace headings: a right click (a long press on a phone) opens a menu that
// closes the workspace after a confirmation counting its agents and tabs; the board's own
// workspace is not offered. And the last agent of a workspace closed from its page leaves the
// workspace listed, as Herdr keeps it with a CMD tab. Herdr and hcom are fakes. SHOTS=<dir> saves
// what each step looks like.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHROME, launchChrome, type Browser, type Tab } from '../browser.ts';
import { sleep, startFixture, type Fixture } from '../harness.ts';

const SHOTS = process.env.SHOTS;
let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;

const agent = (workspace: string, name: string) => ({
	agent: 'claude',
	agent_session: { kind: 'id', value: `s-${name}` },
	agent_status: 'idle',
	cwd: `/home/someone/projects/${name}`,
	pane_id: `${workspace}:p-${name}`,
	tab_id: `${workspace}:t-${name}`,
	workspace_id: workspace
});
/** wA holds the board's own plain terminal and one agent; wB two agents and a plain terminal tab;
 *  wC one agent alone. */
function setHerdr(extra: object = {}) {
	const agents = [agent('wA', 'alpha'), agent('wB', 'beta'), agent('wB', 'gamma'), agent('wC', 'solo')];
	const plain = [{ pane_id: 'wA:p-board', tab_id: 'wA:t-board', workspace_id: 'wA' }, { pane_id: 'wB:p-shell', tab_id: 'wB:t-shell', workspace_id: 'wB' }];
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents,
			panes: [...agents.map(({ pane_id, tab_id, workspace_id }) => ({ pane_id, tab_id, workspace_id })), ...plain],
			workspaces: [
				{ workspace_id: 'wA', number: 1, label: 'Alpha' },
				{ workspace_id: 'wB', number: 2, label: 'Beta' },
				{ workspace_id: 'wC', number: 3, label: 'Gamma' }
			],
			tabs: [...agents, ...plain].map(({ tab_id, workspace_id }) => ({ tab_id, workspace_id, label: tab_id.split(':t-')[1] })),
			...extra
		})
	);
}
const herdrPlan = () => JSON.parse(readFileSync(join(fixture.dir, 'herdr.json'), 'utf8'));
const herdrCalls = (): string[][] => {
	const file = join(fixture.dir, 'herdr-calls.jsonl');
	return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((call: string[]) => call.join(' ') !== 'pane list') : [];
};

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture({ env: { HERDR_PANE_ID: 'wA:p-board' } });
	cookie = await fixture.login();
	fixture.setHcom({ agents: [] });
}, 30_000);
afterEach(async () => {
	await browser?.close();
});
afterAll(async () => {
	await fixture?.cleanup();
});

async function visit(width: number, touch: boolean, search = '') {
	rmSync(join(fixture.dir, 'herdr-calls.jsonl'), { force: true });
	browser = await launchChrome();
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width < 761 });
	if (touch) await tab.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
	await tab.send('Page.navigate', { url: `${fixture.url}/${search}` });
	await tab.until(`JSON.stringify(history.state).includes('depth')`, 'the board to start');
}
async function shot(name: string) {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	const { data } = (await tab.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
	writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
}
const HEAD = (id: string) => `.inbox [data-workspace="${id}"] h3`;
const FITS = `document.documentElement.scrollWidth <= window.innerWidth`;
const click = (selector: string) => tab.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
const toasts = () => tab.eval<string>(`document.querySelector('.dock .toasts')?.innerText ?? ''`);
const headings = () => tab.eval<string[]>(`[...document.querySelectorAll('.inbox [data-workspace] h3')].map((h) => h.innerText)`);

/** Open a heading's menu, a right click or a long press, and wait for what it read. */
async function openMenu(touch: boolean, workspace: string) {
	const at = await tab.eval<{ x: number; y: number }>(`(() => { const box = document.querySelector(${JSON.stringify(HEAD(workspace))}).getBoundingClientRect(); return { x: box.left + 20, y: box.top + box.height / 2 }; })()`);
	if (touch) {
		await tab.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
		await sleep(700);
		await tab.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	} else {
		await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'right', buttons: 2, clickCount: 1 });
		await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'right', buttons: 0, clickCount: 1 });
	}
	await tab.until(`!!document.querySelector('.menu') && !document.querySelector('.menu').innerText.includes('讀取工作區內容中')`, 'the workspace menu');
}
/** The menu: inside the window, and how far it reaches over the heading it was opened on (0 when
 *  the heading's name stays in full view). */
const menuPlace = (workspace: string) =>
	tab.eval<{ inside: boolean; overHeading: number }>(`(() => {
		const menu = document.querySelector('.menu').getBoundingClientRect();
		const heading = document.querySelector(${JSON.stringify(HEAD(workspace))}).getBoundingClientRect();
		return { inside: menu.left >= 0 && menu.top >= 0 && menu.right <= innerWidth && menu.bottom <= innerHeight, overHeading: Math.max(0, heading.bottom - menu.top) };
	})()`);

for (const [width, touch, kind] of [[1280, false, 'desktop'], [390, true, 'phone']] as const) {
	test.skipIf(!CHROME)(`${kind}: the heading's menu closes a workspace after a confirmation counting its agents and tabs`, async () => {
		setHerdr();
		await fixture.refresh(cookie);
		await visit(width, touch);
		await tab.eval(`document.querySelector('[data-middle="agents"]').click()`);
		await tab.until(`!!document.querySelector(${JSON.stringify(HEAD('wB'))})`, 'the list');
		await shot(`${kind}-1-list`);

		// The board's own workspace: the item is there but off, and says why.
		await openMenu(touch, 'wA');
		expect(await tab.eval(`document.querySelector('.menu button').disabled`)).toBe(true);
		expect(await tab.eval<string>(`document.querySelector('.menu').innerText`)).toContain('看板自己所在的窗格就在這個工作區裡');
		await shot(`${kind}-2-own-menu`);
		await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
		await tab.until(`!document.querySelector('.menu')`, 'the menu closed');

		await openMenu(touch, 'wB');
		expect(await tab.eval(`[...document.querySelectorAll('.menu button')].map((item) => [item.innerText, item.disabled])`)).toEqual([['關閉工作區', false]]);
		expect(await menuPlace('wB')).toEqual({ inside: true, overHeading: 0 });
		expect(await tab.eval(FITS)).toBe(true);
		await shot(`${kind}-3-menu`);
		await click('.menu button');
		await tab.until(`!!document.querySelector('[data-action="confirm-close-workspace"]')`, 'the confirmation');
		expect(await tab.eval<string>(`document.querySelector('.inbox [data-workspace="wB"] .confirm .warn').innerText`)).toBe(
			'關閉工作區「Beta」？裡面的 2 個 Agent 和 3 個分頁（含終端機分頁）會一起關掉。'
		);
		expect(await tab.eval(FITS)).toBe(true);
		await shot(`${kind}-4-confirm`);
		// Cancelled, nothing is closed.
		await tab.eval(`[...document.querySelectorAll('.inbox .confirm button')].find((button) => button.innerText === '取消').click()`);
		await tab.until(`!document.querySelector('.inbox .confirm')`, 'the confirmation gone');
		expect(herdrCalls()).toEqual([]);

		// Herdr refuses: the notice says why, and the workspace stays.
		setHerdr({ fail: { 'workspace close': { exit: 1, stderr: JSON.stringify({ error: { code: 'internal', message: 'busy' } }) } } });
		await openMenu(touch, 'wB');
		await click('.menu button');
		await click('[data-action="confirm-close-workspace"]');
		await tab.until(`document.querySelector('.dock .toasts')?.innerText.includes('關閉工作區失敗')`, 'the failure');
		expect(await toasts()).toContain('關閉工作區失敗：Herdr 沒有關閉工作區：busy');
		expect(await headings()).toEqual(['Alpha', 'Beta', 'Gamma']);
		await shot(`${kind}-5-failed`);

		setHerdr();
		await openMenu(touch, 'wB');
		await click('.menu button');
		await click('[data-action="confirm-close-workspace"]');
		await tab.until(`!document.querySelector('.inbox [data-workspace="wB"]')`, 'the workspace gone');
		expect(await toasts()).toContain('已關閉工作區「Beta」');
		expect(herdrCalls()).toEqual([['workspace', 'close', 'wB'], ['workspace', 'close', 'wB']]);
		expect(await headings()).toEqual(['Alpha', 'Gamma']);
		await shot(`${kind}-6-closed`);
	}, 40_000);
}

test.skipIf(!CHROME)('the last agent of a workspace closed from its page leaves the workspace in its place, with a CMD tab in Herdr', async () => {
	setHerdr();
	await fixture.refresh(cookie);
	await visit(390, true, '?agent=s-solo');
	await tab.until(`!!document.querySelector('.detail [data-action="close"]')`, 'the agent page');
	await click('.detail [data-action="close"]');
	await tab.until(`!!document.querySelector('.detail [data-action="confirm-close"]')`, 'the confirmation');
	await click('.detail [data-action="confirm-close"]');
	await tab.until(`!document.querySelector('.detail [data-action="close"]')`, 'the agent closed');
	expect(herdrCalls()).toEqual([
		['tab', 'create', '--workspace', 'wC', '--cwd', '/home/someone/projects/solo', '--label', 'CMD', '--no-focus'],
		['pane', 'close', 'wC:p-solo']
	]);
	const plan = herdrPlan();
	expect(plan.workspaces.map((workspace: { label: string }) => workspace.label)).toEqual(['Alpha', 'Beta', 'Gamma']);
	expect(plan.tabs.filter((candidate: { workspace_id: string }) => candidate.workspace_id === 'wC').map((candidate: { label: string }) => candidate.label)).toEqual(['CMD']);
	// Back on the list, where a phone shows it alone.
	await tab.send('Page.navigate', { url: `${fixture.url}/` });
	await tab.until(`JSON.stringify(history.state).includes('depth')`, 'the board again');
	await tab.eval(`document.querySelector('[data-middle="agents"]').click()`);
	await tab.until(`document.querySelector(${JSON.stringify(HEAD('wC'))})?.checkVisibility()`, 'the list');
	expect(await headings()).toEqual(['Alpha', 'Beta', 'Gamma']);
	expect(await tab.eval<string>(`document.querySelector('.inbox [data-workspace="wC"]').innerText`)).toContain('沒有 Agent');
	await shot('phone-7-last-agent-closed');
}, 30_000);
