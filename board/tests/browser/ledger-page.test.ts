// A controller's work ledger on its page in a real browser: one line per ticket with its link,
// title, progress strip, now cell, models and time; a line opens to its rows with their reasons
// and evidence, which open; a project without deploy history has five steps; at a phone's width
// each line is a card inside the page. Each line counts the problems found per stage, an opened
// one lists them, and the bottom sums them per stage. Skipped when the host has no Chrome. With LAT_BOARD_SHOTS
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

	// The deployed ticket's impl row: when it closed, how much it changed, how long its tests ran
	// (execution only, said so), beside its rework rounds on the line.
	await toggle(tab, '#534');
	await toggle(tab, '#535');
	expect(await tab.eval(flat(`${lineOf('#534')}.querySelector('.time')`))).toBe('58 分・修 1 輪');
	const figures = await tab.eval<[string, string][]>(`[...${lineOf('#534')}.querySelector('.row').querySelectorAll('dt')].filter((dt) => ['結案時間', '改動大小', '測試執行時間'].includes(dt.innerText)).map((dt) => [dt.innerText, dt.nextElementSibling.innerText.replace(/\\s+/g, ' ').trim()])`);
	expect(figures).toEqual([['結案時間', '17:51:00'], ['改動大小', '程式 3 檔 120 行、測試 2 檔 84 行、文件 1 檔 6 行'], ['測試執行時間', '3 分 20 秒・2 次・沿用先前結果 1 次 排隊時間沒有紀錄，不算在內']]);
	// Its acceptance row closed before the figures existed: no such lines.
	expect(await tab.eval(`[...${lineOf('#534')}.querySelectorAll('.row')][1].innerText.includes('測試執行時間')`)).toBe(false);
	// The deployed ticket's evidence: the commit on GitHub, the report served, the gate as text.
	const evidence = `${lineOf('#534')}.querySelector('.row .evidence')`;
	expect(await tab.eval(`[...${evidence}.querySelectorAll('a')].map((a) => a.innerText)`)).toEqual(['42f5bed0', 'report-2026-11-12-zapi-t534-board-title-link-final-candidate.md']);
	const [commit, report] = await tab.eval<string[]>(`[...${evidence}.querySelectorAll('a')].map((a) => a.href)`);
	expect(commit).toBe('https://github.com/ouob-tw/LoopAgentTeams/commit/42f5bed0c0ffee12345678901234567890abcdef');
	expect(await tab.eval(`fetch(${JSON.stringify(report)}).then(async (response) => response.status + ' ' + await response.text())`)).toBe('200 # #534 report\n');
	expect(await tab.eval(flat(`${evidence}.querySelector('code')`))).toBe('測試 e52bc2ca');
	await capture(tab, 'ledger-desktop-open');
	expect(await tab.eval(`document.documentElement.scrollWidth <= window.innerWidth`)).toBe(true);
}, 60_000);

