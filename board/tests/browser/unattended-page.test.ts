// Unattended mode in two real browsers on one built board, the real helper and lat-unattended: the
// settings dialog's global and project settings, the options menu's 無人模式 part, the form drawer
// (cancel writes nothing, a blank goal cannot be sent, 確認開啟 grants), the status card's badge,
// goal line, details and 修改, the roster's 無人 mark, and 關掉, each reaching the other browser
// without a reload. At 1280 and 390 wide nothing scrolls sideways. With LAT_BOARD_SHOTS set, every
// look is saved there. Headless Chrome over its DevTools protocol; skipped when the host has no Chrome.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { sleep, startFixture, uvPython, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, shot, type Browser, type Tab } from '../browser.ts';
import type { HelperController } from '../../src/lib/board/types.ts';

const TOOL = join(import.meta.dirname, '../../../skills/local/lat/scripts/lat-unattended.py');
const WIDE = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };

const button = (scope: string, label: string) => `[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => b.innerText.trim() === ${JSON.stringify(label)} && b.offsetParent !== null)`;
const DIALOG = 'dialog[aria-labelledby="settings-title"]';
const OPEN_SETTINGS = `document.querySelector('${DIALOG}').open || [...document.querySelectorAll('[aria-label="設定"]')].find((b) => b.offsetParent !== null).click()`;
const GLOBAL = `${DIALOG} div[role="group"][aria-label="新主控一開始的模式"]`;
const GLOBAL_PRESSED = `[...document.querySelectorAll('${GLOBAL} button[aria-pressed="true"]')].map((b) => b.innerText).join()`;
const project = (name: string) => `${DIALOG} [data-project="${name}"]`;
const PROJECT_PRESSED = (name: string) => `document.querySelector('${project(name)} button[aria-pressed="true"]')?.innerText`;
const CARD = '.detail .profile .unattended';
const BADGE = `(document.querySelector('${CARD} .badge')?.innerText ?? '')`;
const MARK = `(document.querySelector('[data-controller="luna"] .unattended')?.innerText ?? '')`;
const MENU = '.cmd .popup [aria-label="無人模式"]';
const DRAWER = '[aria-labelledby="unattended-form-title"]';
const NO_SIDEWAYS = `document.scrollingElement.scrollWidth <= innerWidth`;

let fixture: Fixture;
let cookie: string;
let config: string;
let luna: HelperController;
let grantFile: string;
const browsers: Browser[] = [];

beforeAll(async () => {
	if (!CHROME) return;
	config = mkdtempSync(join(tmpdir(), 'lat-board-unattended-page-'));
	fixture = await startFixture({ env: { XDG_CONFIG_HOME: config } });
	luna = fixture.bound('alpha', 'luna');
	spawnSync('git', ['init', '-q', '-b', 'dev', luna.workspace]);
	mkdirSync(join(luna.workspace, '.lat/sessions'), { recursive: true });
	writeFileSync(join(luna.workspace, `.lat/sessions/${luna.session_id}.json`), JSON.stringify({ status: 'active', history: [] }));
	grantFile = join(luna.workspace, `.lat/unattended/${luna.session_id}-r1.json`);
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', `${luna.session_id}.jsonl`), JSON.stringify({ kind: 'user', time: null, text: '#577 的按鈕字改成「儲存」，#578 修錯字。我先睡了，明早 07:30 前做完。' }) + '\n');
	fixture.setHelper({ output: { controllers: [luna] }, realUnattended: uvPython(), realPreauth: uvPython() });
	cookie = await fixture.login('unattended-page');
	await fixture.refresh(cookie);
}, 30_000);

afterAll(async () => {
	for (const browser of browsers) await browser.close();
	await fixture?.cleanup();
	if (config) rmSync(config, { recursive: true, force: true });
});

/** The controller's own tool, as the controller runs it. */
function tool(...args: string[]) {
	const run = spawnSync(uvPython(), [TOOL, ...args, `--workspace=${luna.workspace}`, `--session-id=${luna.session_id}`], { encoding: 'utf8', env: fixture.serverEnv() });
	expect(run.status).toBe(0);
}

/** A new Chrome with a profile of its own, logged in, on the controller's page. */
async function browse(size = WIDE): Promise<Tab> {
	const browser = await launchChrome();
	browsers.push(browser);
	const tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', size);
	await tab.send('Page.navigate', { url: `${fixture.url}/?controller=${luna.session_id}` });
	await tab.until(`document.querySelector('.detail .profile h2')?.innerText === 'alpha'`, 'the controller page');
	return tab;
}

