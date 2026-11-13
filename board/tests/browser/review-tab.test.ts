// The 回顧 tab in real browsers on one built board, the real helper and lat-unattended: no tab
// before a review exists; the tab right after 對話紀錄 with the parked count; the banner with the
// cross-check, the goal folded and opened to every version, 最該先看, the sections, items folded to
// a title and one line and opened to their reasons; 回覆 on parked items and 推翻 on the rest;
// a comment box sending the item's ID, title and words to the controller and into 送出紀錄, and
// keeping the words when the send fails; the review rewritten by the controller reaching the page
// within five seconds; the old assumptions still open to 推翻 after the grant is turned off; at
// 1280 and 390 wide nothing scrolls sideways and the first two items sit above the input row.
// With LAT_BOARD_SHOTS set every look is saved there. Headless Chrome over its DevTools protocol;
// skipped when the host has no Chrome.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { NODE, sleep, startFixture, uvPython, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, shot, type Browser, type Tab } from '../browser.ts';
import { writeRound } from '../review-fixture.ts';
import type { HelperController } from '../../src/lib/board/types.ts';

const TOOL = join(import.meta.dirname, '../../../skills/local/lat/scripts/lat-unattended.py');
const WIDE = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };
const FORM = { goal: '#577 按鈕字改「儲存」、#578 修錯字，明早 07:30 前做完', done: ['#577、#578 都合併進開發分支', '測試全過'], scope: { ticket_confirmation: true, assume_defaults: true, prototype_decide: true }, maxHours: 12 };

const TAB = '[data-tab="review"]';
const PANEL = '#panel-review';
const item = (id: string) => `${PANEL} [data-item="${id}"]`;
const NO_SIDEWAYS = `document.scrollingElement.scrollWidth <= innerWidth`;
const text = (selector: string) => `(document.querySelector(${JSON.stringify(selector)})?.innerText ?? '')`;

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
	luna = fixture.bound('alpha', 'luna');
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
	expect(run.status).toBe(0);
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

test.skipIf(!CHROME)('the tab follows 對話紀錄 with the parked count; the banner, goal and folded items read right', async () => {
	const tab = browsers[0].tab;
	writeRound(luna.workspace, luna.session_id);
	tool('review', 'update');
	await tab.until(`!!document.querySelector('${TAB}')`, 'the 回顧 tab appearing without a reload');
	expect((await tabNames(tab)).slice(0, 2)).toEqual(['transcript', 'review']);
	expect(await tab.eval(text(TAB))).toMatch(/^回顧\s*3$/);

	await click(tab, TAB);
	await tab.until(`!!document.querySelector('${PANEL} .banner')`, 'the panel');
	const banner = await tab.eval<string>(text(`${PANEL} .banner`));
	expect(banner).toContain('擱置等你的事：3 項');
	expect(banner).toContain('尚未核對');

	// The goal is one line until opened; opened it shows the version and its conditions.
	expect(await tab.eval<string>(text(`${PANEL} .goal .line`))).toContain(`目標：${FORM.goal} · 條件 2 條`);
	expect(await tab.eval(`!!document.querySelector('${PANEL} .goal .versions')`)).toBe(false);
	await click(tab, `${PANEL} .goal .line`);
	await tab.until(`!!document.querySelector('${PANEL} .goal .versions')`, 'the goal opened');
	const goal = await tab.eval<string>(text(`${PANEL} .goal .versions`));
	expect(goal).toContain('第 1 版');
	expect(goal).toContain('你在看板開啟');
	expect(goal).toContain('測試全過');
	await click(tab, `${PANEL} .goal .line`);

	// Each section is there, 最該先看 first, in the file's order.
	expect(await tab.eval<string[]>(`[...document.querySelectorAll('${PANEL} h4')].map((h) => h.innerText)`)).toEqual(['最該先看的幾項', '假設', '自動做的動作', '本輪完成的票']);
	expect(await tab.eval<string[]>(`[...document.querySelectorAll('${PANEL} [data-section="top"] [data-item]')].map((entry) => entry.dataset.item)`)).toEqual(['LAT-P1', 'LAT-P2', 'row-3', 'LAT-PC', 'LAT-AU']);

	// Folded: a title and one line of 做了; the reasons are not shown. A long line stays one line.
	for (const id of ['LAT-P1', 'LAT-AU', 'LAT-PC']) {
		const shape = await tab.eval<{ title: string; did: string; oneLine: boolean; open: boolean }>(`(() => {
			const entry = document.querySelector(${JSON.stringify(item(id))});
			const did = entry.querySelector('.did');
			return { title: entry.querySelector('.title').innerText, did: did.innerText, oneLine: did.getBoundingClientRect().height < parseFloat(getComputedStyle(did).lineHeight) * 1.5, open: entry.querySelector('details').open };
		})()`);
		expect(shape.oneLine).toBe(true);
		expect(shape.open).toBe(false);
		expect(shape.did).toMatch(/^做了：/);
	}
	expect(await tab.eval<string>(text(`${item('LAT-P1')} .title`))).toBe('要不要加匯出功能');

	// Opened: the reason, the evidence and how to overturn it.
	await click(tab, `${item('LAT-AU')} summary`);
	await tab.until(`document.querySelector('${item('LAT-AU')} details').open`, 'the reasons opened');
	const reasons = await tab.eval<string>(text(`${item('LAT-AU')} dl`));
	expect(reasons).toContain('固定清單 setting-default');
	expect(reasons).toContain('LAT-AU.md');
	expect(reasons).toContain('改成 7 天或 90 天');
	await shot(tab, '1280-review-tab');
	expect(await tab.eval(NO_SIDEWAYS)).toBe(true);
});

