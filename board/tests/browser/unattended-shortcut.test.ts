// The 無人模式 button of a controller page's button row (#655), in a real browser on one built board
// with the real helper and lat-unattended: it sits left of 關閉 Agent on a controller's page and not
// on an ordinary agent's, says the mode, opens the options menu's 無人模式 part, whose 開啟無人模式…
// opens the form (確認開啟 grants) and 關掉無人模式 goes back to manual. At 1400 and 390 wide the row
// stays on one line without scrolling sideways and each button is 44px high. With LAT_BOARD_SHOTS
// set, every look is saved there. Skipped when the host has no Chrome.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { startFixture, uvPython, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, shot, type Browser, type Tab } from '../browser.ts';
import type { HelperController } from '../../src/lib/board/types.ts';

const SESSION = 's-luna';
const herdrAgent = (session: string) => ({ agent: 'claude', agent_session: { kind: 'id', value: session }, agent_status: 'idle', cwd: `/home/someone/${session}`, pane_id: `wA:p-${session}`, tab_id: `wA:t-${session}`, workspace_id: 'wA' });
const hcomAgent = (name: string, session: string) => ({ name, session_id: session, status: 'listening', launch_context: { pane_id: `wA:p-${session}` } });
const ROW = '.detail section.controls .actions';
const TOGGLE = `${ROW} button[data-action="unattended"]`;
const MENU = `${ROW} .shortcut .popup [aria-label="無人模式"]`;
const DRAWER = '[aria-labelledby="unattended-form-title"]';
const MARK = `(document.querySelector('[data-controller="luna"] .unattended')?.innerText ?? '')`;
const button = (scope: string, label: string) => `[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => b.innerText.replace(/\\s+/g, '') === ${JSON.stringify(label)} && b.offsetParent !== null)`;
/** The row's buttons as [label, left, top, height], in page order. */
const ROW_BUTTONS = `[...document.querySelectorAll('${ROW} > button, ${ROW} > .shortcut > button')].map((b) => { const r = b.getBoundingClientRect(); return { label: b.innerText.replace(/\s+/g, '') || b.getAttribute('aria-label'), left: r.left, top: r.top, height: r.height, width: r.width, font: parseFloat(getComputedStyle(b).fontSize), right: r.right }; })`;

let fixture: Fixture;
let cookie: string;
let config: string;
let luna: HelperController;
let browser: Browser | undefined;
const errors: string[] = [];

beforeAll(async () => {
	if (!CHROME) return;
	config = mkdtempSync(join(tmpdir(), 'lat-board-unattended-shortcut-'));
	fixture = await startFixture({ env: { XDG_CONFIG_HOME: config } });
	luna = fixture.bound('alpha', 'luna', { session_id: SESSION });
	spawnSync('git', ['init', '-q', '-b', 'dev', luna.workspace]);
	mkdirSync(join(luna.workspace, '.lat/sessions'), { recursive: true });
	writeFileSync(join(luna.workspace, `.lat/sessions/${luna.session_id}.json`), JSON.stringify({ status: 'active', history: [] }));
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', `${SESSION}.jsonl`), JSON.stringify({ kind: 'user', time: null, text: '請開始。' }) + '\n');
	fixture.setHelper({ output: { controllers: [luna] }, realUnattended: uvPython(), realPreauth: uvPython() });
	fixture.setHcom({ agents: [hcomAgent('luna', SESSION), hcomAgent('plain', 's-plain')] });
	const agents = [herdrAgent(SESSION), herdrAgent('s-plain')];
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents,
			panes: agents.map((agent) => ({ pane_id: agent.pane_id, workspace_id: 'wA', cwd: agent.cwd })),
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
			tabs: agents.map((agent) => ({ tab_id: agent.tab_id, workspace_id: 'wA', label: `分頁-${agent.agent_session.value}` }))
		})
	);
	cookie = await fixture.login('unattended-shortcut');
	await fixture.refresh(cookie);
}, 30_000);

afterEach(async () => {
	await browser?.close();
	browser = undefined;
});
afterAll(async () => {
	await fixture?.cleanup();
	if (config) rmSync(config, { recursive: true, force: true });
});

async function visit(width: number, session = SESSION): Promise<Tab> {
	browser = await launchChrome({});
	const tab = browser.tab;
	tab.screen = `({ row: document.querySelector('${ROW}')?.innerText, drawer: document.querySelector('${DRAWER}')?.innerText.slice(0, 300), toasts: document.querySelector('.dock')?.innerText })`;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 761 });
	await tab.send('Page.navigate', { url: `${fixture.url}/?agent=${session}` });
	await tab.until(`!!document.querySelector('${ROW} button[data-action="close"]')`, 'the close button');
	// Started: the board's first history write is done, so its buttons work.
	await tab.until(`JSON.stringify(history.state).includes('depth')`, 'the board to start');
	return tab;
}