const save = (tab: Tab, name: string) => shot(tab, name);
/** Open the settings dialog, once the page has taken over its buttons. */
const openSettings = (tab: Tab) => tab.until(`(${OPEN_SETTINGS}, document.querySelector('${DIALOG}').open)`, 'the settings dialog');

test.skipIf(!CHROME)('the settings dialog sets the global mode, delegations, time limit and each project, on every open page', async () => {
	const a = await browse();
	const b = await browse();
	await openSettings(a);
	await a.until(`${GLOBAL_PRESSED} === '人工確認'`, 'the global mode read');
	expect(await a.eval(PROJECT_PRESSED('alpha'))).toBe('跟全局');
	await openSettings(b);
	await b.until(`${GLOBAL_PRESSED} === '人工確認'`, 'the global mode in the other browser');
	await save(a, '1280-settings-manual');

	await a.eval(`${button(GLOBAL, '無人模式')}.click()`);
	await a.until(`${GLOBAL_PRESSED} === '無人模式'`, 'the global mode saved');
	await b.until(`${GLOBAL_PRESSED} === '無人模式'`, 'the global mode in the other browser, without a reload');
	// A default start: the controller has written no goal, so it waits and holds no grant.
	await b.until(`${MARK} === '無人' && ${BADGE} === '無人模式（來自全域預設）'`, 'the roster mark and the badge');
	expect(await b.eval<string>(`document.querySelector('${CARD}').innerText`)).toContain('等主控擬目標');
	expect(await b.eval(`!!document.querySelector('${CARD} .summary')`)).toBe(false);
	await b.eval(`document.querySelector('${DIALOG}').close()`);
	await save(b, '1280-card-waiting-for-goal');
	await shot(b, '390-card-waiting-for-goal', { phone: true, back: WIDE });
	await openSettings(b);

	await a.eval(`document.querySelector('${DIALOG} input[type="checkbox"]').click()`);
	await a.eval(`(() => { const box = document.querySelector('${DIALOG} input[aria-label="時間上限（小時）"]'); box.value = '8'; box.dispatchEvent(new Event('input', { bubbles: true })); box.dispatchEvent(new Event('blur')); })()`);
	await a.until(`!document.querySelector('${DIALOG} input[type="checkbox"]').checked`, 'the delegation saved');
	const globalFile = join(config, 'lat/preauth.toml');
	for (let i = 0; i < 50 && !readFileSync(globalFile, 'utf8').includes('max_hours = 8'); i++) await sleep(100);
	expect(readFileSync(globalFile, 'utf8')).toMatch(/mode = "unattended"[\s\S]*ticket_confirmation = false[\s\S]*max_hours = 8/);
	await b.until(`!document.querySelector('${DIALOG} input[type="checkbox"]').checked && document.querySelector('${DIALOG} input[aria-label="時間上限（小時）"]').value === '8'`, 'the other browser');
	await save(a, '1280-settings-unattended');
	await shot(a, '390-settings-unattended', { phone: true, box: `${DIALOG} [aria-label="新主控一開始的模式"]`, back: WIDE });

	// The project's own mode wins over the global one.
	await a.eval(`${button(project('alpha'), '人工確認')}.click()`);
	await b.until(`${PROJECT_PRESSED('alpha')} === '人工確認'`, 'the project in the other browser');
	await b.until(`${MARK} === '' && ${BADGE} === ''`, 'the mark and badge gone');
	// After a reload too.
	await b.send('Page.reload');
	await b.until(`document.querySelector('.detail .profile h2')?.innerText === 'alpha'`, 'the page again');
	await openSettings(b);
	await b.until(`${GLOBAL_PRESSED} === '無人模式' && ${PROJECT_PRESSED('alpha')} === '人工確認'`, 'the settings after a reload');
	await a.eval(`${button(project('alpha'), '跟全局')}.click()`);
	await a.eval(`${button(GLOBAL, '人工確認')}.click()`);
	await a.until(`${GLOBAL_PRESSED} === '人工確認' && ${PROJECT_PRESSED('alpha')} === '跟全局'`, 'back to manual');
	for (const tab of [a, b]) await tab.eval(`document.querySelector('${DIALOG}').close()`);
}, 90_000);

