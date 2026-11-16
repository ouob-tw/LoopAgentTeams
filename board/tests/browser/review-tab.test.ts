// The 回顧 tab in real browsers on one built board, the real helper and lat-unattended (#664): no
// tab before a review exists; the tab right after 對話紀錄; cards in groups, in order: the goal and
// what counts as done, the 代決 not seen yet, those seen or whose grant ended (「沒推翻，算同意」, or
// 「已由你推翻（time）：words」 once the controller recorded the 推翻), the questions asked during
// the grant (the answer, or 「等你回答」 leading to the question), parked items from before #661;
// a group with nothing in it left out. A 代決 opened here is marked seen; 推翻 sends its ID, title
// and words to the controller. The rows are the controller page's 代決 rows. After the grant ends
// and after the controller has ended the cards still open to 推翻; an old review file opens. At
// 1280 and 390 wide, dark and light, text is 16px or more, buttons 44px, nothing scrolls sideways.
// With LAT_BOARD_SHOTS set every look is saved there. Headless Chrome over its DevTools protocol;
// skipped when the host has no Chrome.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { NODE, question, sleep, startFixture, uvPython, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, shot, type Browser, type Tab } from '../browser.ts';
import { writeRound } from '../review-fixture.ts';
import type { HelperController } from '../../src/lib/board/types.ts';

const TOOL = join(import.meta.dirname, '../../../skills/local/lat/scripts/lat-unattended.py');
const PANEL_TOOL = join(import.meta.dirname, '../../../skills/local/lat/herdr-panel/lat_panel.py');
const WIDE = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };
const FORM = { goal: '#577 按鈕字改「儲存」、#578 修錯字，明早 07:30 前做完', done: ['#577、#578 都合併進開發分支', '測試全過'], scope: { ticket_confirmation: true, assume_defaults: true, prototype_decide: true }, maxHours: 12 };

const TAB = '[data-tab="review"]';
const PANEL = '#panel-review';
const item = (id: string) => `${PANEL} [data-item="${id}"]`;
const card = (id: string) => `${PANEL} [data-delegated="${id}"]`;
const asked = (id: string) => `${PANEL} [data-asked="${id}"]`;
const group = (key: string) => `${PANEL} [data-group="${key}"]`;
const NO_SIDEWAYS = `document.scrollingElement.scrollWidth <= innerWidth`;
const text = (selector: string) => `(document.querySelector(${JSON.stringify(selector)})?.innerText ?? '')`;
/** The smallest font size of any text shown inside `selector`, in CSS pixels. */
const smallestFont = (tab: Tab, selector: string) =>
	tab.eval<number>(`Math.min(...[...document.querySelectorAll(${JSON.stringify(`${selector}, ${selector} *`)})].filter((node) => node.offsetParent !== null && [...node.childNodes].some((child) => child.nodeType === 3 && child.textContent.trim())).map((node) => parseFloat(getComputedStyle(node).fontSize)))`);
/** Every visible button in the panel lower than 44px, by its text. */
const smallButtons = (tab: Tab) => tab.eval<string[]>(`[...document.querySelectorAll('${PANEL} button')].filter((el) => el.offsetParent !== null && el.getBoundingClientRect().height < 43).map((el) => el.innerText)`);

const injectDir = mkdtempSync(join(tmpdir(), 'lat-board-review-inject-'));
let fixture: Fixture;
let cookie: string;
let config: string;
let luna: HelperController;
const browsers: Browser[] = [];

