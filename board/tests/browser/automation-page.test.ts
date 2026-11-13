// The 自動化 tab in a real browser, at 1280px and at a phone's 390px: the list with each task's
// state, window, next try and last result; a task's page with its settings and run records; the
// edit form switching its fields by schedule type and kind, answering wrong fields in place and
// writing nothing; 立即執行 and its record; pause and resume; a change made elsewhere showing up;
// the phone's back from a task to the list. Frames go to LAT_BOARD_SHOTS when it is set.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, shot, type Browser, type Tab } from '../browser.ts';
import type { AutomationSnapshot, AutomationTask } from '../../src/lib/board/automation.ts';

const SCREEN = `({ search: location.search, middle: document.querySelector('.inbox')?.innerText.slice(0, 400) ?? '', detail: document.querySelector('.detail')?.innerText.slice(0, 400) ?? '' })`;
/** Nothing reaches past the window's width, and nothing in the middle or content column past its own box. */
const FITS = `document.documentElement.scrollWidth <= window.innerWidth && [...document.querySelectorAll('.automation, .automation *, .detail .task, .detail .task *, .detail form, .detail form *')].filter((node) => !node.closest('pre')).every((node) => node.scrollWidth <= node.clientWidth + 1)`;

let fixture: Fixture;
let cookie: string;
let work: string;
let browser: Browser | undefined;
let tab: Tab;
const ids: Record<string, string> = {};

