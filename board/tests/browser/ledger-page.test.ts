// A controller's work ledger on its page in a real browser: one line per ticket with its link,
// title, progress strip, now cell, models and time; a line opens to its rows with their reasons
// and evidence, which open; a project without deploy history has five steps; at a phone's width
// each line is a card inside the page. Skipped when the host has no Chrome. With LAT_BOARD_SHOTS
// set, the ledger is captured at desktop and phone width, closed and opened.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser, type Tab } from '../browser.ts';
import { fiveStepLedger, ticketLedger } from '../fixtures/ledger-tickets.ts';

let fixture: Fixture;
let browser: Browser | undefined;

const DESKTOP = { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	const luna = fixture.bound('alpha', 'luna');
	const nova = fixture.bound('beta', 'nova');
	// The ledger's workspace is a GitHub project with the report its deployed ticket names.
	spawnSync('git', ['init', '-q', luna.workspace]);
	spawnSync('git', ['-C', luna.workspace, 'remote', 'add', 'origin', 'git@github.com:ouob-tw/LoopAgentTeams.git']);
	// A long report name, as real ones are, which must wrap inside a phone's card.
	const report = join(luna.workspace, '.lat/runs/issue-534/report-2026-11-12-zapi-t534-board-title-link-final-candidate.md');
	mkdirSync(join(luna.workspace, '.lat/runs/issue-534'), { recursive: true });
	writeFileSync(report, '# #534 report\n');
	fixture.setHelper({
		output: { controllers: [luna, nova] },
		ledgers: {
			[luna.session_id]: { status: 'ok', ledger: ticketLedger(luna.workspace, report) },
			[nova.session_id]: { status: 'ok', ledger: fiveStepLedger(nova.workspace) }
		}
	});
	const cookie = await fixture.login('ledger-page');
	await fixture.refresh(cookie);
	browser = await launchChrome();
	const [name, value] = cookie.split('=');
	await browser.tab.send('Network.setCookie', { name, value, url: fixture.url });
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

const LINES = `[...document.querySelectorAll('.detail .ledger .ticket')]`;
const lineOf = (ref: string) => `${LINES}.find((li) => li.querySelector('.ref').innerText.startsWith(${JSON.stringify(ref)}))`;
const flat = (expression: string) => `(${expression}).innerText.replace(/\\s+/g, ' ').trim()`;

async function openLedger(tab: Tab, controller: string, size: typeof DESKTOP) {
	await tab.send('Emulation.setDeviceMetricsOverride', size);
	await tab.navigate(`${fixture.url}/?controller=${controller}`);
	await tab.until(`document.querySelector('.detail [data-tab="ledger"]')`, 'the ledger tab');
	// Clicked until it takes: a click before the page is hydrated does nothing.
	await tab.until(
		`(() => { const button = document.querySelector('.detail [data-tab="ledger"]'); if (button.getAttribute('aria-selected') !== 'true') button.click(); const ledger = document.querySelector('.detail .ledger'); return ${LINES}.length > 0 && ledger.checkVisibility() && ledger.getBoundingClientRect().left >= 0; })()`,
		'the ticket lines'
	);
	// Let a phone's panel finish sliding in.
	await tab.eval(`new Promise((done) => setTimeout(done, 400))`);
}

/** The ledger block as a picture, all of it even past the screen's bottom. */
async function capture(tab: Tab, name: string) {
	const folder = process.env.LAT_BOARD_SHOTS;
	if (!folder) return;
	// The composer and other fixed bars would cover the block in a picture taller than the screen.
	await tab.eval(`document.head.insertAdjacentHTML('beforeend', '<style id="shot-hide">' + [...document.querySelectorAll('body *')].filter((el) => ['fixed', 'sticky'].includes(getComputedStyle(el).position) && !el.closest('.ledger')).map((el, index) => (el.dataset.shotHide = index, '[data-shot-hide="' + index + '"]')).join(',') + '{visibility:hidden !important} *:has(.detail .ledger){overflow:visible !important;height:auto !important;max-height:none !important}</style>')`);
	const box = await tab.eval<{ x: number; y: number; width: number; height: number }>(
		`(() => { const r = document.querySelector('.detail .ledger').getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; })()`
	);
	const { data } = (await tab.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...box, x: Math.max(0, box.x - 8), width: box.width + 16, height: box.height + 8, scale: 1 } })) as { data: string };
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, `${name}.png`), Buffer.from(data, 'base64'));
	await tab.eval(`document.getElementById('shot-hide')?.remove()`);
}

