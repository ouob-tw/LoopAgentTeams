// A computer's direct operation on the 終端分頁 in a real browser: headless Chrome with a mouse that
// can hover on the built board with fake Herdr and hcom. A click on the screen draws a line along its top and keys
// pressed go into the pane in order (the six escape-sequence keys as text), Esc staying in it; a
// click elsewhere leaves. The ⋯ menu's 組合鍵 send to the pane on screen; a phone has none.
// `SCREEN_TAB_SHOTS` names a folder to save each step's screenshot in.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { jsonLines, sleep, startFixture, type Fixture } from '../harness.ts';
import { launchChrome, type Browser, type Tab } from '../browser.ts';

const SHOTS = process.env.SCREEN_TAB_SHOTS;
const ESC = '\x1b';
const PANE = 'wA:p-s-plain';
const SCREEN = [
	`${ESC}[38;5;4m╭──────────────────────────────────────────────╮${ESC}[0m`,
	`${ESC}[38;5;4m│${ESC}[0m > edit this line`,
	`${ESC}[38;5;4m╰──────────────────────────────────────────────╯${ESC}[0m`,
	`${ESC}[2m? for shortcuts${ESC}[0m`
].join('\r\n');
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
			panes: [{ pane_id: PANE, workspace_id: 'wA', cwd: agent.cwd, tab_id: agent.tab_id }],
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
			tabs: [{ tab_id: agent.tab_id, workspace_id: 'wA', label: '分頁-plain' }],
			screens: { [PANE]: [SCREEN] },
			...extra
		})
	);
}
const herdrCalls = (): string[][] => jsonLines(join(fixture.dir, 'herdr-calls.jsonl'));
async function callsReach(count: number) {
	const deadline = Date.now() + 5_000;
	while (herdrCalls().length < count && Date.now() < deadline) await sleep(50);
}

beforeAll(async () => {
	fixture = await startFixture({ env: { LAT_BOARD_HERDR_TIMEOUT_SECONDS: '2' } });
	cookie = await fixture.login('screen-direct');
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', 's-plain.jsonl'), JSON.stringify({ kind: 'user', time: new Date().toISOString(), text: '改一下這行' }) + '\n');
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

async function visit({ phone = false, width = 1280, height = 800, screen = true, scripts = [] }: { phone?: boolean; width?: number; height?: number; screen?: boolean; scripts?: string[] } = {}) {
	browser = await launchChrome({ scripts, screen: `document.querySelector('.detail')?.innerText ?? ''`, args: phone ? [] : [MOUSE] });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: phone });
	if (phone) await tab.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
	await tab.send('Page.navigate', { url: `${fixture.url}/?agent=s-plain` });
	await tab.until(`JSON.stringify(history.state).includes('depth')`, 'the board to start');
	await tab.until(`[...document.querySelectorAll('.detail [role=tab]')].length === 3`, 'the tabs');
	await tab.eval(`[...document.querySelectorAll('.detail [role=tab]')].find((tab) => tab.firstChild.textContent.trim() === '終端').click()`);
	await tab.until(screen ? `!!document.querySelector('.screen-panel pre')` : `!!document.querySelector('.screen-panel .box')`, 'the screen');
	// Whether the page let each key press do what the browser does with it.
	await tab.eval(`window.prevented = []; addEventListener('keydown', (event) => prevented.push([event.key, event.defaultPrevented]))`);
}
async function shot(name: string) {
	if (!SHOTS) return;
	const { data } = (await tab.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
	writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
}

const MODIFIER = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;
/** One key pressed and let go, as Chrome gets it from the keyboard. */
async function key(name: string, { code = '', vk = 0, text, modifiers = [] }: { code?: string; vk?: number; text?: string; modifiers?: (keyof typeof MODIFIER)[] } = {}) {
	const bits = modifiers.reduce((sum, modifier) => sum + MODIFIER[modifier], 0);
	await tab.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: name, code, windowsVirtualKeyCode: vk, modifiers: bits, ...(text && { text, unmodifiedText: text }) });
	await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: vk, modifiers: bits });
}
const look = () =>
	tab.eval<{ direct: boolean; box: number[]; pre: number[]; focus: string }>(`(() => {
		const box = document.querySelector('.screen-panel .box');
		const rect = (el) => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round); };
		return { direct: box.classList.contains('direct'), box: rect(box), pre: rect(box.querySelector('pre')), focus: document.activeElement?.className ?? '' };
	})()`);

