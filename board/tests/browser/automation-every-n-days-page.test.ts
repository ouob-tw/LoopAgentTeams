// Every N days (#692) in a real browser at 1280px and 390px: an old every-day task opens with N = 1
// and no start date; N of 2 or more shows the start date box (today by default); a wrong N or day is
// answered under the row and nothing is written; once saved the list and the task's page say
// 每 2 天 07:00, laid out as the monthly and weekly lines are. Frames go to LAT_BOARD_SHOTS when set.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, shot, type Browser, type Tab } from '../browser.ts';
import { dateOf, type AutomationTask } from '../../src/lib/board/automation.ts';

const SCREEN = `({ search: location.search, detail: document.querySelector('.detail')?.innerText.slice(0, 400) ?? '' })`;
/** Nothing reaches past the window's width, and nothing in the list, the task page or the form past its own box. */
const FITS = `document.documentElement.scrollWidth <= window.innerWidth && [...document.querySelectorAll('.automation, .automation *, .detail .task, .detail .task *, .detail form, .detail form *')].filter((node) => !node.closest('pre') && node.tagName !== 'INPUT').every((node) => node.scrollWidth <= node.clientWidth + 1)`;

let fixture: Fixture;
let cookie: string;
let work: string;
let browser: Browser | undefined;
let tab: Tab;
const ids: Record<string, string> = {};

const send = (path: string, method: string, body?: unknown) =>
	fixture.fetch(path, { method, cookie, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
async function create(body: object): Promise<AutomationTask> {
	const response = await send('/api/automation', 'POST', body);
	if (response.status !== 201) throw new Error(`create: ${response.status} ${await response.text()}`);
	return response.json();
}
const command = (name: string, schedule: object, time: string) => ({
	name,
	schedule,
	time,
	limitMinutes: 30,
	kind: 'command',
	command: { command: 'echo ok', folder: work, checks: [] },
	review: { enabled: false, checklist: [] }
});

beforeAll(async () => {
	fixture = await startFixture();
	// Friday 2026-11-20 01:00 in Taipei: before every set time below, so nothing starts.
	fixture.setClock(Date.UTC(2026, 10, 19, 17));
	cookie = await fixture.login();
	work = join(fixture.dir, 'work');
	mkdirSync(work, { recursive: true });
	ids.monthly = (await create(command('每月備份資料庫', { type: 'monthly', fromDay: 1, toDay: 3 }, '03:00'))).id;
	ids.weekly = (await create(command('每週整理報表', { type: 'weekly', fromWeekday: 1, toWeekday: 3 }, '09:00'))).id;
	// Saved as every task before #692 was: no N.
	ids.daily = (await create(command('每兩天修 bug', { type: 'daily' }, '07:00'))).id;
}, 60_000);
afterEach(async () => {
	expect(tab?.errors ?? []).toEqual([]);
	await browser?.close();
	browser = undefined;
});
afterAll(async () => {
	await fixture?.cleanup();
});

async function visit(width: number, path: string) {
	browser = await launchChrome({ screen: SCREEN });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height: width < 761 ? 844 : 800, deviceScaleFactor: width < 761 ? 2 : 1, mobile: width < 761 });
	await tab.send('Page.navigate', { url: `${fixture.url}/login` });
	await tab.until(`document.readyState === 'complete'`, 'a page of the board');
	await tab.eval(`localStorage.setItem('lat-board-inbox-width', '400')`);
	await tab.send('Page.navigate', { url: `${fixture.url}${path}` });
	await tab.boardStarted();
}
const click = (selector: string) => tab.eval(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error('no ${selector.replace(/'/g, '')}'); node.click(); })()`);
const type = (selector: string, value: string) =>
	tab.eval(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); node.value = ${JSON.stringify(value)}; node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const text = (selector: string) => tab.eval<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`);
const has = (selector: string) => tab.eval<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`);
const fits = () => tab.eval<boolean>(FITS);
/** Each label sits on the same line as its box: their middles less than 10px apart. */
const besideBox = (name: string) =>
	tab.eval<number>(`(() => { const box = document.querySelector('.detail form [name=${name}]'); const group = box.closest('.at'); return Math.max(...[...group.children].map((child) => { const a = child.getBoundingClientRect(), b = box.getBoundingClientRect(); return Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2); })); })()`);
/** How far below the bottom of the row of fields an error starts; negative when it is not under it. */
const underRow = (field: string) =>
	tab.eval<number>(`(() => { const row = document.querySelector('.detail form .row').getBoundingClientRect(); const error = document.querySelector('.detail form [data-error=${field}]').getBoundingClientRect(); return error.top - row.bottom; })()`);