const toggle = (tab: Tab, ref: string) => tab.eval(`${lineOf(ref)}.querySelector('summary').click()`);
const opened = (tab: Tab, ref: string) => tab.eval<boolean>(`(() => { const rows = ${lineOf(ref)}.querySelector('.rows'); return rows.checkVisibility(); })()`);

test.skipIf(!CHROME)('each ticket is one line with its link, title, steps, now, models and time, opening to its rows and evidence', async () => {
	const tab = browser!.tab;
	const [luna] = fixture.listed();
	await openLedger(tab, luna.session_id, DESKTOP);

	expect(await tab.eval(`document.querySelector('.detail [data-tab="ledger"]').innerText.replace(/\\s+/g, ' ')`)).toBe('工作總表 7');
	expect(await tab.eval(flat(`document.querySelector('.detail .ledger .counts')`))).toBe('7 張票：1 張進行中、1 張受阻、1 張已上線、2 張已合併、1 張已結案、1 張已取消');
	expect(await tab.eval(`${LINES}.map((li) => li.querySelector('.ref').innerText.split(/\\s/)[0])`)).toEqual(['#533', '#534', '#535', '#540', '#541', '#536', 'ledger-fields']);

	// The in-progress line: link and title, the strip, what it is doing now, models, time.
	const line = lineOf('#533');
	expect(await tab.eval(`${line}.querySelector('.ref a').href`)).toBe('https://github.com/ouob-tw/LoopAgentTeams-work/issues/533');
	expect(await tab.eval(flat(`${line}.querySelector('.title')`))).toBe('主控職責文字顯示連結');
	expect(await tab.eval(`[...${line}.querySelectorAll('.step')].map((step) => step.dataset.step)`)).toEqual(['done', 'done', 'done', 'active', 'pending', 'pending']);
	expect(await tab.eval(flat(`${line}.querySelector('.now')`))).toBe('驗收進行中・zapi-t533-qa・「第三次長度修正仍失敗」・超過預計 12 分');
	expect(await tab.eval(`[...${line}.querySelectorAll('.model')].map((model) => model.innerText.replace(/\\s+/g, ' '))`)).toEqual(['實作 opus-5.5・medium', '驗收 gpt-6.1-terra・medium']);
	expect(await tab.eval(flat(`${line}.querySelector('.time')`))).toBe('已 48 分・修 3 輪');
	expect(await tab.eval(`${line}.classList.contains('late')`)).toBe(true);
	// In the board's panel at this width: the ticket and its time on one row, the strip beside now.
	const top = (part: string) => `${line}.querySelector('${part}').getBoundingClientRect().top`;
	expect(await tab.eval(`${top('.ref')} === ${top('.time')} && ${top('.steps')} === ${top('.now')} && ${top('.steps')} > ${top('.ref')}`)).toBe(true);
	// Zero rounds of rework say nothing.
	expect(await tab.eval(flat(`${lineOf('#540')}.querySelector('.time')`))).toBe('40 分');

	// Each step state looks different, by its mark and its colours, not colour alone.
	const looks = await tab.eval<Record<string, string>>(
		`Object.fromEntries(['done', 'active', 'pending', 'skipped'].map((state) => { const step = document.querySelector('.detail .ledger .step[data-step="' + state + '"]'); const style = getComputedStyle(step); return [state, step.querySelector('.mark').innerText + '|' + style.color + '|' + style.backgroundColor + '|' + style.borderStyle + '|' + style.textDecorationLine]; }))`
	);
	expect(new Set(Object.values(looks)).size).toBe(4);
	expect(Object.values(looks).map((look) => look.split('|')[0])).toEqual(['✓', '●', '○', '—']);

	// Closed lines show no rows; the blocked one opens to its reason and progress, and closes.
	expect(await tab.eval(`[...document.querySelectorAll('.detail .ledger .rows')].filter((rows) => rows.checkVisibility()).length`)).toBe(0);
	await capture(tab, 'ledger-desktop-closed');
	expect(await tab.eval(flat(`${lineOf('#535')}.querySelector('.now')`))).toContain('受阻：等使用者決定 ZAPI-524-3');
	await toggle(tab, '#535');
	expect(await opened(tab, '#535')).toBe(true);
	const fields = await tab.eval<[string, string][]>(`[...${lineOf('#535')}.querySelectorAll('.row dt')].map((dt) => [dt.innerText, dt.nextElementSibling.innerText.trim()])`);
	expect(fields).toEqual([['#', '4'], ['階段', '實作'], ['負責', 'zapi-t535-impl'], ['模型・思考程度', 'opus-5.5・high'], ['狀態', '受阻：等使用者決定 ZAPI-524-3'], ['用時', '1 小時 0 分'], ['最新進度', '前兩項已完成']]);
	await toggle(tab, '#535');
	expect(await opened(tab, '#535')).toBe(false);

	// A cancelled ticket's reason is in its now cell and its opened row.
	expect(await tab.eval(flat(`${lineOf('#536')}.querySelector('.now')`))).toBe('已取消：併入 #536 的下一版');
	await toggle(tab, '#536');
	expect(await tab.eval(flat(`${lineOf('#536')}.querySelector('[data-label="狀態"]')`))).toBe('已取消：併入 #536 的下一版');

	// The deployed ticket's evidence: the commit on GitHub, the report served, the gate as text.
	await toggle(tab, '#534');
	await toggle(tab, '#535');
	const evidence = `${lineOf('#534')}.querySelector('.row .evidence')`;
	expect(await tab.eval(`[...${evidence}.querySelectorAll('a')].map((a) => a.innerText)`)).toEqual(['42f5bed0', 'report-2026-11-12-zapi-t534-board-title-link-final-candidate.md']);
	const [commit, report] = await tab.eval<string[]>(`[...${evidence}.querySelectorAll('a')].map((a) => a.href)`);
	expect(commit).toBe('https://github.com/ouob-tw/LoopAgentTeams/commit/42f5bed0c0ffee12345678901234567890abcdef');
	expect(await tab.eval(`fetch(${JSON.stringify(report)}).then(async (response) => response.status + ' ' + await response.text())`)).toBe('200 # #534 report\n');
	expect(await tab.eval(flat(`${evidence}.querySelector('code')`))).toBe('測試 e52bc2ca');
	await capture(tab, 'ledger-desktop-open');
	expect(await tab.eval(`document.documentElement.scrollWidth <= window.innerWidth`)).toBe(true);
}, 60_000);