test('computer: a click draws the top line and colours the tab, and keys go into the pane in order, Esc and Tab staying in it; a click elsewhere leaves', async () => {
	await visit();
	const before = await look();
	expect(before.direct).toBe(false);
	const tabLook = () => tab.eval<string>(`(() => { const b = document.querySelector('[data-tab=screen]'); const r = b.getBoundingClientRect(); return [getComputedStyle(b).color, ...[r.x, r.y, r.width, r.height].map(Math.round)].join(); })()`);
	const tabBefore = await tabLook();
	await shot('desktop-direct-before');

	await tab.pointerClick('.screen-panel .box pre');
	await tab.until(`document.querySelector('.screen-panel .box').classList.contains('direct')`, 'direct operation');
	const during = await look();
	expect(during.focus).toContain('catcher');
	// The line moves nothing: the box and its text stay where they were.
	expect(during.box).toEqual(before.box);
	expect(during.pre).toEqual(before.pre);
	// A thin line along the top in the accent colour, and the 終端 tab in it too; nothing around the screen.
	const line = await tab.eval<{ height: string; background: string; accent: string; label: string; border: string }>(`(() => {
		const after = getComputedStyle(document.querySelector('.screen-panel .box'), '::after');
		const probe = document.createElement('i'); probe.style.color = 'var(--accent)'; document.body.append(probe);
		const accent = getComputedStyle(probe).color; probe.remove();
		return { height: after.height, background: after.backgroundColor, accent, label: getComputedStyle(document.querySelector('[data-tab=screen]')).color, border: getComputedStyle(document.querySelector('.screen-panel .box')).borderTopWidth };
	})()`);
	expect(line.height).toBe('2px');
	expect(line.background).toBe(line.accent);
	expect(line.label).toBe(line.accent);
	expect(line.border).toBe('0px');
	expect(await tab.eval(`!!document.querySelector('.page.screen-direct')`)).toBe(true);
	// The tab changes colour only: it does not move.
	expect((await tabLook()).split(',').slice(-4)).toEqual(tabBefore.split(',').slice(-4));
	await shot('desktop-direct-during');
	if (SHOTS) {
		await tab.eval(`document.documentElement.dataset.theme = 'light'`);
		await shot('desktop-direct-during-light');
		await tab.eval(`document.documentElement.dataset.theme = 'dark'`);
	}

	await key('a', { code: 'KeyA', vk: 65, text: 'a' });
	await key(' ', { code: 'Space', vk: 32, text: ' ' });
	await key('B', { code: 'KeyB', vk: 66, text: 'B', modifiers: ['shift'] });
	await key('Enter', { code: 'Enter', vk: 13, text: '\r' });
	await key('Escape', { code: 'Escape', vk: 27 });
	await key('Tab', { code: 'Tab', vk: 9 });
	await key('Tab', { code: 'Tab', vk: 9, modifiers: ['shift'] });
	await key('Backspace', { code: 'Backspace', vk: 8 });
	await key('ArrowUp', { code: 'ArrowUp', vk: 38 });
	await key('ArrowRight', { code: 'ArrowRight', vk: 39 });
	await key('c', { code: 'KeyC', vk: 67, modifiers: ['ctrl'] });
	await key('x', { code: 'KeyX', vk: 88, modifiers: ['alt'] });
	await key('Home', { code: 'Home', vk: 36 });
	await key('End', { code: 'End', vk: 35 });
	await key('Insert', { code: 'Insert', vk: 45 });
	await key('Delete', { code: 'Delete', vk: 46 });
	await key('PageUp', { code: 'PageUp', vk: 33 });
	await key('PageDown', { code: 'PageDown', vk: 34 });
	await callsReach(18);
	expect(herdrCalls()).toEqual([
		['pane', 'send-text', PANE, 'a'],
		['pane', 'send-text', PANE, ' '],
		['pane', 'send-text', PANE, 'B'],
		['pane', 'send-keys', PANE, 'enter'],
		['pane', 'send-keys', PANE, 'esc'],
		['pane', 'send-keys', PANE, 'tab'],
		['pane', 'send-keys', PANE, 'shift+tab'],
		['pane', 'send-keys', PANE, 'backspace'],
		['pane', 'send-keys', PANE, 'up'],
		['pane', 'send-keys', PANE, 'right'],
		['pane', 'send-keys', PANE, 'ctrl+c'],
		['pane', 'send-keys', PANE, 'alt+x'],
		['pane', 'send-text', PANE, `${ESC}[H`],
		['pane', 'send-text', PANE, `${ESC}[F`],
		['pane', 'send-text', PANE, `${ESC}[2~`],
		['pane', 'send-text', PANE, `${ESC}[3~`],
		['pane', 'send-text', PANE, `${ESC}[5~`],
		['pane', 'send-text', PANE, `${ESC}[6~`]
	]);
	// Esc, Tab and Shift+Tab kept the focus: still in direct operation. The browser did nothing with any key.
	expect((await look()).direct).toBe(true);
	const prevented = await tab.eval<[string, boolean][]>(`prevented`);
	expect(prevented.filter(([, done]) => !done)).toEqual([]);
	expect(prevented.map(([name]) => name)).toContain('Backspace');

	// A key with nothing to send: a short notice, nothing sent.
	await key('F13', { code: 'F13', vk: 124 });
	await tab.until(`document.querySelector('.dock')?.innerText.includes('這個鍵目前送不出')`, 'the notice');
	await sleep(300);
	expect(herdrCalls()).toHaveLength(18);
	await shot('desktop-direct-unsupported');

	// A click elsewhere leaves; keys then go nowhere.
	await tab.pointerClick('.detail .bar b');
	await tab.until(`!document.querySelector('.screen-panel .box').classList.contains('direct')`, 'direct operation left');
	expect(await tabLook()).toBe(tabBefore);
	expect(await tab.eval(`!!document.querySelector('.page.screen-direct')`)).toBe(false);
	const after = await look();
	expect(after.box).toEqual(before.box);
	await key('z', { code: 'KeyZ', vk: 90, text: 'z' });
	await sleep(300);
	expect(herdrCalls()).toHaveLength(18);
	await shot('desktop-direct-after');

	// The operation record names the keys, never the text.
	await tab.eval(`[...document.querySelectorAll('.detail [role=tab]')].find((tab) => tab.firstChild.textContent.trim() === '操作紀錄').click()`);
	await tab.until(`document.querySelector('.detail [role=tabpanel]:not([hidden])')?.innerText.includes('Home')`, 'the record');
	const record = await tab.eval<string>(`document.querySelector('.detail [role=tabpanel]:not([hidden])').innerText`);
	expect(record).toContain('PageDown');
	expect(record).not.toContain('[H');
});