for (const width of [1280, 390]) {
	test.skipIf(!CHROME)(`${width}px: an old every-day task opens with N = 1; N = 2 adds the start date; wrong values are answered under the row; saved it reads 每 2 天 07:00`, async () => {
		await visit(width, `/?automation=${ids.daily}`);
		await tab.until(`!!document.querySelector('.detail .task')`, 'the task page');
		expect(await text('.detail .task')).toContain('每天 07:00，成功後本期不再跑');
		expect(await has('.detail .task [data-start-date]')).toBe(false);
		await click('.detail .actions button:nth-child(3)');
		await tab.until(`!!document.querySelector('.detail form')`, 'the form');
		expect(await text('.detail form [data-schedule="daily"]')).toBe('每 N 天');
		expect(await tab.eval(`document.querySelector('.detail form [data-schedule="daily"]').getAttribute('aria-pressed')`)).toBe('true');
		expect(await tab.eval(`document.querySelector('.detail form [name=everyDays]').value`)).toBe('1');
		expect(await has('.detail form [name=startDate]')).toBe(false);
		expect(await fits()).toBe(true);
		await shot(tab, `${width}-1-edit-every-1-day`, { box: '.detail form .row' });

		// N = 2: the start date box shows, today in Taipei by default.
		await type('.detail form [name=everyDays]', '2');
		await tab.until(`!!document.querySelector('.detail form [name=startDate]')`, 'the start date box');
		expect(await tab.eval(`document.querySelector('.detail form [name=startDate]').value`)).toBe(dateOf(Date.now()));
		expect(await besideBox('everyDays')).toBeLessThan(10);
		expect(await besideBox('startDate')).toBeLessThan(10);
		expect(await besideBox('time')).toBeLessThan(10);
		expect(await tab.eval<string[]>(`[...document.querySelectorAll('.detail form .row input')].filter((box) => box.getBoundingClientRect().height < 44 || box.scrollWidth > box.clientWidth + 1).map((box) => box.name)`)).toEqual([]);
		// The date fits its box whole.
		expect(await tab.eval<boolean>(`(() => { const box = document.querySelector('.detail form [name=startDate]'); const probe = document.createElement('span'); probe.style.font = getComputedStyle(box).font; probe.textContent = '2026-11-22'; document.body.append(probe); const wide = probe.getBoundingClientRect().width; probe.remove(); const style = getComputedStyle(box); return wide <= box.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight); })()`)).toBe(true);
		expect(await fits()).toBe(true);
		await shot(tab, `${width}-2-edit-every-2-days`, { box: '.detail form .row' });

		// Wrong values: each answered under the row, nothing written.
		const file = join(fixture.dir, 'board-state/automation', `${ids.daily}.json`);
		const before = readFileSync(file, 'utf8');
		await type('.detail form [name=everyDays]', '0');
		await click('.detail form button[type=submit]');
		await tab.until(`!!document.querySelector('.detail form [data-error="everyDays"]')`, 'the N error');
		expect(await text('.detail form [data-error="everyDays"]')).toBe('天數要填 1 到 365 的整數');
		expect(await tab.eval(`document.querySelector('.detail form [name=everyDays]').getAttribute('aria-invalid')`)).toBe('true');
		expect(await underRow('everyDays')).toBeGreaterThanOrEqual(0);
		expect(await underRow('everyDays')).toBeLessThan(12);
		await shot(tab, `${width}-3-error-every-days`, { box: '.detail form .row' });
		await type('.detail form [name=everyDays]', '2');
		await type('.detail form [name=startDate]', '2027-02-29');
		await click('.detail form button[type=submit]');
		await tab.until(`!!document.querySelector('.detail form [data-error="startDate"]')`, 'the date error');
		expect(await has('.detail form [data-error="everyDays"]')).toBe(false);
		expect(await text('.detail form [data-error="startDate"]')).toBe('沒有這一天：2027-02-29');
		expect(await underRow('startDate')).toBeGreaterThanOrEqual(0);
		expect(await underRow('startDate')).toBeLessThan(12);
		expect(readFileSync(file, 'utf8')).toBe(before);
		expect(await fits()).toBe(true);
		await shot(tab, `${width}-4-error-start-date`, { box: '.detail form .row' });

		// Saved: the task's page and the list say 每 2 天 07:00.
		await type('.detail form [name=startDate]', '2026-11-22');
		await click('.detail form button[type=submit]');
		await tab.until(`!!document.querySelector('.detail .task')`, 'the task page again');
		expect(await text('.detail .task')).toContain('每 2 天 07:00，成功後本期不再跑');
		expect(await text('.detail .task [data-start-date]')).toBe('2026-11-22');
		expect(JSON.parse(readFileSync(file, 'utf8')).schedule).toEqual({ type: 'daily', everyDays: 2, startDate: '2026-11-22' });
		// The board's clock is 11/20 01:00: the first block starts 11/22.
		expect(await text('.detail .task')).toContain('11/22 07:00');
		await shot(tab, `${width}-5-task-every-2-days`);
		// Opened again: N = 2 and the saved start date.
		await click('.detail .actions button:nth-child(3)');
		await tab.until(`!!document.querySelector('.detail form [name=startDate]')`, 'the form again');
		expect(await tab.eval(`[document.querySelector('.detail form [name=everyDays]').value, document.querySelector('.detail form [name=startDate]').value]`)).toEqual(['2', '2026-11-22']);
		await click('.detail form .actions button[type=button]');

		// The list: the line reads as the monthly and weekly ones do, on one line.
		await visit(width, '/?tab=automation');
		await tab.until(`document.querySelectorAll('.automation .card').length >= 3`, 'the tasks');
		const line = (id: string) => tab.eval<{ text: string; lines: number }>(`(() => { const node = document.querySelector('.automation [data-task="${id}"] .ell.muted'); return { text: node.innerText, lines: Math.round(node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight)) }; })()`);
		expect(await line(ids.daily)).toEqual({ text: '指令 · 每 2 天 07:00', lines: 1 });
		expect((await line(ids.monthly)).text).toBe('指令 · 每月 1–3 日 03:00');
		expect((await line(ids.weekly)).text).toBe('指令 · 每週一至三 09:00');
		expect(await fits()).toBe(true);
		await shot(tab, `${width}-6-list-every-2-days`);

		// Back to every day for the other width.
		await send(`/api/automation/${ids.daily}`, 'PUT', command('每兩天修 bug', { type: 'daily' }, '07:00'));
	});
}