test.skipIf(!CHROME)('each line counts problems per stage, 甲 and 乙 standing out; an opened line lists them; the bottom sums each stage', async () => {
	const tab = browser!.tab;
	const [luna] = fixture.listed();
	await openLedger(tab, luna.session_id, DESKTOP);
	const counts = (ref: string) => tab.eval<string[]>(`[...${lineOf(ref)}.querySelectorAll('.finding')].map((entry) => entry.innerText.trim() + (entry.classList.contains('severe') ? ' !' : '') + (entry.classList.contains('none') ? ' 0' : ''))`);
	expect(await counts('#533')).toEqual(['自動測試 1', '審查 1', '驗收 1（甲 1） !']);
	// Done stages show 0, muted, so "looked and found nothing" differs from "not looked yet".
	expect(await counts('#534')).toEqual(['審查 1（乙 1） !', '驗收 0 0', '上線後（使用者） 0 0']);
	expect(await counts('#541')).toEqual(['審查 0 0']);
	expect(await tab.eval(`${lineOf('#535')}.querySelector('.findings')`)).toBe(null);
	// 甲/乙 stand out by colour, weight and a box, not colour alone.
	const look = (selector: string) => `(() => { const style = getComputedStyle(document.querySelector('.detail .ledger ${selector}')); return [style.color, style.fontWeight, style.borderTopStyle].join('|'); })()`;
	const [severe, plain, none] = await Promise.all(['.finding.severe', '.finding:not(.severe):not(.none)', '.finding.none'].map((selector) => tab.eval<string>(look(selector))));
	expect(new Set([severe, plain, none]).size).toBe(3);
	expect(severe.split('|').slice(1)).toEqual(['700', 'solid']);
	// In the board's panel: the counts sit under the models, beside the strip.
	const top = (part: string) => `${lineOf('#533')}.querySelector('${part}').getBoundingClientRect()`;
	expect(await tab.eval(`${top('.findings')}.top >= ${top('.models')}.bottom && ${top('.findings')}.left === ${top('.models')}.left`)).toBe(true);

	// An opened line lists its problems: level, line, stage, finder, a test catching it, outcome.
	await toggle(tab, '#533');
	expect(await tab.eval(`[...${lineOf('#533')}.querySelectorAll('.problem')].map((li) => li.innerText.replace(/\\s+/g, ' ').trim())`)).toEqual([
		'丙 長標題換行的測試失敗 自動測試・suite-gate・第 1 版・17:40:00・測試抓到',
		'丙 函式命名與既有的不一致 審查・zapi-t533-rev・第 1 版・17:40:00・列為已知限制',
		'甲 手機上職責連結被截斷，點不到 驗收・zapi-t533-qa・第 2 版・17:55:00'
	]);
	await toggle(tab, '#534');
	expect(await tab.eval(flat(`${lineOf('#534')}.querySelector('.problem')`))).toBe('乙 每次推送都重畫所有已送出的標題 審查・zapi-t534-rev・第 1 版・17:40:00・已修 42f5bed0c0ff');

	// The bottom: one row per stage, each problem once (the shared row's, the unknown cause's).
	const table = `document.querySelector('.detail .ledger .stage-summary')`;
	expect(await tab.eval(flat(`${table}.querySelector('caption')`))).toBe('哪個階段找出多少問題');
	expect(await tab.eval(`[...${table}.rows].map((row) => [...row.cells].map((cell) => cell.innerText.trim()).join(' '))`)).toEqual([
		'發現階段 甲 乙 丙 合計 測試抓到',
		'自動測試 0 0 1 1 1',
		'審查 0 1 2 3 0',
		'驗收 1 0 0 1 0',
		'上線後（使用者） 0 1 0 1 0'
	]);
	// Its 甲 and 乙 cells with problems stand out like the line's counts.
	expect(await tab.eval(`[...${table}.querySelectorAll('td.hit')].map((cell) => cell.dataset.level + getComputedStyle(cell).fontWeight)`)).toEqual(['丙400', '乙700', '丙400', '甲700', '乙700']);
	expect(await tab.eval(`${table}.getBoundingClientRect().top > ${LINES}.at(-1).getBoundingClientRect().bottom - 1`)).toBe(true);
	await capture(tab, 'ledger-findings-desktop');
	expect(await tab.eval(`document.documentElement.scrollWidth <= window.innerWidth`)).toBe(true);
}, 60_000);

test.skipIf(!CHROME)('at a phone width each ticket is a card inside the page, its text wrapped, not cut', async () => {
	const tab = browser!.tab;
	const [luna] = fixture.listed();
	await openLedger(tab, luna.session_id, PHONE);
	await capture(tab, 'ledger-phone-closed');
	await toggle(tab, '#533');
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
	const tops = await tab.eval<number[]>(`['.ref', '.steps', '.now', '.models', '.findings', '.time'].map((part) => ${lineOf('#533')}.querySelector(part).getBoundingClientRect().top)`);
	expect(tops).toEqual([...tops].sort((a, b) => a - b));
	expect(new Set(tops).size).toBe(6);
	// A count is never split across lines: each stays one line high.
	expect(await tab.eval(`[...document.querySelectorAll('.detail .ledger .finding')].every((entry) => entry.getClientRects().length === 1)`)).toBe(true);
	// An opened row's labels sit beside their values.
	expect(await tab.eval(`(() => { const dt = ${lineOf('#535')}.querySelector('.row dt:nth-of-type(5)'); return dt.getBoundingClientRect().top === dt.nextElementSibling.getBoundingClientRect().top; })()`)).toBe(true);
	await capture(tab, 'ledger-phone-open');
	// The row's figures wrap between parts, never inside one (程式 3 檔 120 行 stays together).
	expect(await tab.eval(`[...${lineOf('#534')}.querySelectorAll('.figure')].map((part) => part.getClientRects().length)`)).toEqual([1, 1, 1, 1, 1, 1]);
	// The bottom summary fits the phone's width with every column.
	expect(await tab.eval(`(() => { const r = document.querySelector('.detail .ledger .stage-summary').getBoundingClientRect(); return r.left >= 0 && r.right <= ${PHONE.width}; })()`)).toBe(true);
}, 60_000);

