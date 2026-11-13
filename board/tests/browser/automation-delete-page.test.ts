// 刪除任務 on a task's page, in a real browser at 1280px and 390px: while a run is unfinished the
// button is off and says why, beside 停止這次; otherwise it asks first, naming the task and saying
// its records go too, with 確定刪除 filled red and 取消; 取消 leaves it, 確定刪除 removes it and
// goes back to the list, where it is gone. Frames go to LAT_BOARD_SHOTS when it is set.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { sleep, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, shot, type Browser, type Tab } from '../browser.ts';
import type { AutomationSnapshot, AutomationTask } from '../../src/lib/board/automation.ts';

const SCREEN = `({ search: location.search, detail: document.querySelector('.detail')?.innerText.slice(0, 400) ?? '' })`;
/** What reaches past the window's width, or past its own box in the list and the task page. */
const OVERFLOW = `[...(document.documentElement.scrollWidth > window.innerWidth ? ['page ' + document.documentElement.scrollWidth] : []), ...[...document.querySelectorAll('.automation, .automation *, .detail .task, .detail .task *')].filter((node) => node.scrollWidth > node.clientWidth + 1).map((node) => node.tagName + '.' + node.className + ' ' + node.scrollWidth + '>' + node.clientWidth)]`;

let fixture: Fixture;
let cookie: string;
let work: string;
let browser: Browser | undefined;
let tab: Tab;