test.skipIf(!CHROME)('at a phone width each ticket is a card inside the page, its text wrapped, not cut', async () => {
	const tab = browser!.tab;
	const [luna] = fixture.listed();
	await openLedger(tab, luna.session_id, PHONE);
	await capture(tab, 'ledger-phone-closed');
	await toggle(tab, '#534');
	await toggle(tab, '#535');

	// Content wider than a phone widens its layout viewport past the screen, so the bound is the
	// screen's own width: no horizontal page scroll means the page is exactly that wide.
	expect(await tab.eval(`[innerWidth, document.documentElement.scrollWidth]`)).toEqual([PHONE.width, PHONE.width]);
	// Nothing in the block reaches past the screen's edge, nor is cut inside its own box.
	const outside = await tab.eval<string[]>(
		`[...document.querySelectorAll('.detail .ledger *')].filter((el) => el.getClientRects().length && (el.getBoundingClientRect().right > ${PHONE.width} + 0.5 || el.getBoundingClientRect().left < -0.5 || el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible')).map((el) => el.className || el.tagName)`
	);
	expect(outside).toEqual([]);
	// The cells stack: the strip sits below the ticket, now below the strip.
	const tops = await tab.eval<number[]>(`['.ref', '.steps', '.now', '.models', '.time'].map((part) => ${lineOf('#533')}.querySelector(part).getBoundingClientRect().top)`);
	expect(tops).toEqual([...tops].sort((a, b) => a - b));
	expect(new Set(tops).size).toBe(5);
	// An opened row's labels sit beside their values.
	expect(await tab.eval(`(() => { const dt = ${lineOf('#535')}.querySelector('.row dt:nth-of-type(5)'); return dt.getBoundingClientRect().top === dt.nextElementSibling.getBoundingClientRect().top; })()`)).toBe(true);
	await capture(tab, 'ledger-phone-open');
}, 60_000);

test.skipIf(!CHROME)('a project without deploy history shows five steps', async () => {
	const tab = browser!.tab;
	const [, nova] = fixture.listed();
	await openLedger(tab, nova.session_id, DESKTOP);

	expect(await tab.eval(`[...document.querySelectorAll('.detail .ledger .step')].map((step) => step.innerText.replace(/\\s+/g, ''))`)).toEqual(['✓草稿', '●實作', '○審查', '○驗收', '○合併']);
	await capture(tab, 'ledger-desktop-five-steps');
}, 60_000);

