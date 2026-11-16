// The controller page's 代決 cards in a real browser on one built board, the real helper and
// lat-unattended (#663): below the ▲待決 row, one dashed ◇ row per delegated decision not opened
// yet, told apart from the question by its frame; the roster's 代決 N beside the question count;
// each kind opening to its own lines with 推翻 as its only action; opening marking it seen, so a
// reload or another device no longer lists it; 推翻 sending the item to the controller and the
// recorded answer showing on the card; a seen mark the host cannot keep saying so and leaving
// the card. At 1280 and 390 wide, dark and light, text is 16px or more, 推翻 is 44px tall and
// nothing scrolls sideways. With LAT_BOARD_SHOTS set every look is saved there. Headless Chrome
// over its DevTools protocol; skipped when the host has no Chrome.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { NODE, question, startFixture, uvPython, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, shot, type Browser, type Tab } from '../browser.ts';
import { writeDelegated } from '../review-fixture.ts';
import type { HelperController } from '../../src/lib/board/types.ts';

const TOOL = join(import.meta.dirname, '../../../skills/local/lat/scripts/lat-unattended.py');
const PANEL = join(import.meta.dirname, '../../../skills/local/lat/herdr-panel/lat_panel.py');
const WIDE = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };
const FORM = { goal: '#577 按鈕字改「儲存」', done: ['#577 合併進開發分支'], scope: { ticket_confirmation: true, assume_defaults: true, prototype_decide: true }, maxHours: 12 };

