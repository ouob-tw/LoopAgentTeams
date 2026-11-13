// What the scheduler adds to the 自動化 tab, in a real browser at 1280px and 390px: a missed period
// on its card (one window, or the first few and the total after a long stop), paused, the next try
// as the board computed it in Taipei time; on a task's page the missed box with 立即執行 and
// 這期就算了, a skipped try in the records, and no button for 沿用原紀錄. The server runs in UTC.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { sleep, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, shot, type Browser, type Tab } from '../browser.ts';
import type { AutomationSnapshot, AutomationTask } from '../../src/lib/board/automation.ts';

const SCREEN = `({ search: location.search, middle: document.querySelector('.inbox')?.innerText.slice(0, 400) ?? '', detail: document.querySelector('.detail')?.innerText.slice(0, 400) ?? '' })`;
/** Nothing reaches past the window's width, and nothing in the list or the task page past its own box. */
const FITS = `document.documentElement.scrollWidth <= window.innerWidth && [...document.querySelectorAll('.automation, .automation *, .detail .task, .detail .task *')].filter((node) => !node.closest('pre')).every((node) => node.scrollWidth <= node.clientWidth + 1)`;
/** No two lines of a card overlap, and every line sits inside its card. */
const CARDS_CLEAN = `[...document.querySelectorAll('.automation .card')].every((card) => {
	const box = card.getBoundingClientRect();
	const lines = [...card.children].map((child) => child.getBoundingClientRect()).filter((rect) => rect.height > 0);
	return lines.every((rect, index) => rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.bottom <= box.bottom + 1 && (index === 0 || rect.top >= lines[index - 1].bottom - 1));
})`;

const tpe = (year: number, month: number, day: number, hour = 12, minute = 0) => Date.UTC(year, month - 1, day, hour - 8, minute);

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
const command = (name: string, schedule: object, time: string, line = 'echo ok') => ({
	name,
	schedule,
	time,
	limitMinutes: 30,
	kind: 'command',
	command: { command: line, folder: work, checks: [] },
	review: { enabled: false, checklist: [] }
});
async function restartAt(time: number) {
	await fixture.stop();
	fixture.setClock(time);
	await fixture.start();
	cookie = await fixture.login();
}

