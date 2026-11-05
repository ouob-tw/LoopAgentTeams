// The 畫面分頁 in a real browser: headless Chrome on the built board with fake Herdr and hcom. Where
// the tab sits, the screen with its colours, the 按鍵選單 on a phone (touch emulated, not just a narrow
// window) and never on a computer, keys sent in order, a failed press emptying the queue and
// disabling the keys until the 恢復畫面, a screen that cannot be read, and a closed agent's tab.
// `SCREEN_TAB_SHOTS` names a folder to save each step's screenshot in.
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { jsonLines, sleep, startFixture, type Fixture } from '../harness.ts';
import { launchChrome, type Browser, type Tab } from '../browser.ts';

const SHOTS = process.env.SCREEN_TAB_SHOTS;
const ESC = '\x1b';
const PANE = 'wA:p-s-plain';
const SCREEN = [
	`${ESC}[38;5;2m●${ESC}[0m ${ESC}[1mUpdate${ESC}[0m(board/src/routes/+page.svelte)`,
	'',
	`${ESC}[38;5;4m╭──────────────────────────────────────────────────────────────────────────────╮${ESC}[0m`,
	`${ESC}[38;5;4m│${ESC}[0m ${ESC}[1mBash command${ESC}[0m`,
	`${ESC}[38;5;4m│${ESC}[0m   bun run test:unit`,
	`${ESC}[38;5;4m│${ESC}[0m Do you want to proceed?`,
	`${ESC}[38;5;4m│${ESC}[0m ${ESC}[38;5;4m❯ 1. Yes${ESC}[0m`,
	`${ESC}[38;5;4m│${ESC}[0m   2. Yes, and don't ask again for ${ESC}[33mbun run${ESC}[0m commands`,
	`${ESC}[38;5;4m│${ESC}[0m   3. No, and tell Claude what to do differently ${ESC}[2m(esc)${ESC}[0m`,
	// A line padded with blanks far past the text, as a program may draw it.
	`${ESC}[2mEsc to cancel · Tab to amend${' '.repeat(150)}${ESC}[0m`,
	`${ESC}[38;5;4m╰──────────────────────────────────────────────────────────────────────────────╯${ESC}[0m`
].join('\r\n');

const MOUSE = '--blink-settings=primaryPointerType=4,primaryHoverType=2,availablePointerTypes=4,availableHoverTypes=2';

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;

function herdrAgent(session: string) {
	return { agent: 'claude', agent_session: { kind: 'id', value: session }, agent_status: 'blocked', cwd: `/home/someone/projects/${session}`, pane_id: `wA:p-${session}`, tab_id: `wA:t-${session}`, workspace_id: 'wA' };
}
function setHerdr(extra: object = {}, sessions = ['s-plain']) {
	const agents = sessions.map(herdrAgent);
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents,
			panes: agents.map((agent) => ({ pane_id: agent.pane_id, workspace_id: 'wA', cwd: agent.cwd, tab_id: agent.tab_id })),
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
			tabs: agents.map((agent) => ({ tab_id: agent.tab_id, workspace_id: 'wA', label: '分頁-plain' })),
			screens: { [PANE]: [SCREEN] },
			...extra
		})
	);
}
const herdrCalls = (): string[][] => jsonLines(join(fixture.dir, 'herdr-calls.jsonl'));

beforeAll(async () => {
	fixture = await startFixture({ env: { LAT_BOARD_HERDR_TIMEOUT_SECONDS: '2' } });
	cookie = await fixture.login('screen-tab');
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', 's-plain.jsonl'), JSON.stringify({ kind: 'user', time: new Date().toISOString(), text: '跑一下單元測試' }) + '\n');
	writeFileSync(join(fixture.dir, 'transcripts', 's-gone.jsonl'), JSON.stringify({ kind: 'user', time: new Date().toISOString(), text: '先做到這裡' }) + '\n');
	// s-gone was seen in Herdr, then closed: hcom says the user stopped it, and Herdr no longer lists it.
	fixture.setHcom({ agents: [] });
	setHerdr({}, ['s-plain', 's-gone']);
	await fixture.refresh(cookie);
	const stopped = { data: { action: 'stopped', by: 'cli', reason: 'killed', snapshot: { name: 'gone', session_id: 's-gone', tool: 'claude', directory: '/home/someone/projects/s-gone' } }, id: 2, instance: 'gone', ts: new Date().toISOString(), type: 'life' };
	appendFileSync(join(fixture.dir, 'hcom-events.jsonl'), JSON.stringify(stopped) + '\n');
	fixture.setHcom({ agents: [] });
	setHerdr();
	await fixture.refresh(cookie);
	if (SHOTS) mkdirSync(SHOTS, { recursive: true });
}, 30_000);
afterAll(async () => {
	await fixture?.cleanup();
});
beforeEach(() => {
	rmSync(join(fixture.dir, 'herdr-calls.jsonl'), { force: true });
	setHerdr();
});
afterEach(async () => {
	await browser?.close();
	browser = undefined;
});