test.skipIf(!CHROME)('回覆 on a parked item and 推翻 on every other kind', async () => {
	const tab = browsers[0].tab;
	const buttons = await tab.eval<Record<string, string>>(`Object.fromEntries([...document.querySelectorAll('${PANEL} [data-item]')].map((entry) => [entry.dataset.item, entry.querySelector('button.act')?.innerText ?? '']))`);
	expect(buttons).toMatchObject({ 'LAT-P1': '回覆', 'LAT-P2': '回覆', 'row-3': '回覆', 'LAT-PC': '推翻', 'LAT-AU': '推翻', 'LAT-AN': '推翻', 'auto-1': '推翻', 'auto-2': '推翻' });
});

test.skipIf(!CHROME)('the comment box sends the item ID, title and words to the controller and logs them; a failed send keeps the words', async () => {
	const tab = browsers[0].tab;
	await click(tab, `${item('LAT-AU')} button.act`);
	await tab.until(`!!document.querySelector('${item('LAT-AU')} textarea')`, 'the comment box');
	// Nothing to send until something is written.
	expect(await tab.eval(`document.querySelector('${item('LAT-AU')} button.send').disabled`)).toBe(true);
	await shot(tab, '1280-review-comment-box');
	await type(tab, `${item('LAT-AU')} textarea`, '改成 7 天');
	await click(tab, `${item('LAT-AU')} button.send`);
	await tab.until(`!document.querySelector('${item('LAT-AU')} textarea')`, 'the box closed after sending');
	expect(typed().map((line) => line.text).join('')).toBe('回顧項目 LAT-AU「備份預設留 30 天」推翻：改成 7 天');
	// It is in 送出紀錄 like any message to the controller.
	await click(tab, '[data-tab="sent"]');
	await tab.until(`${text('#panel-sent')}.includes('回顧項目 LAT-AU')`, 'the sent log showing it');
	expect(await tab.eval<string>(text('#panel-sent'))).toContain('推翻：改成 7 天');
	await click(tab, TAB);

	// A send that fails keeps the words and says why.
	writeFileSync(join(injectDir, 'inject.json'), JSON.stringify({ [luna.hcom_name]: { exit: 1, stdout: '輸入框壞了' } }));
	await click(tab, `${item('LAT-P1')} button.act`);
	await tab.until(`!!document.querySelector('${item('LAT-P1')} textarea')`, 'the reply box');
	await type(tab, `${item('LAT-P1')} textarea`, '加，CSV 就好');
	await click(tab, `${item('LAT-P1')} button.send`);
	await tab.until(`!!document.querySelector('${item('LAT-P1')} .failed')`, 'the failure shown');
	expect(await tab.eval<string>(text(`${item('LAT-P1')} .failed`))).toContain('輸入框壞了');
	expect(await tab.eval(`document.querySelector('${item('LAT-P1')} textarea').value`)).toBe('加，CSV 就好');
	await shot(tab, '1280-review-send-failed');
	rmSync(join(injectDir, 'inject.json'), { force: true });
	await click(tab, `${item('LAT-P1')} button.send`);
	await tab.until(`!document.querySelector('${item('LAT-P1')} textarea')`, 'the retry sent');
	expect(typed().at(-2)?.text).toBe('回顧項目 LAT-P1「要不要加匯出功能」回覆：加，CSV 就好');
});