test('computer: an input method composes without sending; only the text it ends with goes', async () => {
	await visit();
	await tab.pointerClick('.screen-panel .box pre');
	await tab.until(`document.querySelector('.screen-panel .box').classList.contains('direct')`, 'direct operation');
	await tab.send('Input.imeSetComposition', { text: 'ㄋㄧˇ', selectionStart: 3, selectionEnd: 3 });
	await key('Process', { code: 'KeyS', vk: 229 });
	await sleep(400);
	expect(herdrCalls()).toEqual([]);
	await tab.send('Input.insertText', { text: '你' });
	await callsReach(1);
	await sleep(300);
	expect(herdrCalls()).toEqual([['pane', 'send-text', PANE, '你']]);
});

test('computer: dragging over the text selects it without starting direct operation, and ends one under way', async () => {
	await visit();
	const drag = async () => {
		const { x, y, right } = await tab.eval<{ x: number; y: number; right: number }>(`(() => { const r = document.createRange(); r.selectNodeContents([...document.querySelectorAll('.screen-panel pre span')].find((span) => span.textContent.includes('edit this line'))); const box = r.getBoundingClientRect(); getSelection().removeAllRanges(); return { x: box.x + 2, y: box.y + box.height / 2, right: box.right - 2 }; })()`);
		await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
		await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: right, y, button: 'left', buttons: 1 });
		await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: right, y, button: 'left', clickCount: 1 });
	};
	const state = () => tab.eval<{ direct: boolean; selected: string }>(`({ direct: document.querySelector('.screen-panel .box').classList.contains('direct'), selected: getSelection().toString() })`);
	await drag();
	await sleep(200);
	expect(await state()).toEqual({ direct: false, selected: expect.stringContaining('edit this line') });
	await key('a', { code: 'KeyA', vk: 65, text: 'a' });
	// In direct operation, a drag ends it and leaves the text selected.
	await tab.pointerClick('.screen-panel .box pre');
	await tab.until(`document.querySelector('.screen-panel .box').classList.contains('direct')`, 'direct operation');
	await drag();
	await sleep(200);
	expect(await state()).toEqual({ direct: false, selected: expect.stringContaining('edit this line') });
	await key('b', { code: 'KeyB', vk: 66, text: 'b' });
	await sleep(300);
	expect(herdrCalls()).toEqual([]);
});