/** A logged-in Chrome on the agent's page; `phone` emulates a touch screen as the main pointer. */
async function visit({ width, height, phone, agent = 's-plain' }: { width: number; height: number; phone: boolean; agent?: string }) {
	// A computer's main pointer is a mouse that can hover; headless Chrome has none unless told.
	browser = await launchChrome({ screen: `document.querySelector('.detail')?.innerText ?? ''`, args: phone ? [] : [MOUSE] });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: phone });
	if (phone) await tab.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
	await tab.send('Page.navigate', { url: `${fixture.url}/?agent=${agent}` });
	await tab.until(`JSON.stringify(history.state).includes('depth')`, 'the board to start');
}
async function shot(name: string) {
	if (!SHOTS) return;
	const { data } = (await tab.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
	writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
}
/** Each tab's label, its count left out, and whether it is open. */
const TABS = `[...document.querySelectorAll('.detail [role=tab]')].map((tab) => [tab.firstChild.textContent.trim(), tab.getAttribute('aria-selected')])`;
const openScreen = async () => {
	await tab.eval(`[...document.querySelectorAll('.detail [role=tab]')].find((tab) => tab.firstChild.textContent.trim() === '畫面').click()`);
	await tab.until(`!!document.querySelector('.screen-panel pre')`, 'the screen');
};
const MENU = `document.querySelector('.screen-panel [role=toolbar]')`;
const KEYS = `[...document.querySelectorAll('.screen-panel [role=toolbar] .groups button')]`;
const ROUND = `document.querySelector('.screen-panel .round')`;
const openMenu = async () => {
	await tab.until(`!!${ROUND}`, 'the round button');
	await tab.eval(`${ROUND}.click()`);
	await tab.until(`${KEYS}.length === 13`, 'the 按鍵選單');
};
const press = (label: string) => tab.eval(`${KEYS}.find((button) => button.innerText === ${JSON.stringify(label)}).click()`);
const keysEnabled = () => tab.eval<boolean>(`${KEYS}.length > 0 && ${KEYS}.every((button) => !button.disabled)`);

test("computer: the tab comes after the conversation, shows the screen in colour at the board's size, and no 按鍵選單 even in a narrow window", async () => {
	await visit({ width: 1280, height: 800, phone: false });
	await tab.until(`${TABS}.length === 3`, 'the tabs');
	expect(await tab.eval(TABS)).toEqual([
		['對話紀錄', 'true'],
		['畫面', 'false'],
		['操作紀錄', 'false']
	]);
	await openScreen();
	const look = await tab.eval<{ text: string; colours: string[]; fontSize: string; status: boolean }>(`(() => {
		const pre = document.querySelector('.screen-panel pre');
		return { text: pre.innerText, colours: [...pre.querySelectorAll('span[style]')].map((span) => getComputedStyle(span).color), fontSize: getComputedStyle(pre).fontSize, status: !!document.querySelector('.screen-panel .state') };
	})()`);
	expect(look.text).toContain('❯ 1. Yes');
	expect(look.text).toContain('3. No, and tell Claude');
	// 256-colour 4 is xterm's blue; 33 its yellow.
	expect(look.colours).toContain('rgb(36, 114, 200)');
	expect(look.colours).toContain('rgb(229, 229, 16)');
	expect(look.fontSize).toBe('16px');
	// All is well: nothing is said about it.
	expect(look.status).toBe(false);
	expect(await tab.eval(`document.querySelector('.detail').innerText.includes('即時')`)).toBe(false);
	expect(await tab.eval(`document.querySelectorAll('.screen-panel .round, .screen-panel [role=toolbar]').length`)).toBe(0);
	// Text can be selected.
	expect(await tab.eval(`getComputedStyle(document.querySelector('.screen-panel pre')).userSelect`)).not.toBe('none');
	await shot('desktop-screen-tab');

	// A narrow window on a computer is still a computer: no 按鍵選單, the screen scrolls inside its box.
	await tab.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 800, deviceScaleFactor: 1, mobile: false });
	await sleep(300);
	expect(await tab.eval(`document.querySelectorAll('.screen-panel .round, .screen-panel [role=toolbar]').length`)).toBe(0);
	const box = await tab.eval<{ scroll: number; client: number; page: number; viewport: number }>(`(() => { const box = document.querySelector('.screen-panel .scroller'); return { scroll: box.scrollWidth, client: box.clientWidth, page: document.documentElement.scrollWidth, viewport: innerWidth }; })()`);
	expect(box.scroll).toBeGreaterThan(box.client);
	expect(box.page).toBeLessThanOrEqual(box.viewport);
	await shot('desktop-narrow-no-menu');
});