beforeAll(async () => {
	if (!CHROME) return;
	config = mkdtempSync(join(tmpdir(), 'lat-board-review-page-'));
	fixture = await startFixture({ env: { XDG_CONFIG_HOME: config, LAT_BOARD_INJECT_COMMAND: JSON.stringify([NODE, join(import.meta.dir, '../fake-inject.mjs'), injectDir]), LAT_BOARD_INJECT_TIMEOUT_SECONDS: '5' } });
	luna = fixture.bound('alpha', 'luna', { questions: [question({ id: 'Q-OPEN', title: '通知卡片要不要加關閉鈕？' })] });
	spawnSync('git', ['init', '-q', '-b', 'dev', luna.workspace]);
	mkdirSync(join(luna.workspace, '.lat/sessions'), { recursive: true });
	writeFileSync(join(luna.workspace, `.lat/sessions/${luna.session_id}.json`), JSON.stringify({ status: 'active', client: 'claude', history: [] }));
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', `${luna.session_id}.jsonl`), JSON.stringify({ kind: 'user', time: null, text: '#577 的按鈕字改成「儲存」，#578 修錯字。我先睡了，明早 07:30 前做完。' }) + '\n');
	fixture.setHelper({ output: { controllers: [luna] }, realUnattended: uvPython(), realPreauth: uvPython() });
	cookie = await fixture.login('review-tab');
	await fixture.refresh(cookie);
}, 30_000);

afterAll(async () => {
	for (const browser of browsers) await browser.close();
	await fixture?.cleanup();
	if (config) rmSync(config, { recursive: true, force: true });
	rmSync(injectDir, { recursive: true, force: true });
});