test.skipIf(!CHROME)('the options menu opens the form; cancel writes nothing, a blank goal cannot be sent, 確認開啟 grants', async () => {
	const [a, b] = [browsers[0].tab, browsers[1].tab];
	tool('draft', '--goal=#577 按鈕字改「儲存」、#578 修錯字，明早 07:30 前做完', '--done=#577、#578 都合併進開發分支', '--done=測試全過');
	// The board reads the draft in when the file watch sees it.
	for (let tries = 0; ; tries++) {
		const read = (await fixture.board(cookie)).controllers.find((controller) => controller.id === luna.session_id)!.unattended;
		if ('draft' in read && read.draft) break;
		if (tries > 50) throw new Error('the draft never reached the board');
		await sleep(100);
	}
	await a.until(`${MARK} === ''`, 'manual');
	await a.eval(`document.querySelector('.cmd button[aria-label="選項"]').click()`);
	await a.until(`document.querySelector('${MENU}')?.innerText.includes('現在：人工確認（來自全域預設）')`, 'the mode in the menu');
	await save(a, '1280-menu-manual');
	await a.eval(`${button(MENU, '開啟無人模式…')}.click()`);
	await a.until(`!!document.querySelector('${DRAWER}')`, 'the drawer');
	await sleep(90);
	await save(a, '1280-drawer-sliding');
	await sleep(400);
	await save(a, '1280-drawer');
	// From the right edge, the full height.
	const rect = await a.eval<{ right: number; top: number; bottom: number; width: number }>(`(() => { const r = document.querySelector('${DRAWER}').getBoundingClientRect(); return { right: r.right, top: r.top, bottom: r.bottom, width: r.width }; })()`);
	expect(rect).toEqual({ right: 1280, top: 0, bottom: 800, width: 520 });
	expect(await a.eval(`document.querySelector('${DRAWER} input[type="text"]').value`)).toBe('#577 按鈕字改「儲存」、#578 修錯字，明早 07:30 前做完');
	expect(await a.eval(`document.querySelector('${DRAWER} textarea').value`)).toBe('#577、#578 都合併進開發分支\n測試全過');
	// The delegations and time limit from the settings: the first one is off there.
	expect(await a.eval(`[...document.querySelectorAll('${DRAWER} fieldset input[type="checkbox"]:not(:disabled)')].map((box) => box.checked).join()`)).toBe('false,true,true');
	expect(await a.eval(`document.querySelector('${DRAWER} input[type="number"]').value`)).toBe('8');

	await a.eval(`${button(DRAWER, '取消')}.click()`);
	await a.until(`!document.querySelector('${DRAWER}')`, 'the drawer closed');
	await sleep(500);
	expect(existsSync(grantFile)).toBe(false);

	await a.eval(`document.querySelector('.cmd button[aria-label="選項"]').click()`);
	await a.eval(`${button(MENU, '開啟無人模式…')}.click()`);
	await a.until(`!!document.querySelector('${DRAWER} input[type="text"]')`, 'the drawer again');
	await a.eval(`(() => { const box = document.querySelector('${DRAWER} input[type="text"]'); box.value = ' '; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
	await a.until(`document.querySelector('${DRAWER} button[type="submit"]').disabled`, 'the send button off');
	expect(await a.eval<string>(`document.querySelector('${DRAWER} .why').innerText`)).toContain('還沒寫這一輪的目標');
	await save(a, '1280-drawer-blank-goal');
	await a.eval(`(() => { const box = document.querySelector('${DRAWER} input[type="text"]'); box.value = '#577 按鈕字改「儲存」、#578 修錯字'; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
	await a.eval(`${button(DRAWER, '確認開啟')}.click()`);
	await a.until(`!document.querySelector('${DRAWER}') && ${BADGE} === '無人模式（來自這個主控）'`, 'the badge');
	await b.until(`${MARK} === '無人' && ${BADGE} === '無人模式（來自這個主控）'`, 'the mark and badge in the other browser');
	expect(JSON.parse(readFileSync(grantFile, 'utf8')).versions[0]).toMatchObject({ goal: '#577 按鈕字改「儲存」、#578 修錯字', source: 'board-form' });
	expect(await a.eval<string>(`document.querySelector('${CARD} .summary').innerText`)).toContain('條件 2 條');
	await save(a, '1280-card-collapsed');
}, 60_000);

test.skipIf(!CHROME)('the card opens to the goal, conditions, stop and layers; 修改 makes a new version shown at once', async () => {
	const [a, b] = [browsers[0].tab, browsers[1].tab];
	await a.eval(`document.querySelector('${CARD} .summary').click()`);
	await a.until(`!!document.querySelector('${CARD} .details')`, 'the details');
	const details = await a.eval<string>(`document.querySelector('${CARD} .details').innerText`);
	for (const part of ['做完的條件', '#577、#578 都合併進開發分支', '測試全過', '額度用完，或跑滿 8 小時', '全域預設 人工確認', '這個專案 沒有另外設', '這個主控 無人模式', '生效的是「這個主控」']) expect(details).toContain(part);
	await save(a, '1280-card-open');
	await a.eval(`${button(CARD, '修改')}.click()`);
	await a.until(`document.querySelector('${DRAWER} input[type="text"]')?.value === '#577 按鈕字改「儲存」、#578 修錯字'`, 'the form with the version in effect');
	await a.eval(`(() => { const box = document.querySelector('${DRAWER} textarea'); box.value = '#577、#578 都合併進開發分支'; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
	await a.eval(`${button(DRAWER, '送出修改')}.click()`);
	await a.until(`document.querySelector('${CARD} .summary')?.innerText.includes('條件 1 條')`, 'the new version on the card');
	await b.until(`document.querySelector('${CARD} .summary')?.innerText.includes('條件 1 條')`, 'the new version in the other browser');
	const versions = JSON.parse(readFileSync(grantFile, 'utf8')).versions;
	expect(versions.map((version: { source: string }) => version.source)).toEqual(['board-form', 'user-edit']);
	const log = readFileSync(join(fixture.dir, 'board-state/sent-log.jsonl'), 'utf8');
	expect(log.match(/"action":"unattended"/g)?.length).toBe(2);
});

test.skipIf(!CHROME)('at 390 wide the drawer comes up from the bottom and nothing scrolls sideways', async () => {
	const c = await browse(PHONE);
	expect(await c.eval(NO_SIDEWAYS)).toBe(true);
	await shot(c, '390-card-collapsed');
	// Clicked again until the page has taken over the button.
	await c.until(`!!document.querySelector('${CARD} .details') || (document.querySelector('${CARD} .summary').click(), false)`, 'the details');
	expect(await c.eval(NO_SIDEWAYS)).toBe(true);
	await shot(c, '390-card-open');
	await c.eval(`document.querySelector('.cmd button[aria-label="選項"]').click()`);
	await c.until(`!!document.querySelector('${MENU}')`, 'the menu');
	expect(await c.eval(NO_SIDEWAYS)).toBe(true);
	const menu = await c.eval<{ left: number; right: number }>(`(() => { const r = document.querySelector('.cmd .popup').getBoundingClientRect(); return { left: r.left, right: r.right }; })()`);
	expect(menu.left).toBeGreaterThanOrEqual(0);
	expect(menu.right).toBeLessThanOrEqual(390);
	await shot(c, '390-menu-unattended');
	await c.eval(`document.querySelector('.cmd button[aria-label="選項"]').click()`);
	await c.eval(`${button(CARD, '修改')}.click()`);
	await c.until(`!!document.querySelector('${DRAWER}')`, 'the drawer');
	await sleep(90);
	await shot(c, '390-drawer-sliding');
	await sleep(400);
	const rect = await c.eval<{ left: number; right: number; bottom: number; height: number }>(`(() => { const r = document.querySelector('${DRAWER}').getBoundingClientRect(); return { left: r.left, right: r.right, bottom: r.bottom, height: r.height }; })()`);
	expect(rect.left).toBe(0);
	expect(rect.right).toBe(390);
	expect(Math.round(rect.bottom)).toBe(844);
	expect(rect.height).toBeLessThanOrEqual(844 * 0.88 + 1);
	expect(await c.eval(NO_SIDEWAYS)).toBe(true);
	await shot(c, '390-drawer');
	await c.eval(`${button(DRAWER, '取消')}.click()`);
	// The roster with its mark, on a phone.
	await c.send('Page.navigate', { url: `${fixture.url}/` });
	await c.until(`${MARK} === '無人'`, 'the roster mark on a phone');
	expect(await c.eval(NO_SIDEWAYS)).toBe(true);
	await shot(c, '390-roster-mark');
	await c.send('Page.navigate', { url: `${fixture.url}/?controller=${luna.session_id}` });
	await c.until(`${BADGE} !== ''`, 'the controller page again');
});

test.skipIf(!CHROME)('關掉 on the card turns it back to manual on every page within 5 seconds', async () => {
	const [a, b] = [browsers[0].tab, browsers[1].tab];
	await save(a, '1280-roster-mark');
	const at = Date.now();
	await a.eval(`${button(CARD, '關掉')}.click()`);
	await b.until(`${MARK} === '' && ${BADGE} === ''`, 'the mark and badge gone in the other browser');
	expect(Date.now() - at).toBeLessThan(5_000);
	await b.eval(`document.querySelector('.cmd button[aria-label="選項"]').click()`);
	await b.until(`document.querySelector('${MENU}')?.innerText.includes('現在：人工確認（來自這個主控）')`, 'the menu back to manual');
	await save(b, '1280-after-off');
	expect(JSON.parse(readFileSync(grantFile, 'utf8')).versions.at(-1).end_reason).toBe('off');
});