/** The row stays on one line, in the order 無人模式, then the close, inside the window, every button 44px high. */
async function expectRow(tab: Tab, width: number) {
	const buttons = await tab.eval<{ label: string; left: number; top: number; height: number; width: number; font: number; right: number }[]>(ROW_BUTTONS);
	const labels = buttons.map((b) => b.label);
	expect(labels.slice(0, 2)).toEqual([expect.stringMatching(/^(手動|無人)$/), '關閉 Agent']);
	// One line at the acceptance width (390 and up); below it a wrap to a second row is allowed.
	if (width >= 390) {
		expect(new Set(buttons.map((b) => Math.round(b.top))).size).toBe(1);
		expect(buttons[0].right).toBeLessThanOrEqual(buttons[1].left);
	}
	expect(Math.max(...buttons.map((b) => b.right))).toBeLessThanOrEqual(width);
	expect(buttons.filter((b) => b.height < 44 || b.width < 44).map((b) => `${b.label} ${b.width}x${b.height}`)).toEqual([]);
	// The text is at least 16px (ui-baseline); the icon-only button has none.
	expect(buttons.filter((b) => b.font < 16).map((b) => `${b.label} ${b.font}px`)).toEqual([]);
	expect(await tab.eval(`document.scrollingElement.scrollWidth <= innerWidth`)).toBe(true);
}

for (const width of [1400, 390, 360]) {
	test.skipIf(!CHROME)(`${width}px: the button is left of 關閉 Agent on a controller's page, opens the form, and 關掉無人模式 goes back`, async () => {
		const tab = await visit(width);
		await tab.until(`${button(ROW, '手動')} !== undefined`, 'manual on the button');
		await shot(tab, `${width}-shortcut-manual`);
		await expectRow(tab, width);

		await tab.eval(`${button(ROW, '手動')}.click()`);
		await tab.until(`document.querySelector('${MENU}')?.innerText.includes('現在：人工確認')`, 'the menu in manual');
		expect(await tab.eval(`document.scrollingElement.scrollWidth <= innerWidth`)).toBe(true);
		const popup = await tab.eval<{ left: number; right: number }>(`(() => { const r = document.querySelector('${ROW} .shortcut .popup').getBoundingClientRect(); return { left: r.left, right: r.right }; })()`);
		expect(popup.left).toBeGreaterThanOrEqual(0);
		expect(popup.right).toBeLessThanOrEqual(width);
		await shot(tab, `${width}-shortcut-menu-manual`);
		await tab.eval(`${button(MENU, '開啟無人模式…')}.click()`);
		await tab.until(`!!document.querySelector('${DRAWER} input[type="text"]') && !document.querySelector('${MENU}')`, 'the form, the menu closed');
		await tab.eval(`(() => { const box = document.querySelector('${DRAWER} input[type="text"]'); box.value = '改好 #655'; box.dispatchEvent(new Event('input', { bubbles: true })); const done = document.querySelector('${DRAWER} textarea'); done.value = '#655 合併'; done.dispatchEvent(new Event('input', { bubbles: true })); })()`);
		await tab.eval(`${button(DRAWER, '確認開啟')}.click()`);
		await tab.until(`!document.querySelector('${DRAWER}') && ${button(ROW, '無人')} !== undefined`, 'the button says on');
		await expectRow(tab, width);
		await shot(tab, `${width}-shortcut-unattended`);

		await tab.eval(`${button(ROW, '無人')}.click()`);
		await tab.until(`!!${button(MENU, '關掉無人模式')}`, 'the menu in unattended');
		await shot(tab, `${width}-shortcut-menu-unattended`);
		await tab.eval(`${button(MENU, '關掉無人模式')}.click()`);
		await tab.until(`${button(ROW, '手動')} !== undefined && !document.querySelector('${MENU}')`, 'back to manual');
		expect(await tab.eval(MARK)).toBe('');
	}, 60_000);
}

test.skipIf(!CHROME)("an ordinary agent's page has no 無人模式 button, and Escape or a tap elsewhere closes the menu", async () => {
	const plain = await visit(1400, 's-plain');
	expect(await plain.eval(`!!document.querySelector('${TOGGLE}')`)).toBe(false);
	await browser?.close();
	const tab = await visit(1400);
	await tab.eval(`document.querySelector('${TOGGLE}').click()`);
	await tab.until(`!!document.querySelector('${MENU}')`, 'the menu');
	await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
	await tab.until(`!document.querySelector('${MENU}')`, 'closed by Escape');
	await tab.eval(`document.querySelector('${TOGGLE}').click()`);
	await tab.until(`!!document.querySelector('${MENU}')`, 'the menu again');
	await tab.eval(`document.querySelector('.detail .profile').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
	await tab.until(`!document.querySelector('${MENU}')`, 'closed by a tap elsewhere');
});