test.skipIf(!CHROME)('a project without deploy history shows five steps', async () => {
	const tab = browser!.tab;
	const [, nova] = fixture.listed();
	await openLedger(tab, nova.session_id, DESKTOP);

	expect(await tab.eval(`[...document.querySelectorAll('.detail .ledger .step')].map((step) => step.innerText.replace(/\\s+/g, ''))`)).toEqual(['✓草稿', '●實作', '○審查', '○驗收', '○合併']);
	await capture(tab, 'ledger-desktop-five-steps');
}, 60_000);


// A closed ticket line's text cells are never squeezed by the progress strip (#556): at every panel
// width from a phone's to the widest, in the default and larger text, the block has no sideways
// scroll, the time stays on one line and no cell is narrower than a few words.
/** Panel widths in px, and the text sizes (--min-font in px; null the default) the sweep covers. */
const WIDTHS = [320, 360, 480, 510, 517, 518, 519, 520, 530, 540, 544, 546, 558, 560, 580, 600, 620, 640, 680, 740, 760, 780, 900];
const FONTS = [null, 20, 28];

test.skipIf(!CHROME)('the ticket lines are not squeezed at any panel width or text size', async () => {
	const tab = browser!.tab;
	const [luna] = fixture.listed();
	await openLedger(tab, luna.session_id, { ...DESKTOP, width: 1400 });
	const squeezed: string[] = [];
	// The lines closed: what is measured is the ticket list, not the opened rows' details.
	// The longest time a line shows (14 hours and more), which the fixture's short ones do not reach.
	await tab.eval(`document.querySelectorAll('.detail .ledger .time').forEach((time) => { time.textContent = '已 14 小時 58 分・修 2 輪'; })`);
	await tab.eval(`document.querySelectorAll('.detail .ledger details[open]').forEach((details) => details.removeAttribute('open'))`);
	for (const font of FONTS) {
		for (const width of WIDTHS) {
			const probe = await tab.eval<{ scrollsSideways: boolean; cells: string[]; past: string[] }>(
				`(() => {
					const root = document.documentElement;
					${font === null ? `root.style.removeProperty('--min-font')` : `root.style.setProperty('--min-font', '${font}px')`};
					const ledger = document.querySelector('.detail .ledger');
					ledger.style.cssText = 'width:${width}px;max-width:none;flex:none';
					const em = parseFloat(getComputedStyle(ledger).fontSize);
					const cells = [];
					for (const li of ${LINES}) {
						const ref = li.querySelector('.ref').innerText.split(/\\s/)[0];
						const time = li.querySelector('.time').getBoundingClientRect();
						const cell = li.querySelector('.time');
						const kept = cell.style.whiteSpace;
						cell.style.whiteSpace = 'nowrap';
						const fits = cell.scrollWidth + 2 <= cell.clientWidth;
						cell.style.whiteSpace = kept;
						// Wrapping is only wrong where the whole text would have fitted.
						if (fits && time.height > em * 2) cells.push('time wraps in ' + ref);
						for (const part of ['.now', '.models']) {
							const box = li.querySelector(part).getBoundingClientRect();
							if (box.height && box.width < 7 * em /* under about eight characters */) cells.push(part + ' in ' + ref + ' is ' + Math.round(box.width) + 'px wide');
						}
					}
					const edge = ledger.getBoundingClientRect().right + 0.5;
					const past = [...ledger.querySelectorAll('*')].filter((el) => el.checkVisibility() && el.getBoundingClientRect().right > edge).map((el) => el.tagName + '.' + el.className.split(' ')[0]); return { past, scrollsSideways: ledger.scrollWidth > ledger.clientWidth || past.length > 0, cells };
				})()`
			);
			if (probe.scrollsSideways) squeezed.push(`${font ?? 'default'}/${width}: scrolls sideways ${probe.past.slice(0, 4)}`);
			for (const cell of probe.cells) squeezed.push(`${font ?? 'default'}/${width}: ${cell}`);
			if (font === null || font === 28) await capture(tab, `ledger-${font ?? 'default'}-${width}`);
		}
	}
	expect(squeezed).toEqual([]);

	// Wide enough in the default text: the strip stays on one row beside now, as before.
	await tab.eval(`(() => { document.documentElement.style.removeProperty('--min-font'); document.querySelector('.detail .ledger').style.cssText = 'width:740px;max-width:none;flex:none'; })()`);
	const line = lineOf('#534');
	expect(await tab.eval(`(() => { const tops = new Set([...${line}.querySelectorAll('.step')].map((step) => step.getBoundingClientRect().top)); const now = ${line}.querySelector('.now').getBoundingClientRect().left; const steps = ${line}.querySelector('.steps').getBoundingClientRect(); return tops.size === 1 && steps.right <= now; })()`)).toBe(true);
}, 120_000);