const send = (path: string, method: string, body?: unknown) =>
	fixture.fetch(path, { method, cookie, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const snapshot = async (): Promise<AutomationSnapshot> => (await fixture.fetch('/api/automation', { cookie })).json();

/** Today in Taipei, so the window can be put on another day: the scheduler never starts these. */
const taipeiDay = new Date(Date.now() + 8 * 3_600_000).getUTCDate();
const otherDay = (taipeiDay % 28) + 1 === taipeiDay ? 1 : (taipeiDay % 28) + 1;

async function create(name: string, command: string): Promise<AutomationTask> {
	const response = await send('/api/automation', 'POST', {
		name,
		schedule: { type: 'monthly', fromDay: otherDay, toDay: otherDay },
		time: '03:00',
		limitMinutes: 30,
		kind: 'command',
		command: { command, folder: work, checks: [] },
		review: { enabled: false, checklist: [] }
	});
	if (response.status !== 201) throw new Error(`create: ${response.status}`);
	return response.json();
}

beforeAll(async () => {
	fixture = await startFixture();
	cookie = await fixture.login();
	work = join(fixture.dir, 'work');
	mkdirSync(work, { recursive: true });
	await create('每月備份資料庫（正式）', 'echo OK');
}, 60_000);
afterEach(async () => {
	expect(tab?.errors ?? []).toEqual([]);
	await browser?.close();
	browser = undefined;
});
afterAll(async () => {
	await fixture?.cleanup();
});

async function visit(width: number, path: string, dark = false) {
	browser = await launchChrome({ screen: SCREEN });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height: width < 761 ? 844 : 800, deviceScaleFactor: width < 761 ? 2 : 1, mobile: width < 761 });
	await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
	await tab.send('Page.navigate', { url: `${fixture.url}/login` });
	await tab.until(`document.readyState === 'complete'`, 'a page of the board');
	await tab.eval(`localStorage.setItem('lat-board-inbox-width', '400')`);
	await tab.send('Page.navigate', { url: `${fixture.url}/?tab=automation` });
	await tab.until(`JSON.stringify(history.state).includes('depth')`, 'the board to start');
	if (path) {
		await tab.until(`!!document.querySelector(${JSON.stringify(path)})`, 'the task in the list');
		await tab.eval(`document.querySelector(${JSON.stringify(path)}).click()`);
	}
}
const text = (selector: string) => tab.eval<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`);
const button = (label: string) => `[...document.querySelectorAll('.detail .task button')].find((b) => b.innerText.trim() === ${JSON.stringify(label)})`;
const look = (label: string) =>
	tab.eval<{ height: number; background: string; color: string; disabled: boolean }>(
		`(() => { const b = ${button(label)}; const s = getComputedStyle(b); return { height: b.getBoundingClientRect().height, background: s.backgroundColor, color: s.color, disabled: b.disabled }; })()`
	);
const danger = () => tab.eval<string>(`getComputedStyle(document.querySelector('.detail .task')).getPropertyValue('--danger').trim()`);

for (const width of [1280, 390]) {
	test.skipIf(!CHROME)(`${width}px: 刪除任務 is off while a run is unfinished, asks first, and 確定刪除 removes the task and goes back to the list`, async () => {
		const task = await create(`搬遷預覽：每月備份 ${width}`, 'sleep 30; echo OK');
		expect((await send(`/api/automation/${task.id}/run`, 'POST')).status).toBe(202);
		await visit(width, `.automation [data-task="${task.id}"]`);
		await tab.until(`!!document.querySelector('.detail .task [data-delete]')`, 'the task page');

		// Running: off, with why, and not to be taken for 停止這次.
		const off = await look('刪除任務');
		expect(off.disabled).toBe(true);
		expect(await text('.detail .task [data-delete]')).toContain('這次還沒跑完，等它結束或按「停止這次」之後才能刪除。');
		const stop = await look('停止這次');
		expect(off.height).toBeGreaterThanOrEqual(44);
		expect(off.color).not.toBe(stop.color);
		expect(await tab.eval<string[]>(OVERFLOW)).toEqual([]);
		await shot(tab, `${width}-delete-1-running`);
		await shot(tab, `${width}-delete-1b-running-button`, { box: '.detail .task [data-delete]' });
		await tab.eval(`${button('停止這次')}.click()`);
		await tab.until(`${button('刪除任務')} && !${button('刪除任務')}.disabled`, 'the button to come on once the run ends', 15_000);

		// Asks first; 取消 leaves it.
		await tab.eval(`${button('刪除任務')}.click()`);
		await tab.until(`!!document.querySelector('.detail .task [data-delete] .confirm')`, 'the confirmation');
		const confirmation = await text('.detail .task [data-delete] .confirm');
		expect(confirmation).toContain(`要刪除「搬遷預覽：每月備份 ${width}」嗎？`);
		expect(confirmation).toContain('它的設定和全部執行紀錄會一起移除，不能復原。');
		const sure = await look('確定刪除');
		const cancel = await look('取消');
		expect(sure.height).toBeGreaterThanOrEqual(44);
		expect(cancel.height).toBeGreaterThanOrEqual(44);
		// Filled red, unlike 取消 and unlike the outlined 停止這次.
		expect(sure.background).not.toBe(cancel.background);
		expect(sure.background).not.toBe(stop.background);
		expect(await danger()).not.toBe('');
		expect(await tab.eval<string[]>(OVERFLOW)).toEqual([]);
		await shot(tab, `${width}-delete-2-confirm`);
		await shot(tab, `${width}-delete-2b-confirm-box`, { box: '.detail .task [data-delete]' });
		await tab.eval(`${button('取消')}.click()`);
		await tab.until(`!document.querySelector('.detail .task [data-delete] .confirm')`, 'the confirmation to close');
		expect((await snapshot()).tasks.some((view) => view.task.id === task.id)).toBe(true);

		await tab.eval(`${button('刪除任務')}.click()`);
		await tab.until(`!!document.querySelector('.detail .task [data-delete] .confirm')`, 'the confirmation again');
		await tab.eval(`${button('確定刪除')}.click()`);
		await tab.until(`!location.search.includes('automation=')`, 'back to the list', 10_000);
		await tab.until(`!!document.querySelector('.automation') && !document.querySelector('.automation [data-task="${task.id}"]')`, 'the task gone from the list');
		expect(await text('.automation')).toContain('每月備份資料庫（正式）');
		expect((await snapshot()).tasks.some((view) => view.task.id === task.id)).toBe(false);
		expect(await tab.eval<string[]>(OVERFLOW)).toEqual([]);
		await sleep(200);
		await shot(tab, `${width}-delete-3-after`);
	});
}

test.skipIf(!CHROME)('the dark theme: the confirmation stays readable at 1280px and 390px', async () => {
	const task = await create('搬遷預覽：深色', 'echo OK');
	for (const width of [1280, 390]) {
		await visit(width, `.automation [data-task="${task.id}"]`, true);
		await tab.until(`!!${button('刪除任務')}`, 'the task page');
		await shot(tab, `${width}-delete-4-idle-dark`);
		await tab.eval(`${button('刪除任務')}.click()`);
		await tab.until(`!!document.querySelector('.detail .task [data-delete] .confirm')`, 'the confirmation');
		expect(await tab.eval<string[]>(OVERFLOW)).toEqual([]);
		await shot(tab, `${width}-delete-5-confirm-dark`);
		await browser?.close();
		browser = undefined;
	}
});

test.skipIf(!CHROME)('deleted right after 編輯 and 儲存, the page goes to the list, not back to the form of a task that is gone', async () => {
	const task = await create('搬遷預覽：編輯後刪除', 'echo OK');
	await visit(1280, `.automation [data-task="${task.id}"]`);
	await tab.until(`!!${button('編輯')}`, 'the task page');
	await tab.eval(`${button('編輯')}.click()`);
	await tab.until(`!!document.querySelector('.detail button[type="submit"]')`, 'the form');
	await tab.eval(`document.querySelector('.detail button[type="submit"]').click()`);
	await tab.until(`!!${button('刪除任務')}`, 'the task page after saving');
	await tab.eval(`${button('刪除任務')}.click()`);
	await tab.until(`!!${button('確定刪除')}`, 'the confirmation');
	await tab.eval(`${button('確定刪除')}.click()`);
	await tab.until(`!location.search.includes('automation=') && !location.search.includes('automation-edit') && !document.querySelector('.detail form')`, 'the list, with no form', 10_000);
	expect(await tab.eval<boolean>(`!!document.querySelector('.automation') && !document.querySelector('.automation [data-task="${task.id}"]')`)).toBe(true);
});