beforeAll(async () => {
	fixture = await startFixture({ env: { TZ: 'UTC', LAT_BOARD_AUTOMATION_TICK_SECONDS: '0.2' } });
	fixture.setClock(tpe(2026, 11, 7));
	// The board's first check ran on the real time; let one run on the test's.
	await sleep(1_000);
	cookie = await fixture.login();
	work = join(fixture.dir, 'work');
	mkdirSync(work, { recursive: true });
	ids.many = (await create(command('每月清暫存檔', { type: 'monthly', fromDay: 8, toDay: 10 }, '08:00'))).id;
	// Down from 2026-11-07 to 2027-03-07: November to February missed.
	await restartAt(tpe(2027, 3, 7));
	ids.one = (await create(command('每月寄帳單提醒', { type: 'monthly', fromDay: 8, toDay: 10 }, '09:00'))).id;
	ids.paused = (await create(command('每月備份資料庫', { type: 'monthly', fromDay: 1, toDay: 3 }, '03:00'))).id;
	await send(`/api/automation/${ids.paused}/pause`, 'POST', { paused: true });
	ids.waiting = (await create(command('每週整理報表', { type: 'weekly', fromWeekday: 6, toWeekday: 6 }, '09:30'))).id;
	// Down again over March's window, back on Thursday 3/11 at 12:59; a manual run is going at 13:00.
	await restartAt(tpe(2027, 3, 11, 12, 59));
	ids.busy = (await create(command('每天同步', { type: 'daily' }, '13:00', 'sleep 1.5; echo ok'))).id;
	await send(`/api/automation/${ids.busy}/run`, 'POST');
	fixture.setClock(tpe(2027, 3, 11, 13, 0));
	for (let i = 0; i < 100; i++) {
		const view = (await snapshot()).tasks.find((entry) => entry.task.id === ids.busy)!;
		if (view.runs.length === 2 && view.runs.every((run) => run.status !== 'running')) break;
		await sleep(100);
	}
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
const text = (selector: string) => tab.eval<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`);
const card = (id: string) => text(`.automation [data-task="${id}"]`);
const overflowing = () => tab.eval<string[]>(`[...document.querySelectorAll('.automation, .automation *, .detail .task, .detail .task *')].filter((node) => !node.closest('pre') && node.scrollWidth > node.clientWidth + 1).map((node) => node.className + ':' + node.scrollWidth + '>' + node.clientWidth + ':' + node.textContent.slice(0, 40))`);
const buttonByText = (label: string) => `[...document.querySelectorAll('.detail .missed button')].find((b) => b.innerText === ${JSON.stringify(label)})`;

for (const width of [1280, 390]) {
	test.skipIf(!CHROME)(`${width}px: the list shows missed periods, paused and the next try in Taipei time`, async () => {
		await visit(width);
		await tab.until(`document.querySelectorAll('.automation .card').length >= 5`, 'the tasks');
		const one = await card(ids.one);
		expect(one).toContain('! 本期錯過');
		expect(one).toContain('3/8–3/10 看板沒開，這期沒跑');
		const many = await card(ids.many);
		expect(many).toContain('! 本期錯過');
		// Five windows passed: the card says how many; the task's page names them.
		expect(await tab.eval(`document.querySelector('.automation [data-task="${ids.many}"] .missed').textContent`)).toBe('看板沒開，錯過 5 期，沒有自動補跑');
		const paused = await card(ids.paused);
		expect(paused).toContain('‖ 已暫停');
		expect(paused).toContain('下次 暫停中不會自動跑');
		// Saturday 3/13 at 09:30 in Taipei, though the server's own zone is UTC.
		expect(await card(ids.waiting)).toContain('下次 03/13 09:30');
		// The skipped try is not the card's last result: the manual run is.
		expect(await card(ids.busy)).toMatch(/03\/11 13:0\d 完成，結束碼 0/);
		expect(await overflowing()).toEqual([]);
		expect(await tab.eval<boolean>(FITS)).toBe(true);
		expect(await tab.eval<boolean>(CARDS_CLEAN)).toBe(true);
		// Each card line stays on one line.
		expect(await tab.eval<boolean>(`[...document.querySelectorAll('.automation .card .ell')].every((line) => line.getBoundingClientRect().height < 2 * parseFloat(getComputedStyle(line).lineHeight || '24'))`)).toBe(true);
		await shot(tab, `${width}-s1-list`);
		await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
		await shot(tab, `${width}-s1-list-dark`);
		await tab.send('Emulation.setEmulatedMedia', { features: [] });
	});

	test.skipIf(!CHROME)(`${width}px: a missed task's page offers 立即執行 and 這期就算了; a skipped try reads as one; no 沿用原紀錄 button`, async () => {
		await visit(width, `/?automation=${ids.many}`);
		await tab.until(`!!document.querySelector('.detail .task .missed')`, 'the missed box');
		const box = await text('.detail .missed');
		expect(box).toContain('每月清暫存檔：錯過 5 期');
		expect(box).toContain('2026/11/8–11/10、2026/12/8–12/10、1/8–1/10 等共 5 期 看板都沒開，所以沒跑。不會自動補跑。');
		expect(await tab.eval(`[...document.querySelectorAll('.detail .missed button')].map((b) => b.innerText)`)).toEqual(['立即執行', '這期就算了']);
		expect(await tab.eval(`[...document.querySelectorAll('.detail button')].some((b) => b.innerText.includes('沿用'))`)).toBe(false);
		// One 立即執行 on the page: the box's. Each window stays whole on one line.
		expect(await tab.eval(`[...document.querySelectorAll('.detail button')].filter((b) => b.innerText === '立即執行').length`)).toBe(1);
		expect(await tab.eval(`[...document.querySelectorAll('.detail .missed .window')].map((w) => w.getClientRects().length)`)).toEqual([1, 1, 1]);
		expect(await overflowing()).toEqual([]);
		expect(await tab.eval<boolean>(FITS)).toBe(true);
		await shot(tab, `${width}-s2-missed-task`);
		await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
		await shot(tab, `${width}-s2-missed-task-dark`);
		await tab.send('Emulation.setEmulatedMedia', { features: [] });
		// Last of all, as these change the tasks: 這期就算了 and 立即執行.
		if (width === 390) {
			// 這期就算了: the box goes, the state is waiting again, on this page and in the list.
			await tab.eval(`${buttonByText('這期就算了')}.click()`);
			await tab.until(`!document.querySelector('.detail .missed')`, 'the box to go');
			expect(await text('.detail .task header')).toContain('… 等待中');
			expect(await card(ids.many)).not.toContain('錯過');
			await shot(tab, `${width}-s3-dismissed`);
			// 立即執行 from the other one's box: the run is recorded and the box goes.
			await tab.send('Page.navigate', { url: `${fixture.url}/?automation=${ids.one}` });
			await tab.until(`JSON.stringify(history.state).includes('depth') && !!document.querySelector('.detail .missed')`, 'the other missed box');
			expect(await text('.detail .missed')).toContain('每月寄帳單提醒：本期錯過');
			await tab.eval(`${buttonByText('立即執行')}.click()`);
			await tab.until(`!document.querySelector('.detail .missed') && document.querySelector('.detail .run')?.innerText.includes('手動')`, 'the run');
			await tab.until(`document.querySelector('.detail .task header')?.innerText.includes('本期已完成')`, 'the run to end');
		}
		await tab.send('Page.navigate', { url: `${fixture.url}/?automation=${ids.busy}` });
		await tab.until(`JSON.stringify(history.state).includes('depth') && document.querySelectorAll('.detail .run').length === 2`, 'the busy task\'s records');
		const skipped = await text('.detail .run[data-status="skipped"]');
		expect(skipped).toContain('↷ 跳過');
		expect(skipped).toContain('自動');
		expect(skipped).toContain('上一次還在跑');
		// Nothing ran: one time, no start → end.
		expect(await text('.detail .run[data-status="skipped"] .when b')).toBe('03/11 13:00');
		expect(await overflowing()).toEqual([]);
		expect(await tab.eval<boolean>(FITS)).toBe(true);
		await shot(tab, `${width}-s4-skipped`, { box: '.detail .run[data-status="skipped"]' });
	});
}