/** The controller's own tool, as it runs at a turn end. */
function tool(...args: string[]) {
	const run = spawnSync(uvPython(), [TOOL, ...args, `--workspace=${luna.workspace}`, `--session-id=${luna.session_id}`, '--json'], { encoding: 'utf8', env: fixture.serverEnv() });
	expect(run.status, run.stdout + run.stderr).toBe(0);
}
/** A question the controller asked the user during the grant (#661), waiting or answered. */
function askedRecord(id: string, title: string, answer?: string) {
	const lines = [`# ${id} ${title}`, '', `- status: ${answer ? 'approved' : 'pending'}`, '- advisor: needs-human', `- session: ${luna.session_id}`, '- grant: r1 v1', '- version: r1', `- question: ${title}`, '- options: A 要加 / B 不加', ''];
	if (answer) lines.push('## 答覆（r1，面板，2026-11-16T09:30:00+08:00）', '', `- 答覆：${answer}`, '');
	writeFileSync(join(luna.workspace, '.lat/decisions', `${id}.md`), lines.join('\n'));
}
const grant = (body: object) => fixture.fetch('/api/unattended', { method: 'POST', cookie, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ controllerId: luna.session_id, ...body }) });
const typed = () => {
	try {
		return readFileSync(join(injectDir, 'inject-typed.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { text: string; enter: boolean });
	} catch {
		return [];
	}
};

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
/** Open the review tab, clicked until the page has taken over its buttons. */
async function openTab(tab: Tab) {
	await tab.until(`(document.querySelector('${TAB}')?.click(), document.querySelector('${TAB}')?.getAttribute('aria-selected') === 'true')`, 'the 回顧 tab opened');
	await tab.until(`!!document.querySelector('${group('goal')}')`, 'the review read');
}
const reload = async (tab: Tab) => {
	await tab.send('Page.reload', {});
	await tab.until(`document.querySelector('.detail .profile h2')?.innerText === 'alpha'`, 'the controller page again');
	await openTab(tab);
};
/** The theme the board follows from the system's colour scheme. */
async function theme(tab: Tab, name: 'dark' | 'light') {
	await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: name }] });
	await tab.until(`document.documentElement.dataset.theme === ${JSON.stringify(name)}`, `the ${name} theme`);
}
/** One look of `box` per theme, at 1280 and at 390 wide; the page is put back to 1280 dark. */
async function looks(tab: Tab, name: string, box: string) {
	for (const scheme of ['dark', 'light'] as const) {
		await theme(tab, scheme);
		await shot(tab, `1280-${scheme}-${name}`, { box });
		await shot(tab, `390-${scheme}-${name}`, { phone: true, box, back: WIDE });
	}
	await theme(tab, 'dark');
}
const groups = (tab: Tab) => tab.eval<string[]>(`[...document.querySelectorAll('${PANEL} [data-group]')].map((entry) => entry.dataset.group)`);
const ids = (tab: Tab, key: string) => tab.eval<string[]>(`[...document.querySelectorAll('${group(key)} [data-delegated], ${group(key)} [data-asked], ${group(key)} [data-item]')].map((entry) => entry.dataset.delegated ?? entry.dataset.asked ?? entry.dataset.item)`);
const tabNames = (tab: Tab) => tab.eval<string[]>(`[...document.querySelectorAll('.tabs [role="tab"]')].map((tab) => tab.dataset.tab)`);
/** Type into a textarea the way a user does: the value, then an input event. */
const type = (tab: Tab, selector: string, value: string) => tab.eval(`(() => { const box = document.querySelector(${JSON.stringify(selector)}); box.value = ${JSON.stringify(value)}; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const click = (tab: Tab, selector: string) => tab.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);

test.skipIf(!CHROME)('before the round has a review there is no 回顧 tab', async () => {
	const tab = await browse();
	expect(await tabNames(tab)).not.toContain('review');
	// A grant with nothing parked or decided yet has no review file, so still no tab.
	expect((await grant({ op: 'create', ...FORM })).status).toBe(200);
	await sleep(1500);
	expect(await tabNames(tab)).not.toContain('review');
});

test.skipIf(!CHROME)('the cards come in groups, in order, and an empty group is left out', async () => {
	const tab = browsers[0].tab;
	writeRound(luna.workspace, luna.session_id);
	askedRecord('Q-DONE', '設定頁要不要加深色模式？', 'A. 要加');
	askedRecord('Q-OPEN', '通知卡片要不要加關閉鈕？');
	tool('review', 'update');
	await tab.until(`!!document.querySelector('${TAB}')`, 'the 回顧 tab appearing without a reload');
	expect((await tabNames(tab)).slice(0, 2)).toEqual(['transcript', 'review']);
	await openTab(tab);
	await tab.until(`!!document.querySelector('${group('asked')}')`, 'the questions read');

	// Nothing seen or ended yet: no such group.
	expect(await groups(tab)).toEqual(['goal', 'unseen', 'asked', 'parked']);
	expect(await tab.eval<string[]>(`[...document.querySelectorAll('${PANEL} h4')].map((h) => h.innerText.replace(/\\s+\\d+$/, ''))`)).toEqual(['本輪目標與做完條件', '還沒看過的代決', '這輪無人期間問過你的題', '擱置等你的事']);
	expect(await ids(tab, 'unseen')).toEqual(['LAT-AN', 'LAT-AU', 'LAT-PC']);
	expect(await ids(tab, 'asked')).toEqual(['Q-DONE', 'Q-OPEN']);
	expect(await ids(tab, 'parked')).toEqual(['LAT-P1', 'LAT-P2', 'row-3']);

	// The goal in effect, with what counts as done, not folded.
	const goal = await tab.eval<string>(text(group('goal')));
	expect(goal).toContain('第 1 版 · 生效中');
	expect(goal).toContain(FORM.goal);
	expect(goal).toContain('做完的條件');
	expect(goal).toContain('測試全過');
	expect(goal).not.toContain('之前的版本');

	// The 代決 rows are the controller page's: ◇, the kind, the title and 看看.
	expect(await tab.eval<string>(text(`${card('LAT-AU')} .row`))).toMatch(/^◇ 已代決：備份預設留 30 天\s*看看 ›$/);
	expect(await tab.eval(`getComputedStyle(document.querySelector('${card('LAT-AU')}')).borderTopStyle`)).toBe('dashed');

	// An answered question says the answer; a waiting one says so and leads to its card.
	expect(await tab.eval<string>(text(asked('Q-DONE')))).toMatch(/▲ 待決：設定頁要不要加深色模式？\s*你答：A\. 要加/);
	expect(await tab.eval(`document.querySelector('${asked('Q-DONE')}').tagName`)).toBe('DIV');
	expect(await tab.eval<string>(text(asked('Q-OPEN')))).toMatch(/▲ 待決：通知卡片要不要加關閉鈕？\s*作答 ›\s*等你回答/);
	expect(await tab.eval(`document.querySelector('${asked('Q-OPEN')}').tagName`)).toBe('BUTTON');

	expect(await tab.eval(NO_SIDEWAYS)).toBe(true);
	expect(await smallestFont(tab, PANEL)).toBeGreaterThanOrEqual(16);
	expect(await smallButtons(tab)).toEqual([]);
	await looks(tab, 'goal', group('goal'));
	await looks(tab, 'unseen', group('unseen'));
	await looks(tab, 'asked', group('asked'));
});

test.skipIf(!CHROME)('a 代決 opened here shows its record and is marked seen; after a reload it reads 沒推翻，算同意', async () => {
	const tab = browsers[0].tab;
	await click(tab, `${card('LAT-AU')} .row`);
	await tab.until(`!!document.querySelector('${card('LAT-AU')} .detail')`, 'LAT-AU opened');
	expect(await tab.eval<string[]>(`[...document.querySelectorAll('${card('LAT-AU')} dt')].map((label) => label.innerText)`)).toEqual(['原本要問', '參謀決定', '兩位參謀', '可以改成']);
	expect(await tab.eval<string[]>(`[...document.querySelectorAll('${card('LAT-AU')} .detail button')].map((button) => button.innerText)`)).toEqual(['推翻']);
	// Only the review's row opened: the controller page's strip keeps its own.
	expect(await tab.eval(`!!document.querySelector('.delegated-strip [data-delegated="LAT-AU"] .detail')`)).toBe(false);
	const seenFile = join(fixture.dir, 'board-state', 'delegated-seen.json');
	for (let tries = 0; tries < 50; tries++) {
		try {
			if (`${luna.session_id}:LAT-AU` in JSON.parse(readFileSync(seenFile, 'utf8')).seen) break;
		} catch {}
		await sleep(100);
	}
	expect(Object.keys(JSON.parse(readFileSync(seenFile, 'utf8')).seen)).toEqual([`${luna.session_id}:LAT-AU`]);
	// Opened on this page, it stays where it was until the page closes.
	expect(await ids(tab, 'unseen')).toEqual(['LAT-AN', 'LAT-AU', 'LAT-PC']);
	await looks(tab, 'unseen-open', card('LAT-AU'));
	await reload(tab);
	await tab.until(`!!document.querySelector('${group('settled')}')`, 'the settled group');
	expect(await groups(tab)).toEqual(['goal', 'unseen', 'settled', 'asked', 'parked']);
	expect(await ids(tab, 'unseen')).toEqual(['LAT-AN', 'LAT-PC']);
	expect(await ids(tab, 'settled')).toEqual(['LAT-AU']);
	expect(await tab.eval<string>(text(`${card('LAT-AU')} [data-settled]`))).toBe('沒推翻，算同意');
	// Seen and not seen are told apart by more than colour: the tint goes.
	const tints = await tab.eval<string[]>(`[document.querySelector('${card('LAT-AN')}'), document.querySelector('${card('LAT-AU')}')].map((el) => getComputedStyle(el).backgroundColor)`);
	expect(tints[0]).not.toBe(tints[1]);
});

test.skipIf(!CHROME)('推翻 from the review sends the item to the controller, and the recorded answer shows with its time and words', async () => {
	const tab = browsers[0].tab;
	await click(tab, `${card('LAT-AN')} .row`);
	await tab.until(`!!document.querySelector('${card('LAT-AN')} .overturn')`, 'LAT-AN opened');
	await click(tab, `${card('LAT-AN')} .overturn`);
	await tab.until(`!!document.querySelector('${card('LAT-AN')} textarea')`, 'the comment box');
	expect(await tab.eval(`document.querySelector('${card('LAT-AN')} button.send').disabled`)).toBe(true);
	await type(tab, `${card('LAT-AN')} textarea`, '改叫 SignIn');
	await looks(tab, 'overturn-box', card('LAT-AN'));
	await click(tab, `${card('LAT-AN')} button.send`);
	await tab.until(`!document.querySelector('${card('LAT-AN')} textarea')`, 'the box closed after sending');
	expect(typed().at(-1)?.text).toBe('回顧項目 LAT-AN「元件叫 LoginPanel」推翻：改叫 SignIn');
	// The controller records it the way a review answer is recorded, and its turn end rebuilds the review.
	const run = spawnSync(uvPython(), [PANEL_TOOL, 'question', 'record-chat', '--id', 'LAT-AN', '--text', '推翻：改叫 SignIn', '--source', 'session s-1 看板回顧', '--questions', luna.questions_path, '--decisions', join(luna.workspace, '.lat/decisions')], { encoding: 'utf8', env: fixture.serverEnv() });
	expect(run.status, run.stdout + run.stderr).toBe(0);
	tool('review', 'update');
	await tab.until(`${text(`${card('LAT-AN')} [data-settled]`)}.startsWith('已由你推翻（')`, 'the card overturned', 8_000);
	expect(await tab.eval<string>(text(`${card('LAT-AN')} [data-settled]`))).toMatch(/^已由你推翻（\d{1,2}\/\d{1,2} \d{2}:\d{2}）：改叫 SignIn$/);
	expect(await ids(tab, 'settled')).toEqual(['LAT-AN', 'LAT-AU']);
	expect(await tab.eval(`!!document.querySelector('${card('LAT-AN')} .overturn')`)).toBe(false);
	// Still open from the send: closed for the look of the group.
	await click(tab, `${card('LAT-AN')} .row`);
	await tab.until(`!document.querySelector('${card('LAT-AN')} .detail')`, 'LAT-AN closed');
	await looks(tab, 'settled', group('settled'));
});

test.skipIf(!CHROME)('a waiting question leads to its card; once answered it shows the answer', async () => {
	const tab = browsers[0].tab;
	await click(tab, asked('Q-OPEN'));
	await tab.until(`new URLSearchParams(location.search).has('item')`, 'the question opened');
	expect(new URLSearchParams(await tab.eval<string>('location.search')).get('item')).toContain('Q-OPEN');
	await tab.send('Page.navigate', { url: `${fixture.url}/?controller=${luna.session_id}` });
	await tab.until(`document.querySelector('.detail .profile h2')?.innerText === 'alpha'`, 'the controller page again');
	await openTab(tab);
	// The controller records the answer: the record and the question file say so.
	askedRecord('Q-OPEN', '通知卡片要不要加關閉鈕？', 'B. 不加');
	fixture.setHelper({ output: { controllers: [{ ...luna, questions: [question({ id: 'Q-OPEN', title: '通知卡片要不要加關閉鈕？', status: 'recorded', answer: 'B. 不加' })] }] }, realUnattended: uvPython(), realPreauth: uvPython() });
	await fixture.refresh(cookie);
	await tab.until(`${text(asked('Q-OPEN'))}.includes('你答：B. 不加')`, 'the answer shown', 8_000);
	expect(await tab.eval(`document.querySelector('${asked('Q-OPEN')}').tagName`)).toBe('DIV');
	await looks(tab, 'asked-answered', group('asked'));
});

test.skipIf(!CHROME)('when the grant ends the 代決 not seen move to the seen or ended group, still open to 推翻', async () => {
	const tab = browsers[0].tab;
	expect((await grant({ op: 'close' })).status).toBe(200);
	await tab.until(`!document.querySelector('${group('unseen')}')`, 'the unseen group gone', 8_000);
	expect(await ids(tab, 'settled')).toEqual(['LAT-AN', 'LAT-AU', 'LAT-PC']);
	expect(await tab.eval<string>(text(`${card('LAT-PC')} [data-settled]`))).toBe('沒推翻，算同意');
	await tab.until(`${text(group('goal'))}.includes('已結束（使用者關掉）')`, 'the goal showing the grant ended', 8_000);
	await click(tab, `${card('LAT-PC')} .row`);
	await tab.until(`!!document.querySelector('${card('LAT-PC')} .overturn')`, 'LAT-PC still overturnable');
	await click(tab, `${card('LAT-PC')} .row`);
	// A new grant version is listed; the earlier one folds below it.
	expect((await grant({ op: 'create', ...FORM, goal: '#579 也做完' })).status).toBe(200);
	await tab.until(`${text(group('goal'))}.includes('之前的版本（1）')`, 'the earlier version folded', 8_000);
	expect(await tab.eval<string>(text(group('goal')))).toContain('第 2 版 · 生效中');
	await click(tab, `${group('goal')} .earlier`);
	await tab.until(`document.querySelectorAll('${group('goal')} .version').length === 2`, 'the earlier version opened');
	expect(await tab.eval<string>(text(`${group('goal')} .version[data-version="1"]`))).toContain(FORM.goal);
	await looks(tab, 'goal-versions', group('goal'));
});

test.skipIf(!CHROME)('at 390 wide, dark and light, nothing scrolls sideways, text is 16px or more and buttons are 44px', async () => {
	const tab = await browse(PHONE);
	await openTab(tab);
	await tab.until(`!!document.querySelector('${group('settled')}')`, 'the groups');
	for (const scheme of ['dark', 'light'] as const) {
		await theme(tab, scheme);
		expect(await tab.eval(NO_SIDEWAYS)).toBe(true);
		expect(await smallestFont(tab, PANEL)).toBeGreaterThanOrEqual(16);
		expect(await smallButtons(tab)).toEqual([]);
	}
	// The longest row: the overturn line wraps inside the card, never past it.
	const fits = await tab.eval<boolean>(`[...document.querySelectorAll('${PANEL} [data-delegated], ${PANEL} [data-asked]')].every((row) => row.scrollWidth <= row.clientWidth + 1 && row.getBoundingClientRect().right <= innerWidth)`);
	expect(fits).toBe(true);
	await click(tab, `${card('LAT-AU')} .row`);
	await tab.until(`!!document.querySelector('${card('LAT-AU')} .detail')`, 'the detail on the phone');
	expect(await tab.eval(NO_SIDEWAYS)).toBe(true);
	await theme(tab, 'dark');
});

/** Open a parked item's evidence, press its file link and read the file in the window; Esc closes it. */
async function evidenceWindow(size: typeof WIDE, name: string) {
	const tab = await browse(size);
	await openTab(tab);
	await tab.until(`!!document.querySelector('${item('LAT-P1')} .toggle')`, 'the items');
	await tab.until(`(() => { const box = document.querySelector('${item('LAT-P1')}'); if (!box.querySelector('.reasons')) box.querySelector('.toggle').click(); return !!box.querySelector('.reasons'); })()`, 'the evidence opened');
	const link = `${item('LAT-P1')} .reasons button.link`;
	expect(await tab.eval<string>(text(link))).toBe('.lat/decisions/LAT-P1.md');
	expect(await tab.eval<number>(`document.querySelector('${link}').getBoundingClientRect().height`)).toBeGreaterThanOrEqual(44);
	await click(tab, link);
	await tab.until(`!!document.querySelector('dialog.evidence[open] .md')`, 'the record laid out in the window');
	expect(await tab.eval<string>(text('dialog.evidence .content'))).toContain('屬 Spec 確認，一定擱置');
	expect(await tab.eval(NO_SIDEWAYS)).toBe(true);
	await shot(tab, `${name}-review-evidence-window`);
	await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
	await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
	await tab.until(`!document.querySelector('dialog.evidence[open]')`, 'the window closed by Esc');
}

test.skipIf(!CHROME)('a parked item from before #661 keeps 回覆 and opens its cited record, at 1280 and 390', async () => {
	expect(await browsers[0].tab.eval<string>(text(`${item('LAT-P1')} button.act`))).toBe('回覆');
	await evidenceWindow(WIDE, '1280');
	await evidenceWindow(PHONE, '390');
});

test.skipIf(!CHROME)('a review file from before #662 opens with its cards, no error and not blank', async () => {
	const state = join(luna.workspace, `.lat/unattended/${luna.session_id}-r1-review.json`);
	const md = state.replace(/\.json$/, '.md');
	// The review as it was written before #662, with its cross-check: never rewritten again.
	writeFileSync(md, '# 無人模式回顧：舊版\n\n- 核對：kiwi 已核對\n');
	writeFileSync(state, JSON.stringify({ body_sha: 'x', verification: { checker: 'kiwi', total: 1, matched: 1, mismatches: [] }, content_sha: 'y' }));
	await fixture.refresh(cookie);
	const tab = await browse();
	await openTab(tab);
	expect(await tab.eval(`!!document.querySelector('${PANEL} .failed')`)).toBe(false);
	expect((await groups(tab)).length).toBeGreaterThan(0);
	expect(readFileSync(md, 'utf8')).toContain('- 核對：kiwi 已核對');
	await shot(tab, '1280-dark-old-review', { box: PANEL });
});

test.skipIf(!CHROME)('once the controller has ended the tab stays, its 代決 still open, and 推翻 wakes it with the words', async () => {
	// Deactivated, its final report a bare DONE as an automation task's controller ends.
	fixture.setHelper({ output: { controllers: [] }, realUnattended: uvPython(), realPreauth: uvPython() });
	fixture.report(luna.session_id, { tag: '', summary: '', message: '這一輪做完了。\n\nDONE', hcom_name: luna.hcom_name, workspace: luna.workspace, final: true });
	await fixture.refresh(cookie);
	const tab = await browse();
	await openTab(tab);
	await tab.until(`!!document.querySelector('${card('LAT-AU')}')`, 'the 代決 of the ended controller');
	await click(tab, `${card('LAT-AU')} .row`);
	await tab.until(`!!document.querySelector('${card('LAT-AU')} .overturn')`, 'LAT-AU opened');
	await click(tab, `${card('LAT-AU')} .overturn`);
	await type(tab, `${card('LAT-AU')} textarea`, '改成 7 天');
	await looks(tab, 'ended', group('settled'));
	await click(tab, `${card('LAT-AU')} button.send`);
	await tab.until(`!document.querySelector('${card('LAT-AU')} textarea') || !!document.querySelector('${card('LAT-AU')} .failed')`, 'sent or refused');
	expect(await tab.eval<string>(text(`${card('LAT-AU')} .failed`))).toBe('');
	expect(typed().map((line) => line.text)).toContain('回顧項目 LAT-AU「備份預設留 30 天」推翻：改成 7 天');
	// A question it asked and never had answered says it can no longer be answered, instead of waiting.
	askedRecord('Q-LATE', '匯出要不要分頁？');
	tool('review', 'update');
	await fixture.refresh(cookie);
	await tab.until(`!!document.querySelector('${asked('Q-LATE')}')`, 'the late question', 8_000);
	expect(await tab.eval<string>(text(asked('Q-LATE')))).toMatch(/沒答到，主控已結束$/);
	expect(await tab.eval(`document.querySelector('${asked('Q-LATE')}').tagName`)).toBe('DIV');
});