const send = (path: string, method: string, body?: unknown) =>
	fixture.fetch(path, { method, cookie, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const snapshot = async (): Promise<AutomationSnapshot> => (await fixture.fetch('/api/automation', { cookie })).json();
async function create(body: object): Promise<AutomationTask> {
	const response = await send('/api/automation', 'POST', body);
	if (response.status !== 201) throw new Error(`create: ${response.status} ${await response.text()}`);
	return response.json();
}
async function runToEnd(id: string) {
	await send(`/api/automation/${id}/run`, 'POST');
	for (let i = 0; i < 200; i++) {
		const view = (await snapshot()).tasks.find((entry) => entry.task.id === id)!;
		if (view.runs[0] && view.runs[0].status !== 'running') return;
		await Bun.sleep(50);
	}
	throw new Error('run did not end');
}
const command = (name: string, schedule: object, time: string, line: string, checks: object[] = []) => ({
	name,
	schedule,
	time,
	limitMinutes: 30,
	kind: 'command',
	command: { command: line, folder: work, checks },
	review: { enabled: false, checklist: [] }
});

beforeAll(async () => {
	fixture = await startFixture();
	// Friday 2026-11-20 01:00 in Taipei: outside every window these tasks have and before the daily
	// one's time, so the scheduler starts none of them whatever day the tests run on.
	fixture.setClock(Date.UTC(2026, 10, 19, 17));
	cookie = await fixture.login();
	work = join(fixture.dir, 'work');
	mkdirSync(join(work, 'docs/monthly'), { recursive: true });
	writeFileSync(join(work, 'docs/monthly/exhibit-report.md'), '# 說明\n');
	ids.agent = (await create({
		name: '客發展覽維護報告',
		schedule: { type: 'monthly', fromDay: 1, toDay: 5 },
		time: '10:00',
		limitMinutes: 120,
		kind: 'agent',
		agent: { client: 'codex', model: 'gpt-6.1-sol', effort: 'medium', folder: work, brief: 'docs/monthly/exhibit-report.md' },
		review: { enabled: true, checklist: ['PDF 中文與圖片正常', '發票已開立', '寄信伺服器已接受'] }
	})).id;
	ids.backup = (await create(command('每月備份資料庫', { type: 'monthly', fromDay: 1, toDay: 3 }, '03:00', 'echo 備份完成; touch db-latest.sql.gz', [{ type: 'file', path: 'db-latest.sql.gz' }, { type: 'output', text: '備份完成' }]))).id;
	ids.weekly = (await create(command('每週整理報表', { type: 'weekly', fromWeekday: 1, toWeekday: 3 }, '09:00', 'echo 整理; exit 2'))).id;
	ids.daily = (await create(command('每天清暫存檔', { type: 'daily' }, '03:00', 'echo cleaned'))).id;
	await runToEnd(ids.backup);
	await runToEnd(ids.weekly);
}, 60_000);
afterEach(async () => {
	expect(tab?.errors ?? []).toEqual([]);
	await browser?.close();
	browser = undefined;
});
afterAll(async () => {
	await fixture?.cleanup();
});

async function visit(width: number, path = '/?tab=automation') {
	browser = await launchChrome({ screen: SCREEN });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height: width < 761 ? 844 : 800, deviceScaleFactor: width < 761 ? 2 : 1, mobile: width < 761 });
	await tab.send('Page.navigate', { url: `${fixture.url}/login` });
	await tab.until(`document.readyState === 'complete'`, 'a page of the board');
	await tab.eval(`localStorage.setItem('lat-board-inbox-width', '400')`);
	await tab.send('Page.navigate', { url: `${fixture.url}${path}` });
	await tab.until(`JSON.stringify(history.state).includes('depth')`, 'the board to start');
}
const click = (selector: string) => tab.eval(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error('no ${selector.replace(/'/g, '')}'); node.click(); })()`);
const type = (selector: string, value: string) =>
	tab.eval(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); node.value = ${JSON.stringify(value)}; node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const text = (selector: string) => tab.eval<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`);
const card = (id: string) => text(`.automation [data-task="${id}"]`);
const fits = () => tab.eval<boolean>(FITS);
const frame = (width: number, name: string) => shot(tab, `${width}-${name}`);
// What breaks the type rules under a selector: weights other than 400/700 (Chinese fonts have no
// 500/600) and running text set tighter than 1.6 times its size.
const offType = (selector: string) =>
	tab.eval<string[]>(`(() => {
		const root = document.querySelector(${JSON.stringify(selector)});
		const wrong = [];
		for (const node of [root, ...root.querySelectorAll('*')]) {
			if (![...node.childNodes].some((child) => child.nodeType === 3 && child.textContent.trim())) continue;
			const style = getComputedStyle(node);
			const name = node.tagName + '.' + node.className + ' "' + node.textContent.trim().slice(0, 12) + '"';
			if (!['400', '700'].includes(style.fontWeight)) wrong.push(name + ' weight ' + style.fontWeight);
			if (parseFloat(style.lineHeight) / parseFloat(style.fontSize) < 1.6) wrong.push(name + ' line-height ' + style.lineHeight + '/' + style.fontSize);
		}
		return wrong;
	})()`);

for (const width of [1280, 390]) {
	test.skipIf(!CHROME)(`${width}px: the list shows each task's state, window, next try and last result`, async () => {
		await visit(width);
		await tab.until(`document.querySelectorAll('.automation .card').length >= 4`, 'the tasks');
		expect(await tab.eval(`document.querySelector('[data-middle="automation"]').getAttribute('aria-pressed')`)).toBe('true');
		// One tab more in the bar, all on one line.
		expect(await tab.eval(`[...document.querySelectorAll('.middle-tabs button')].map((b) => b.innerText.replace(/\\d+/g, '').trim())`)).toEqual(['待辦', 'Herdr', '額度', '自動化']);
		expect(await tab.eval(`new Set([...document.querySelectorAll('.middle-tabs button')].map((b) => Math.round(b.getBoundingClientRect().top))).size`)).toBe(1);

		const agent = await card(ids.agent);
		expect(agent).toContain('客發展覽維護報告');
		expect(agent).toContain('… 等待中');
		expect(agent).toContain('Agent · 每月 1–5 日 10:00');
		expect(agent).toMatch(/下次 \d\d\/\d\d 10:00/);
		expect(agent).toContain('還沒跑過');
		const backup = await card(ids.backup);
		expect(backup).toContain('✓ 本期已完成');
		expect(backup).toContain('指令 · 每月 1–3 日 03:00');
		expect(backup).toMatch(/\d\d\/\d\d \d\d:\d\d 完成，2 項檢查都通過/);
		const weekly = await card(ids.weekly);
		expect(weekly).toContain('✕ 失敗');
		expect(weekly).toContain('指令 · 每週一至三 09:00');
		expect(weekly).toContain('失敗：結束碼 2');
		expect(await card(ids.daily)).toContain('指令 · 每天 03:00');
		expect(await fits()).toBe(true);
		await frame(width, '1-list');
		if (width < 761) expect(await tab.eval(`getComputedStyle(document.querySelector('.detail')).display`)).toBe('none');
		else expect(await text('.detail')).toContain('從自動化選一項看內容。');
	});

	test.skipIf(!CHROME)(`${width}px: a task's page shows its settings and every run's record; the phone's back returns to the list`, async () => {
		await visit(width);
		await tab.until(`!!document.querySelector('.automation [data-task="${ids.backup}"]')`, 'the list');
		await click(`.automation [data-task="${ids.backup}"]`);
		await tab.until(`!!document.querySelector('.detail .task')`, 'the task page');
		expect(await tab.eval(`location.search`)).toBe(`?automation=${ids.backup}`);
		const page = await text('.detail .task');
		expect(page).toContain('每月 1–3 日 03:00，成功後本期不再跑');
		expect(page).toContain('echo 備份完成; touch db-latest.sql.gz');
		expect(page).toContain('檔案存在：db-latest.sql.gz');
		const run = await text('.detail .run');
		expect(run).toMatch(/\d\d\/\d\d \d\d:\d\d → \d\d:\d\d/);
		expect(run).toContain('✓ 成功');
		expect(run).toContain('手動');
		expect(run).toContain('✓\n檔案存在：db-latest.sql.gz');
		await click('.detail .run summary');
		await tab.until(`document.querySelector('.detail .run pre')?.innerText.includes('備份完成')`, 'the output');
		expect(await text('.detail .run .where')).toMatch(/automation\/output\/.+\.txt/);
		expect(await fits()).toBe(true);
		// The page keeps the same side margin as the form and the other content pages.
		const left = await tab.eval<number>(`document.querySelector('.detail .task h2').getBoundingClientRect().left - document.querySelector('.detail').getBoundingClientRect().left`);
		expect(left).toBeGreaterThanOrEqual(8);
		expect(await offType('.detail .task')).toEqual([]);
		if (width >= 761) expect(await offType('.automation')).toEqual([]);
		await frame(width, '2-task');
		await shot(tab, `${width}-2b-task-runs`, { box: '.detail .run' });

		// A failed run says why.
		if (width < 761) {
			expect(await tab.eval(`getComputedStyle(document.querySelector('.inbox')).display`)).toBe('none');
			expect(await text('.detail .topbar .whose')).toBe('每月備份資料庫');
			await click('.detail .topbar button[aria-label="返回"]');
			await tab.until(`location.search === '?tab=automation' || location.search === ''`, 'back to the list');
			await tab.until(`getComputedStyle(document.querySelector('.inbox')).display !== 'none'`, 'the list to show');
			expect(await tab.eval(`document.querySelector('[data-middle="automation"]').getAttribute('aria-pressed')`)).toBe('true');
		}
		await click(`.automation [data-task="${ids.weekly}"]`);
		await tab.until(`document.querySelector('.detail .task')?.dataset.task === '${ids.weekly}'`, 'the weekly task');
		expect(await text('.detail .run')).toContain('結束碼 2');
		expect(await text('.detail .run')).toContain('✕ 失敗');

		// An agent task: its fields and checklist, and 立即執行 open to it like any task.
		await tab.send('Page.navigate', { url: `${fixture.url}/?automation=${ids.agent}` });
		await tab.until(`document.querySelector('.detail .task')?.dataset.task === '${ids.agent}'`, 'the agent task');
		const agentPage = await text('.detail .task');
		expect(agentPage).toContain('Agent · Codex gpt-6.1-sol · 強度中');
		expect(agentPage).toContain('docs/monthly/exhibit-report.md');
		expect(agentPage).toContain('發票已開立');
		expect(agentPage).toContain('開，用 Claude claude-opus-5-5 · 強度中');
		expect(await tab.eval(`[...document.querySelectorAll('.detail .actions button')].find((b) => b.innerText === '立即執行').disabled`)).toBe(false);
		expect(await fits()).toBe(true);
		await frame(width, '3-agent-task');
	});

	test.skipIf(!CHROME)(`${width}px: the edit form shows only the chosen type's fields, answers wrong fields in place and writes nothing`, async () => {
		await visit(width, `/?automation=${ids.daily}`);
		await tab.until(`!!document.querySelector('.detail .task')`, 'the task page');
		await click('.detail .actions button:nth-child(3)');
		await tab.until(`!!document.querySelector('.detail form')`, 'the form');
		expect(await tab.eval(`location.search`)).toBe(`?automation-edit=${ids.daily}`);
		const fields = () => tab.eval<string[]>(`['fromDay', 'toDay', 'fromWeekday', 'toWeekday', 'time'].filter((name) => document.querySelector('.detail form [name="' + name + '"]'))`);
		expect(await fields()).toEqual(['time']);
		// The fixed rule is text, and the only checkbox is the review switch.
		expect(await text('.detail form')).toContain('這期成功後就不再跑。');
		expect(await tab.eval(`[...document.querySelectorAll('.detail form input[type=checkbox]')].map((box) => box.name)`)).toEqual(['review']);
		await frame(width, '4-edit-daily');
		await click('.detail form [data-schedule="weekly"]');
		expect(await fields()).toEqual(['fromWeekday', 'toWeekday', 'time']);
		expect(await tab.eval(`[...document.querySelector('.detail form [name=fromWeekday]').options].map((o) => o.text).join()`)).toBe('星期一,星期二,星期三,星期四,星期五,星期六,星期日');
		expect(await fits()).toBe(true);
		// 時間 stays beside its box when the row wraps.
		const apart = `(() => { const box = document.querySelector('.detail form [name=time]').getBoundingClientRect(); const label = document.querySelector('.detail form .at > span').getBoundingClientRect(); return Math.abs((box.top + box.bottom) / 2 - (label.top + label.bottom) / 2); })()`;
		expect(await tab.eval<number>(apart)).toBeLessThan(10);
		expect(await offType('.detail form')).toEqual([]);
		// The review switch's label, the place a finger presses, is as tall as a button.
		expect(await tab.eval<number>(`document.querySelector('.detail form label.switch').getBoundingClientRect().height`)).toBeGreaterThanOrEqual(44);
		// Every box and list is at least 44px tall, a finger's size.
		expect(await tab.eval<string[]>(`[...document.querySelectorAll('.detail form input[type=text], .detail form select')].filter((box) => box.getBoundingClientRect().height < 44).map((box) => (box.name || box.getAttribute('aria-label')) + ' ' + box.getBoundingClientRect().height)`)).toEqual([]);
		await frame(width, '5-edit-weekly');
		await click('.detail form [data-schedule="monthly"]');
		expect(await fields()).toEqual(['fromDay', 'toDay', 'time']);

		const file = join(fixture.dir, 'board-state/automation', `${ids.daily}.json`);
		const before = readFileSync(file, 'utf8');
		await type('.detail form [name=fromDay]', '9');
		await type('.detail form [name=toDay]', '2');
		await type('.detail form [name=time]', '25:00');
		await type('.detail form [name=folder]', '/no/such/folder');
		await click('.detail form button[type=submit]');
		await tab.until(`!!document.querySelector('.detail form [data-error="days"]')`, 'the errors');
		expect(await text('.detail form [data-error="days"]')).toBe('開始日不能晚於結束日');
		expect(await text('.detail form [data-error="time"]')).toContain('00:00 到 23:59');
		expect(await text('.detail form [data-error="folder"]')).toContain('找不到這個資料夾');
		// Each answer sits right under its own field.
		expect(await tab.eval(`document.querySelector('.detail form [data-error="folder"]').previousElementSibling.name`)).toBe('folder');
		expect(readFileSync(file, 'utf8')).toBe(before);
		expect(await fits()).toBe(true);
		await frame(width, '6-edit-monthly-errors');
		await shot(tab, `${width}-6b-edit-errors-lower`, { box: '.detail form [data-error="folder"]' });

		await type('.detail form [name=fromDay]', '1');
		await type('.detail form [name=toDay]', '5');
		await type('.detail form [name=time]', '10:30');
		await type('.detail form [name=folder]', work);
		await click('.detail form button[type=submit]');
		await tab.until(`!!document.querySelector('.detail .task')`, 'the task page again');
		expect(await text('.detail .task')).toContain('每月 1–5 日 10:30，成功後本期不再跑');
		expect(await tab.eval(`location.search`)).toBe(`?automation=${ids.daily}`);
		expect(JSON.parse(readFileSync(file, 'utf8')).schedule).toEqual({ type: 'monthly', fromDay: 1, toDay: 5 });
		// Put it back for the other width.
		await send(`/api/automation/${ids.daily}`, 'PUT', command('每天清暫存檔', { type: 'daily' }, '03:00', 'echo cleaned'));
	});

	test.skipIf(!CHROME)(`${width}px: a new task, 立即執行 and its record, pause and resume`, async () => {
		await visit(width);
		await tab.until(`!!document.querySelector('.automation .add')`, 'the list');
		await click('.automation .add');
		await tab.until(`!!document.querySelector('.detail form')`, 'the new form');
		expect(await text('.detail form h2')).toBe('新增任務');
		// Picking an agent task turns the check on; back to a command turns it off again.
		await click('.detail form [data-kind="agent"]');
		expect(await tab.eval(`document.querySelector('.detail form [name=review]').checked`)).toBe(true);
		expect(await tab.eval(`!!document.querySelector('.detail form [name=brief]') && !document.querySelector('.detail form [name=command]')`)).toBe(true);
		// The checking agent is the other client than the task's, and follows it until chosen by hand.
		expect(await tab.eval(`document.querySelector('.detail form [data-review-client="codex"]').getAttribute('aria-pressed')`)).toBe('true');
		expect(await tab.eval(`document.querySelector('.detail form [name=reviewModel]').value`)).toBe('gpt-6.1-sol');
		await click('.detail form [data-client="codex"]');
		expect(await tab.eval(`document.querySelector('.detail form [data-review-client="claude"]').getAttribute('aria-pressed')`)).toBe('true');
		expect(await tab.eval(`document.querySelector('.detail form [name=reviewModel]').value`)).toBe('claude-opus-5-5');
		expect(await fits()).toBe(true);
		await frame(width, '7-new-agent');
		await shot(tab, `${width}-7b-new-agent-checker`, { box: '.detail form [name=reviewModel]' });
		// A checker model cleared and then the check turned off does not keep the form from saving.
		await type('.detail form [name=reviewModel]', '');
		await click('.detail form [name=review]');
		expect(await tab.eval(`!!document.querySelector('.detail form [name=reviewModel]')`)).toBe(false);
		await click('.detail form [data-kind="command"]');
		expect(await tab.eval(`document.querySelector('.detail form [name=review]').checked`)).toBe(false);
		const name = `立即執行測試 ${width}`;
		await type('.detail form [name=name]', name);
		await type('.detail form [name=command]', 'sleep 1; echo 跑完了');
		await type('.detail form [name=folder]', work);
		await click('.detail form .more');
		await type('.detail form [data-check="0"] select', 'output');
		await type('.detail form [data-check="0"] input', '跑完了');
		await click('.detail form button[type=submit]');
		await tab.until(`document.querySelector('.detail .task h2')?.innerText === ${JSON.stringify(name)}`, 'the new task page');
		const id = await tab.eval<string>(`document.querySelector('.detail .task').dataset.task`);

		await click('.detail .actions .primary');
		await tab.until(`document.querySelector('.detail .run')?.dataset.status === 'running'`, 'the run to show running');
		expect(await text('.detail .task header')).toContain('▶ 執行中');
		// While it runs, 停止這次 stands where 立即執行 was.
		expect(await text('.detail .actions .danger')).toBe('停止這次');
		expect(await tab.eval(`!document.querySelector('.detail .actions .primary')`)).toBe(true);
		await frame(width, '8-running');
		await tab.until(`document.querySelector('.detail .run')?.dataset.status === 'success'`, 'the run to end', 15_000);
		expect(await text('.detail .run')).toContain('輸出含「跑完了」');
		expect(await text('.detail .task header')).toContain('✓ 本期已完成');
		expect(await fits()).toBe(true);
		await frame(width, '9-after-run');
		await shot(tab, `${width}-9b-after-run-record`, { box: '.detail .run' });

		await click('.detail .actions button:nth-child(2)');
		await tab.until(`document.querySelector('.detail .task header')?.innerText.includes('已暫停')`, 'paused');
		expect(await text('.detail .actions button:nth-child(2)')).toBe('恢復');
		if (width > 760) {
			expect(await card(id)).toContain('‖ 已暫停');
			expect(await card(id)).toContain('暫停中不會自動跑');
		}
		await frame(width, '10-paused');
		await click('.detail .actions button:nth-child(2)');
		await tab.until(`document.querySelector('.detail .task header')?.innerText.includes('本期已完成')`, 'resumed');
		await send(`/api/automation/${id}/pause`, 'POST', { paused: true });
	});

	test.skipIf(!CHROME)(`${width}px: a task added on another device shows within 5 seconds, and a broken file shows as an error`, async () => {
		await visit(width);
		await tab.until(`document.querySelectorAll('.automation .card').length >= 4`, 'the list');
		const name = `別台加的 ${width}`;
		const started = Date.now();
		await create(command(name, { type: 'daily' }, '05:00', 'true'));
		await tab.until(`document.querySelector('.automation')?.innerText.includes(${JSON.stringify(name)})`, 'the new task', 5_000);
		expect(Date.now() - started).toBeLessThan(5_000);
	});
}