const card = (id: string) => `[data-delegated="${id}"]`;
const ROSTER = (name: string) => `button.person[data-controller="${name}"] .delegated`;
const NO_SIDEWAYS = `document.scrollingElement.scrollWidth <= innerWidth`;
const text = (selector: string) => `(document.querySelector(${JSON.stringify(selector)})?.innerText ?? '')`;
const click = (tab: Tab, selector: string) => tab.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
const type = (tab: Tab, selector: string, value: string) => tab.eval(`(() => { const box = document.querySelector(${JSON.stringify(selector)}); box.value = ${JSON.stringify(value)}; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const rows = (tab: Tab) => tab.eval<string[]>(`[...document.querySelectorAll('[data-delegated]')].map((entry) => entry.dataset.delegated)`);
/** The smallest font size of any text shown inside `selector`, in CSS pixels. */
const smallestFont = (tab: Tab, selector: string) =>
	tab.eval<number>(`Math.min(...[...document.querySelectorAll(${JSON.stringify(`${selector}, ${selector} *`)})].filter((node) => [...node.childNodes].some((child) => child.nodeType === 3 && child.textContent.trim())).map((node) => parseFloat(getComputedStyle(node).fontSize)))`);

const injectDir = mkdtempSync(join(tmpdir(), 'lat-board-delegated-inject-'));
let fixture: Fixture;
let cookie: string;
let config: string;
let luna: HelperController;
const browsers: Browser[] = [];

const typed = () => {
	try {
		return readFileSync(join(injectDir, 'inject-typed.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { text: string });
	} catch {
		return [];
	}
};

beforeAll(async () => {
	if (!CHROME) return;
	config = mkdtempSync(join(tmpdir(), 'lat-board-delegated-page-'));
	fixture = await startFixture({ env: { XDG_CONFIG_HOME: config, LAT_BOARD_INJECT_COMMAND: JSON.stringify([NODE, join(import.meta.dir, '../fake-inject.mjs'), injectDir]), LAT_BOARD_INJECT_TIMEOUT_SECONDS: '5' } });
	luna = fixture.bound('alpha', 'luna', { questions: [question({ id: 'Q-1', title: '通知卡片要不要加關閉鈕' })] });
	spawnSync('git', ['init', '-q', '-b', 'dev', luna.workspace]);
	mkdirSync(join(luna.workspace, '.lat/sessions'), { recursive: true });
	writeFileSync(join(luna.workspace, `.lat/sessions/${luna.session_id}.json`), JSON.stringify({ status: 'active', client: 'claude', history: [] }));
	fixture.setHelper({ output: { controllers: [luna] }, realUnattended: uvPython() });
	cookie = await fixture.login('delegated-cards');
	await fixture.refresh(cookie);
	const granted = await fixture.fetch('/api/unattended', { method: 'POST', cookie, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ controllerId: luna.session_id, op: 'create', ...FORM }) });
	expect(granted.status).toBe(200);
	writeDelegated(luna.workspace, luna.session_id, 'LAT-AS', 'assumed', 1, '設定頁按鈕文字用「儲存」');
	writeDelegated(luna.workspace, luna.session_id, 'LAT-PC', 'proxy-confirmed', 1, '#656 新建主控表單加模式切換');
	writeDelegated(luna.workspace, luna.session_id, 'LAT-PR', 'prototype-decided', 1, '通知列表用卡片版');
	await fixture.refresh(cookie);
}, 30_000);

afterAll(async () => {
	for (const browser of browsers) await browser.close();
	await fixture?.cleanup();
	if (config) rmSync(config, { recursive: true, force: true });
	rmSync(injectDir, { recursive: true, force: true });
});

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
const reload = async (tab: Tab) => {
	await tab.send('Page.reload', {});
	await tab.until(`document.querySelector('.detail .profile h2')?.innerText === 'alpha'`, 'the controller page again');
};
/** The theme the board follows from the system's colour scheme. */
async function theme(tab: Tab, name: 'dark' | 'light') {
	await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: name }] });
	await tab.until(`document.documentElement.dataset.theme === ${JSON.stringify(name)}`, `the ${name} theme`);
}

test.skipIf(!CHROME)('below the question, one dashed row per delegated decision, and 代決 3 beside the question count', async () => {
	const tab = await browse();
	await tab.until(`document.querySelectorAll('[data-delegated]').length === 3`, 'the three cards');
	expect(await rows(tab)).toEqual(['LAT-AS', 'LAT-PC', 'LAT-PR']);
	const titles = await tab.eval<string[]>(`[...document.querySelectorAll('[data-delegated] .title')].map((title) => title.innerText)`);
	expect(titles).toEqual(['◇ 已代決：設定頁按鈕文字用「儲存」', '◇ 已代確認：#656 新建主控表單加模式切換', '◇ 樣品決定：通知列表用卡片版']);
	// The strip follows the questions waiting.
	expect(await tab.eval(`!!(document.querySelector('.questions').compareDocumentPosition(document.querySelector('.delegated-strip')) & Node.DOCUMENT_POSITION_FOLLOWING)`)).toBe(true);
	expect(await tab.eval(text(ROSTER('luna')))).toBe('代決 3');
	expect(await tab.eval(text('button.person[data-controller="luna"] .badge'))).toBe('1');
	for (const name of ['dark', 'light'] as const) {
		await theme(tab, name);
		// Told apart from the question by the frame, not by colour alone.
		const frames = await tab.eval<{ question: string; delegated: string }>(`({ question: getComputedStyle(document.querySelector('.questions .question')).borderTopStyle, delegated: getComputedStyle(document.querySelector('[data-delegated]')).borderTopStyle })`);
		expect(frames).toEqual({ question: 'solid', delegated: 'dashed' });
		expect(await smallestFont(tab, '.delegated-strip')).toBeGreaterThanOrEqual(16);
		expect(await smallestFont(tab, ROSTER('luna'))).toBeGreaterThanOrEqual(16);
		expect(await tab.eval(NO_SIDEWAYS)).toBe(true);
		await shot(tab, `1280-${name}-strip`, { box: '.delegated-strip' });
	}
	await theme(tab, 'dark');
});

test.skipIf(!CHROME)('each kind opens to its own lines with 推翻 as its only action; opening it marks it seen', async () => {
	const tab = browsers[0].tab;
	const expected: Record<string, string[]> = {
		'LAT-AS': ['原本要問', '參謀決定', '兩位參謀', '可以改成'],
		'LAT-PC': ['原本要問', '兩位參謀', '驗收對照'],
		'LAT-PR': ['原本要問', '參謀決定', '兩位參謀', '樣品']
	};
	for (const [id, labels] of Object.entries(expected)) {
		await click(tab, `${card(id)} .row`);
		await tab.until(`!!document.querySelector('${card(id)} .detail')`, `${id} opened`);
		expect(await tab.eval<string[]>(`[...document.querySelectorAll('${card(id)} dt')].map((label) => label.innerText)`)).toEqual(labels);
		expect(await tab.eval<boolean>(`[...document.querySelectorAll('${card(id)} dd')].every((value) => value.innerText.trim() !== '')`)).toBe(true);
		expect(await tab.eval<string[]>(`[...document.querySelectorAll('${card(id)} .detail button')].map((button) => button.innerText)`)).toEqual(['推翻']);
		expect(await tab.eval<number>(`document.querySelector('${card(id)} .overturn').getBoundingClientRect().height`)).toBeGreaterThanOrEqual(44);
		expect(await smallestFont(tab, card(id))).toBeGreaterThanOrEqual(16);
		for (const name of ['dark', 'light'] as const) {
			await theme(tab, name);
			await shot(tab, `1280-${name}-${id}`, { box: card(id) });
			await shot(tab, `390-${name}-${id}`, { phone: true, box: card(id), back: WIDE });
		}
		await theme(tab, 'dark');
	}
	// Opened ones stay on this page, and the roster counts none left.
	await tab.until(`${text(ROSTER('luna'))} === ''`, 'the roster count gone');
	expect(await tab.eval(`!!document.querySelector(${JSON.stringify(ROSTER('luna'))})`)).toBe(false);
	expect(await rows(tab)).toEqual(['LAT-AS', 'LAT-PC', 'LAT-PR']);
	const marks = JSON.parse(readFileSync(join(fixture.dir, 'board-state', 'delegated-seen.json'), 'utf8')).seen;
	expect(Object.keys(marks).sort()).toEqual(['LAT-AS', 'LAT-PC', 'LAT-PR'].map((id) => `${luna.session_id}:${id}`));
});

test.skipIf(!CHROME)('推翻 sends the item to the controller, and the recorded answer shows on the card', async () => {
	const tab = browsers[0].tab;
	await click(tab, `${card('LAT-AS')} .row`);
	await tab.until(`!!document.querySelector('${card('LAT-AS')} .overturn')`, 'LAT-AS opened');
	await click(tab, `${card('LAT-AS')} .overturn`);
	await tab.until(`!!document.querySelector('${card('LAT-AS')} textarea')`, 'the comment box');
	expect(await tab.eval(`document.querySelector('${card('LAT-AS')} button.send').disabled`)).toBe(true);
	await type(tab, `${card('LAT-AS')} textarea`, '改成「套用」');
	for (const name of ['dark', 'light'] as const) {
		await theme(tab, name);
		await shot(tab, `1280-${name}-overturn-box`, { box: card('LAT-AS') });
		await shot(tab, `390-${name}-overturn-box`, { phone: true, box: card('LAT-AS'), back: WIDE });
	}
	await theme(tab, 'dark');
	await click(tab, `${card('LAT-AS')} button.send`);
	await tab.until(`!document.querySelector('${card('LAT-AS')} textarea')`, 'the box closed after sending');
	expect(typed().map((line) => line.text).join('')).toBe('回顧項目 LAT-AS「設定頁按鈕文字用「儲存」」推翻：改成「套用」');
	// The controller records it the way a review answer is recorded.
	const run = spawnSync(uvPython(), [PANEL, 'question', 'record-chat', '--id', 'LAT-AS', '--text', '推翻：改成「套用」', '--source', 'session s-1 看板代決', '--questions', luna.questions_path, '--decisions', join(luna.workspace, '.lat/decisions')], { encoding: 'utf8', env: fixture.serverEnv() });
	expect(run.status, run.stdout + run.stderr).toBe(0);
	// Its turn end rebuilds the review, which the board watches.
	const update = spawnSync(uvPython(), [TOOL, 'review', 'update', `--workspace=${luna.workspace}`, `--session-id=${luna.session_id}`, '--json'], { encoding: 'utf8', env: fixture.serverEnv() });
	expect(update.status, update.stdout + update.stderr).toBe(0);
	await tab.until(`${text(`${card('LAT-AS')} .state`)}.startsWith('已由你推翻（')`, 'the card marked overturned');
	expect(await tab.eval(`!!document.querySelector('${card('LAT-AS')} .overturn')`)).toBe(false);
	expect(await tab.eval(text(`${card('LAT-AS')} .go`))).toBe('已推翻 ›');
	await shot(tab, '1280-dark-overturned', { box: card('LAT-AS') });
});

test.skipIf(!CHROME)('a reload and another browser no longer list the opened cards', async () => {
	await reload(browsers[0].tab);
	expect(await rows(browsers[0].tab)).toEqual([]);
	const phone = await browse(PHONE);
	expect(await rows(phone)).toEqual([]);
});

test.skipIf(!CHROME)('a seen mark the host cannot keep leaves the card with the note, at 390 wide with no sideways scroll', async () => {
	writeDelegated(luna.workspace, luna.session_id, 'LAT-A2', 'assumed', 1, '匯出檔名用日期開頭');
	const tab = browsers[1].tab;
	await tab.until(`document.querySelectorAll('[data-delegated]').length === 1`, 'the new card');
	const state = join(fixture.dir, 'board-state');
	chmodSync(state, 0o555);
	try {
		await click(tab, `${card('LAT-A2')} .row`);
		await tab.until(`${text(`${card('LAT-A2')} .unsaved`)} === '沒記下看過，下次打開會再出現'`, 'the note');
		expect(await tab.eval(NO_SIDEWAYS)).toBe(true);
		for (const name of ['dark', 'light'] as const) {
			await theme(tab, name);
			await shot(tab, `390-${name}-unsaved`, { box: card('LAT-A2') });
		}
		// Closed again, the card still says so.
		await click(tab, `${card('LAT-A2')} .row`);
		await tab.until(`!document.querySelector('${card('LAT-A2')} .detail')`, 'the card closed');
		expect(await tab.eval(text(`${card('LAT-A2')} .unsaved`))).toBe('沒記下看過，下次打開會再出現');
		await reload(tab);
		expect(await rows(tab)).toEqual(['LAT-A2']);
	} finally {
		chmodSync(state, 0o755);
	}
	// The phone strip itself, closed, in both themes.
	for (const name of ['dark', 'light'] as const) {
		await theme(tab, name);
		await shot(tab, `390-${name}-strip`, { box: '.delegated-strip' });
	}
	expect(await smallestFont(tab, '.delegated-strip')).toBeGreaterThanOrEqual(16);
	expect(await tab.eval(NO_SIDEWAYS)).toBe(true);
});