test('phone: a round button only on the 畫面 tab opens every key; taps go in order and the panel stays open, opened or not as this device left it', async () => {
	await visit({ width: 390, height: 844, phone: true });
	await tab.until(`[...document.querySelectorAll('.detail [role=tab]')].length === 3`, 'the tabs');
	expect(await tab.eval(`!!document.querySelector('.screen-panel .round')?.checkVisibility()`)).toBe(false);
	await openScreen();
	await tab.until(`!!${ROUND}`, 'the round button');
	expect(await tab.eval(`${MENU} === null`)).toBe(true);
	await shot('phone-screen-tab-round');
	await openMenu();
	await tab.until(`${KEYS}.every((button) => !button.disabled)`, 'the keys enabled');
	expect(await tab.eval<string[]>(`${KEYS}.map((button) => button.innerText)`)).toEqual(['Enter', 'Esc', 'Tab', 'Ctrl+C', 'Shift+Tab', '↑', '←', '↓', '→', '1', '2', '3', '4']);
	await shot('phone-screen-tab-menu');

	await press('↓');
	await press('2');
	await press('Enter');
	const deadline = Date.now() + 5_000;
	while (herdrCalls().length < 3 && Date.now() < deadline) await sleep(50);
	expect(herdrCalls()).toEqual([
		['pane', 'send-keys', PANE, 'down'],
		['pane', 'send-text', PANE, '2'],
		['pane', 'send-keys', PANE, 'enter']
	]);
	expect(await tab.eval(`${MENU} !== null`)).toBe(true);

	// This device remembers it open; closed, it remembers that too.
	await tab.eval(`location.reload()`);
	await sleep(500);
	await tab.until(`JSON.stringify(history.state).includes('depth')`, 'the board again');
	await openScreen();
	await tab.until(`${KEYS}.length === 13`, 'the panel still open');
	await tab.eval(`document.querySelector('.screen-panel .close').click()`);
	await tab.until(`!!${ROUND}`, 'the round button again');
	await tab.eval(`location.reload()`);
	await sleep(500);
	await tab.until(`JSON.stringify(history.state).includes('depth')`, 'the board again');
	await openScreen();
	await tab.until(`!!${ROUND}`, 'the round button after a reload');
	expect(await tab.eval(`${MENU} === null`)).toBe(true);

	// Another tab: the menu goes.
	await tab.eval(`[...document.querySelectorAll('.detail [role=tab]')].find((tab) => tab.firstChild.textContent.trim() === '對話紀錄').click()`);
	await tab.until(`!document.querySelector('.screen-panel .round')?.checkVisibility()`, 'the menu gone');
	// A phone on its side keeps it, and all of it is in the box.
	await tab.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
	await tab.eval(`[...document.querySelectorAll('.detail [role=tab]')].find((tab) => tab.firstChild.textContent.trim() === '畫面').click()`);
	await openMenu();
	const landscape = await tab.eval<{ top: number; boxTop: number }>(`(() => { const panel = ${MENU}.getBoundingClientRect(); return { top: panel.top, boxTop: document.querySelector('.screen-panel .box').getBoundingClientRect().top }; })()`);
	expect(landscape.top).toBeGreaterThanOrEqual(landscape.boxTop);
	await shot('phone-landscape-menu');
});

test('phone: a press that fails empties the queue and disables the keys until the screen is read again; nothing is sent again', async () => {
	await visit({ width: 390, height: 844, phone: true });
	await openScreen();
	await openMenu();
	await tab.until(`${KEYS}.every((button) => !button.disabled)`, 'the keys enabled');
	// The key fails, and Herdr cannot be read for a while: the keys stay disabled.
	setHerdr({ fail: { 'pane send-keys': { exit: 1, stderr: JSON.stringify({ error: { code: 'x', message: 'pane is busy' } }) }, 'pane read': { exit: 1, stderr: 'herdr is down' } } });
	await press('Esc');
	await tab.until(`document.querySelector('.dock')?.innerText.includes('按鍵可能沒送到，請看畫面確認')`, 'the notice');
	await tab.until(`${KEYS}.every((button) => button.disabled)`, 'the keys disabled');
	await shot('phone-key-failed-disabled');
	await sleep(1_500);
	expect(await keysEnabled()).toBe(false);
	// Why reading the screen again fails is shown too.
	const state = await tab.eval<string>(`document.querySelector('.screen-panel .state').innerText`);
	expect(state).toContain('按鍵可能沒送到');
	expect(state).toContain('herdr is down');
	// Herdr answers again with the same screen: the 恢復畫面 lets keys go again.
	setHerdr();
	await tab.until(`${KEYS}.every((button) => !button.disabled)`, 'the keys enabled again');
	expect(herdrCalls()).toEqual([['pane', 'send-keys', PANE, 'esc']]);
	await shot('phone-key-recovered');
});