test.skipIf(!CHROME)('a review the controller rewrites shows within five seconds; the cross-check shows; turning the grant off leaves 推翻 on the old assumptions', async () => {
	const tab = browsers[0].tab;
	writeRound(luna.workspace, luna.session_id, { parkedRecords: 3 });
	const wrote = Date.now();
	tool('review', 'update');
	await tab.until(`${text(TAB)}.replace(/\\s+/g, '') === '回顧4'`, 'the new count', 5_000);
	expect(Date.now() - wrote).toBeLessThan(5_000);
	await tab.until(`!!document.querySelector('${item('LAT-P3')}')`, 'the new item');

	// The user's own change of the goal is listed as a version of its own, the older one marked replaced.
	expect((await grant({ op: 'update', ...FORM, goal: '#577、#578 都做完，再補 #579' })).status).toBe(200);
	await tab.until(`${text(`${PANEL} .goal .line`)}.includes('改過 1 次')`, 'the goal line counting the change', 5_000);
	await click(tab, `${PANEL} .goal .line`);
	await tab.until(`!!document.querySelector('${PANEL} .goal .versions')`, 'the versions');
	const versions = await tab.eval<string[]>(`[...document.querySelectorAll('${PANEL} .goal .versions > li')].map((entry) => entry.innerText)`);
	expect(versions).toHaveLength(2);
	expect(versions[0]).toContain('第 2 版');
	expect(versions[0]).toContain('你修改');
	expect(versions[0]).toContain('#577、#578 都做完，再補 #579');
	expect(versions[1]).toContain('第 1 版');
	expect(versions[1]).toContain('已被後面的版本取代');
	await shot(tab, '1280-review-goal-versions', { box: `${PANEL} .goal` });
	await click(tab, `${PANEL} .goal .line`);

	const total = await tab.eval<number>(`document.querySelectorAll('${PANEL} [data-item]').length`);
	tool('review', 'verify', '--checker', 'kiwi', '--family', 'gpt', '--total', String(total), '--matched', String(total));
	await tab.until(`${text(`${PANEL} .banner`)}.includes('Codex 已核對紀錄：${total} 項全相符')`, 'the cross-check shown', 5_000);

	expect((await grant({ op: 'close' })).status).toBe(200);
	// The grant ending is no change to what the check vouched for: it still stands.
	await click(tab, `${PANEL} .goal .line`);
	await tab.until(`${text(`${PANEL} .goal .versions`)}.includes('使用者關掉')`, 'the goal showing the grant ended', 5_000);
	expect(await tab.eval<string>(text(`${PANEL} .banner`))).toContain('已核對紀錄');
	expect(await tab.eval(`!!document.querySelector('${TAB}')`)).toBe(true);
	for (const id of ['LAT-AU', 'LAT-AN', 'LAT-PC']) expect(await tab.eval<string>(text(`${item(id)} button.act`))).toBe('推翻');
});

test.skipIf(!CHROME)('at 390 wide nothing scrolls sideways and the first two items sit above the input row', async () => {
	const tab = await browse(PHONE);
	// Clicked until the page has taken over its buttons.
	await tab.until(`(document.querySelector('${TAB}')?.click(), document.querySelector('${TAB}')?.getAttribute('aria-selected') === 'true')`, 'the tab opened');
	await tab.until(`document.querySelector('${item('LAT-P1')}')?.getBoundingClientRect().height > 0`, 'the items shown');
	await sleep(300);
	expect(await tab.eval(NO_SIDEWAYS)).toBe(true);
	// The page may scroll, but at its start the first two items are whole above the input row.
	const frame = await tab.eval<{ cmdTop: number; first: number[]; second: number[] }>(`(() => {
		const [one, two] = [...document.querySelectorAll('${PANEL} [data-item]')].slice(0, 2).map((entry) => entry.getBoundingClientRect());
		return { cmdTop: document.querySelector('.cmd').getBoundingClientRect().top, first: [one.top, one.bottom], second: [two.top, two.bottom] };
	})()`);
	expect(frame.first[1] - frame.first[0]).toBeGreaterThan(40);
	expect(frame.second[1] - frame.second[0]).toBeGreaterThan(40);
	expect(frame.first[0]).toBeGreaterThanOrEqual(0);
	expect(frame.second[1]).toBeLessThanOrEqual(frame.cmdTop);
	await shot(tab, '390-review-tab');
	// Every button and the folded line are touchable and readable.
	const small = await tab.eval<string[]>(`[...document.querySelectorAll('${PANEL} button, ${PANEL} summary')].filter((el) => el.offsetParent !== null).filter((el) => { const box = el.getBoundingClientRect(); return box.height < 44 - 1; }).map((el) => el.innerText)`);
	expect(small).toEqual([]);
	const tiny = await tab.eval<number>(`Math.min(...[...document.querySelectorAll('${PANEL} *')].filter((el) => el.childNodes.length && [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim())).map((el) => parseFloat(getComputedStyle(el).fontSize)))`);
	expect(tiny).toBeGreaterThanOrEqual(16);
	await click(tab, `${item('LAT-AU')} button.act`);
	await tab.until(`!!document.querySelector('${item('LAT-AU')} textarea')`, 'the box on the phone');
	expect(await tab.eval(NO_SIDEWAYS)).toBe(true);
	await shot(tab, '390-review-comment-box', { box: `${item('LAT-AU')} textarea` });
	await click(tab, `${item('LAT-AU')} summary`);
	await shot(tab, '390-review-item-open', { box: `${item('LAT-AU')} dl` });
	await click(tab, `${PANEL} .goal .line`);
	await shot(tab, '390-review-goal-open', { box: `${PANEL} .goal` });
	expect(await tab.eval(NO_SIDEWAYS)).toBe(true);
});