test('computer: a key that fails stops the keys typed after it until the screen is read again; nothing is sent again', async () => {
	await visit();
	await tab.pointerClick('.screen-panel .box pre');
	await tab.until(`document.querySelector('.screen-panel .box').classList.contains('direct')`, 'direct operation');
	setHerdr({ fail: { 'pane send-keys': { exit: 1, stderr: JSON.stringify({ error: { code: 'x', message: 'pane is busy' } }) }, 'pane read': { exit: 1, stderr: 'herdr is down' } } });
	await key('Escape', { code: 'Escape', vk: 27 });
	await tab.until(`document.querySelector('.dock')?.innerText.includes('按鍵可能沒送到，請看畫面確認')`, 'the notice');
	await key('q', { code: 'KeyQ', vk: 81, text: 'q' });
	await sleep(800);
	expect(herdrCalls()).toEqual([['pane', 'send-keys', PANE, 'esc']]);
	setHerdr();
	await tab.until(`document.querySelector('.screen-panel')?.dataset.status === 'live'`, 'the 恢復畫面');
	await key('w', { code: 'KeyW', vk: 87, text: 'w' });
	await callsReach(2);
	expect(herdrCalls()).toEqual([
		['pane', 'send-keys', PANE, 'esc'],
		['pane', 'send-text', PANE, 'w']
	]);
});

/** Count the 終端分頁 streams a page opens. */
const COUNT_STREAMS = `(() => {
	window.screenStreams = 0;
	const Real = window.EventSource;
	window.EventSource = class extends Real {
		constructor(url, options) {
			super(url, options);
			if (String(url).includes('/api/agents/screen/events')) window.screenStreams += 1;
		}
	};
})()`;

test('computer: a key pressed before the first screen comes is typed in, not dropped', async () => {
	// A board of its own that waits 60 s for Herdr, whose first read takes 30 s: the page has no
	// screen yet while the key is pressed, however slow the host.
	const shared = { fixture, cookie };
	fixture = await startFixture({ env: { LAT_BOARD_HERDR_TIMEOUT_SECONDS: '60' } });
	try {
		cookie = await fixture.login('screen-direct-slow');
		mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
		fixture.setHcom({ agents: [] });
		setHerdr();
		await fixture.refresh(cookie);
		setHerdr({ slowMs: { 'pane read': 30_000 } });
		await visit({ screen: false });
		await tab.pointerClick('.screen-panel .box');
		await tab.until(`document.querySelector('.screen-panel .box').classList.contains('direct')`, 'direct operation');
		expect(await tab.eval(`document.querySelector('.screen-panel')?.dataset.status`)).toBe('loading');
		await key('a', { code: 'KeyA', vk: 65, text: 'a' });
		await callsReach(1);
		expect(herdrCalls()).toEqual([['pane', 'send-text', PANE, 'a']]);
	} finally {
		await browser?.close();
		browser = undefined;
		await fixture.cleanup();
		({ fixture, cookie } = shared);
	}
});

test('computer: the screen stream stays open while the board\'s lists change, so no key falls in a gap', async () => {
	await visit({ scripts: [COUNT_STREAMS] });
	expect(await tab.eval(`window.screenStreams`)).toBe(1);
	const before = await tab.eval<string>(`document.querySelector('.detail').innerText`);
	setHerdr({ agents: [{ agent: 'claude', agent_session: { kind: 'id', value: 's-plain' }, agent_status: 'working', cwd: '/home/someone/projects/s-plain', pane_id: PANE, tab_id: 'wA:t-s-plain', workspace_id: 'wA' }] });
	await fixture.refresh(cookie);
	await tab.until(`document.querySelector('.detail').innerText !== ${JSON.stringify(before)}`, 'the new lists on the page');
	await sleep(300);
	expect(await tab.eval(`window.screenStreams`)).toBe(1);
});