test('a screen that cannot be read says why, and the keys stay disabled', async () => {
	setHerdr({ screens: {} });
	await visit({ width: 390, height: 844, phone: true });
	await openScreen().catch(() => {});
	await tab.until(`document.querySelector('.screen-panel .state')?.innerText.includes('讀不到它的 Herdr 畫面')`, 'the reason');
	await openMenu();
	await tab.until(`${KEYS}.every((button) => button.disabled)`, 'the keys disabled');
	await shot('phone-screen-unreadable');
});

test("a closed agent's 畫面 tab says it must be brought back first", async () => {
	await visit({ width: 1280, height: 800, phone: false, agent: 's-gone' });
	await tab.until(`!!document.querySelector('.detail [data-closed-agent]')`, "the closed agent's page");
	expect(await tab.eval(TABS)).toEqual([
		['對話紀錄', 'true'],
		['畫面', 'false']
	]);
	await tab.eval(`[...document.querySelectorAll('.detail [role=tab]')].find((tab) => tab.firstChild.textContent.trim() === '畫面').click()`);
	await tab.until(`document.querySelector('.detail [role=tabpanel]:not([hidden])')?.innerText.includes('已關閉，先接回才能看畫面')`, 'the closed text');
	expect(jsonLines(join(fixture.dir, 'herdr-list-calls.jsonl')).some((args: string[]) => args[1] === 'get' && args[2] === 'wA:p-s-gone')).toBe(false);
	await shot('desktop-closed-agent-screen');
});

test('after the connection drops and comes back, the tab shows the latest screen by itself', async () => {
	await visit({ width: 1280, height: 800, phone: false });
	await openScreen();
	await fixture.stop();
	setHerdr({ screens: { [PANE]: ['$ back after the drop'] } });
	await fixture.start();
	await tab.until(`document.querySelector('.screen-panel pre')?.innerText.includes('back after the drop')`, 'the latest screen', 20_000);
	await shot('desktop-after-reconnect');
}, 40_000);

test('phone: a press made offline stays refused after the connection comes back, until the server takes its recovery request and reads the screen again', async () => {
	await visit({ width: 390, height: 844, phone: true });
	await openScreen();
	await openMenu();
	await tab.until(`${KEYS}.every((button) => !button.disabled)`, 'the keys enabled');
	const offline = (on: boolean) => tab.send('Network.emulateNetworkConditions', { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
	await offline(true);
	await press('Esc');
	await tab.until(`document.querySelector('.dock')?.innerText.includes('按鍵可能沒送到，請看畫面確認')`, 'the notice');
	await tab.until(`${KEYS}.every((button) => button.disabled)`, 'the keys disabled');
	// The panel goes and comes back, as a reconnect may make it: the press still waits.
	await tab.eval(`[...document.querySelectorAll('.detail [role=tab]')].find((tab) => tab.firstChild.textContent.trim() === '對話紀錄').click()`);
	await tab.until(`!document.querySelector('.screen-panel')?.hasAttribute('data-status')`, 'the panel closed');
	await tab.eval(`[...document.querySelectorAll('.detail [role=tab]')].find((tab) => tab.firstChild.textContent.trim() === '畫面').click()`);
	// Back online, but the recovery request does not get through yet: the screen comes back, the keys stay refused.
	await tab.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/agents/screen/recover*' }] });
	await offline(false);
	const failing = setInterval(() => {
		for (const id of tab.paused.splice(0)) void tab.send('Fetch.failRequest', { requestId: id, errorReason: 'ConnectionRefused' }).catch(() => {});
	}, 50);
	try {
		await tab.until(`document.querySelector('.screen-panel .state')?.innerText.includes('按鍵可能沒送到') && !!document.querySelector('.screen-panel pre')`, 'the screen back while waiting', 15_000);
		await sleep(3_000);
		expect(await keysEnabled()).toBe(false);
	} finally {
		clearInterval(failing);
	}
	await tab.send('Fetch.disable');
	// It gets through now: the server reads the screen again, and that 恢復畫面 lets keys go. Nothing was sent.
	await tab.until(`${KEYS}.every((button) => !button.disabled)`, 'the keys enabled again', 10_000);
	expect(herdrCalls()).toEqual([]);
	await shot('phone-offline-press-recovered');
}, 40_000);