test.skipIf(!CHROME)('立即執行 pressed on a page that has not heard the task started shows the board\'s refusal and why', async () => {
	const task = await create(command('別台已在跑', { type: 'daily' }, '04:00', 'sleep 3'));
	browser = await launchChrome({ screen: SCREEN });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
	// The event stream never connects: the page knows only what it loaded with.
	await tab.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/events*' }] });
	await tab.send('Page.navigate', { url: `${fixture.url}/?automation=${task.id}` });
	await tab.until(`JSON.stringify(history.state).includes('depth')`, 'the board to start');
	await tab.until(`document.querySelector('.detail .task')?.dataset.task === '${task.id}'`, 'the task page');
	expect((await send(`/api/automation/${task.id}/run`, 'POST')).status).toBe(202);
	expect(await tab.eval(`document.querySelector('.detail .actions .primary').disabled`)).toBe(false);
	await click('.detail .actions .primary');
	await tab.until(`!!document.querySelector('.detail .notice')`, 'the refusal');
	expect(await text('.detail .notice')).toMatch(/這個任務正在跑（\d\d:\d\d 開始），等這次結束再執行/);
	await frame(1280, '12-refused');
	// The page reads the tasks again after the refusal: only one run, the one started elsewhere.
	await tab.until(`document.querySelectorAll('.detail .run').length === 1`, 'the run started elsewhere');
});

test.skipIf(!CHROME)('a task file that cannot be read is a red error in the list, not an empty task', async () => {
	await fixture.stop();
	writeFileSync(join(fixture.dir, 'board-state/automation', 'deadbeef00.json'), '{"id": "deadbeef00", "na');
	await fixture.start();
	cookie = await fixture.login();
	await visit(1280);
	await tab.until(`!!document.querySelector('.automation [data-broken]')`, 'the broken file');
	expect(await text('.automation [data-broken]')).toContain('設定檔讀不出來：deadbeef00.json');
	expect(await tab.eval(`document.querySelectorAll('.automation .card').length`)).toBeGreaterThanOrEqual(4);
	await frame(1280, '11-broken');
	await tab.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
	expect(await fits()).toBe(true);
	await frame(390, '11-broken');
});