test('computer: a key refused while the screen cannot be read says why', async () => {
	setHerdr({ fail: { 'pane read': { exit: 1, stderr: 'herdr is down' } } });
	await visit({ screen: false });
	await tab.until(`document.querySelector('.screen-panel')?.dataset.status === 'failed'`, 'the failed read');
	await tab.pointerClick('.screen-panel .box');
	await tab.until(`document.querySelector('.screen-panel .box').classList.contains('direct')`, 'direct operation');
	await key('a', { code: 'KeyA', vk: 65, text: 'a' });
	await tab.until(`[...document.querySelectorAll('.toast')].some((toast) => toast.innerText.includes('herdr is down'))`, 'the notice');
	expect(herdrCalls()).toEqual([]);
});

test('computer: the ⋯ menu has 組合鍵 that go to the pane on screen, also with another recipient named; it leaves the input box clear', async () => {
	await visit();
	// With the agent's own permission section above it.
	await tab.pointerClick('.dock button.options');
	await tab.until(`!!document.querySelector('.popup [aria-label=組合鍵]')`, 'the 組合鍵');
	await shot('desktop-combo-menu-with-permission');
	await tab.pointerClick('.dock button.options');
	await tab.until(`!document.querySelector('.popup')`, 'the menu closed');
	// Another recipient named on the line: the 組合鍵 still go to the pane on screen.
	await tab.eval(`(() => { const box = document.querySelector('.dock textarea'); box.focus(); document.execCommand('insertText', false, '@someone hello'); })()`);
	await tab.pointerClick('.dock button.options');
	await tab.until(`!!document.querySelector('.popup [aria-label=組合鍵]')`, 'the 組合鍵');
	const menu = await tab.eval<{ labels: string[]; clear: boolean }>(`(() => {
		const popup = document.querySelector('.popup');
		return {
			labels: [...popup.querySelectorAll('[aria-label=組合鍵] button')].map((button) => button.innerText),
			clear: popup.getBoundingClientRect().bottom <= document.querySelector('.dock textarea').getBoundingClientRect().top
		};
	})()`);
	expect(menu.labels).toEqual(['Ctrl+W', 'Ctrl+T', 'Ctrl+N']);
	expect(menu.clear).toBe(true);
	await shot('desktop-combo-menu');
	await tab.eval(`[...document.querySelectorAll('.popup [aria-label=組合鍵] button')].find((button) => button.innerText === 'Ctrl+W').click()`);
	await tab.eval(`[...document.querySelectorAll('.popup [aria-label=組合鍵] button')].find((button) => button.innerText === 'Ctrl+N').click()`);
	await callsReach(2);
	expect(herdrCalls()).toEqual([
		['pane', 'send-keys', PANE, 'ctrl+w'],
		['pane', 'send-keys', PANE, 'ctrl+n']
	]);
	// Direct operation still works beside the command line; the menu, over the screen's lower part, closed first.
	await tab.pointerClick('.dock button.options');
	await tab.until(`!document.querySelector('.popup')`, 'the menu closed');
	await tab.pointerClick('.screen-panel .box pre');
	await tab.until(`document.querySelector('.screen-panel .box').classList.contains('direct')`, 'direct operation');
	await key('1', { code: 'Digit1', vk: 49, text: '1' });
	await callsReach(3);
	expect(herdrCalls().at(-1)).toEqual(['pane', 'send-text', PANE, '1']);
	expect(await tab.eval(`document.querySelector('.dock textarea').value`)).toBe('@someone hello');
});

test('phone: a tap on the screen starts no direct operation, and the ⋯ menu has no 組合鍵', async () => {
	await visit({ phone: true, width: 390, height: 844 });
	await tab.pointerClick('.screen-panel .box pre');
	await sleep(300);
	expect(await tab.eval(`document.querySelectorAll('.screen-panel .box.direct, .screen-panel .catcher').length`)).toBe(0);
	await tab.pointerClick('.dock button.options');
	await tab.until(`!!document.querySelector('.popup')`, 'the menu');
	expect(await tab.eval(`document.querySelectorAll('.popup [aria-label=組合鍵]').length`)).toBe(0);
	await shot('phone-menu-no-combos');
});
