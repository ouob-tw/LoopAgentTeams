// 回報方式 (#708) in a real browser at 1400px and 390px: an agent task's editor shows 口頭 / DEMO 網頁
// with 口頭 chosen, an old task (saved with no choice) opens as 口頭, choosing DEMO 網頁 and saving
// persists it and the task's page says so; a command task has no such control. Nothing reaches past
// the window. Frames go to LAT_BOARD_SHOTS when set.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, shot, type Browser, type Tab } from '../browser.ts';
import type { AutomationSnapshot, AutomationTask } from '../../src/lib/board/automation.ts';

const SCREEN = `({ search: location.search, detail: document.querySelector('.detail')?.innerText.slice(0, 400) ?? '' })`;
const FITS = `document.documentElement.scrollWidth <= window.innerWidth && [...document.querySelectorAll('.detail .task, .detail .task *, .detail form, .detail form *')].filter((node) => node.tagName !== 'INPUT').every((node) => node.scrollWidth <= node.clientWidth + 1)`;

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
const snapshot = async (): Promise<AutomationSnapshot> => (await fixture.fetch('/api/automation', { cookie })).json();
const base = { schedule: { type: 'monthly', fromDay: 1, toDay: 3 }, time: '03:00', limitMinutes: 30, review: { enabled: false, checklist: [] } };

beforeAll(async () => {
	fixture = await startFixture();
	// Friday 2026-11-20 01:00 in Taipei: before the window of every task below, so nothing starts.
	fixture.setClock(Date.UTC(2026, 10, 19, 17));
	cookie = await fixture.login();
	work = join(fixture.dir, 'work');
	mkdirSync(join(work, 'docs'), { recursive: true });
	await Bun.write(join(work, 'docs/brief.md'), '# brief\n');
	const agent = { client: 'claude', model: 'claude-haiku-5-5', effort: 'low', folder: work, brief: 'docs/brief.md' };
	ids.agent = (await create({ ...base, name: '每週資安檢查', kind: 'agent', agent })).id;
	ids.command = (await create({ ...base, name: '每月備份資料庫', kind: 'command', command: { command: 'echo ok', folder: work, checks: [] } })).id;
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
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height: width < 761 ? 844 : 900, deviceScaleFactor: width < 761 ? 2 : 1, mobile: width < 761 });
	await tab.send('Page.navigate', { url: `${fixture.url}/login` });
	await tab.until(`document.readyState === 'complete'`, 'a page of the board');
	await tab.eval(`localStorage.setItem('lat-board-inbox-width', '400')`);
	await tab.send('Page.navigate', { url: `${fixture.url}${path}` });
	await tab.boardStarted();
}
const click = (selector: string) => tab.eval(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error('no ${selector.replace(/'/g, '')}'); node.click(); })()`);
const text = (selector: string) => tab.eval<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`);
const has = (selector: string) => tab.eval<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`);
const pressed = (selector: string) => tab.eval<string | null>(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-pressed') ?? null`);

/** 詳細資料 on the task page: the settings start folded (#756). */
const openDetails = async () => {
	await click('.detail .task header button.more');
	// Layout is measured once the arrow has stopped turning.
	await tab.until(`document.querySelector('.detail .task .chevron').getAnimations().length === 0`, 'the arrow to stop');
};

for (const width of [1400, 390]) {
	test.skipIf(!CHROME)(`${width}px: the editor offers 口頭 / DEMO 網頁, an old task opens as 口頭, DEMO 網頁 saves and shows on the task's page; a command task has no choice`, async () => {
		await visit(width, `/?automation=${ids.command}`);
		await tab.until(`!!document.querySelector('.detail .task')`, 'the command task page');
		await openDetails();
		expect(await has('.detail .task .kv')).toBe(true);
		expect(await has('.detail .task [data-report]')).toBe(false);
		await click('.detail .actions button:nth-child(3)');
		await tab.until(`!!document.querySelector('.detail form')`, 'the command form');
		expect(await has('.detail form [data-report]')).toBe(false);

		await tab.send('Page.navigate', { url: `${fixture.url}/?automation=${ids.agent}` });
		await tab.boardStarted();
		await tab.until(`!!document.querySelector('.detail .task')`, 'the agent task page');
		await openDetails();
		expect(await text('.detail .task [data-report]')).toBe('口頭');
		await click('.detail .actions button:nth-child(3)');
		await tab.until(`!!document.querySelector('.detail form')`, 'the form');
		expect(await text('.detail form [data-report="oral"]')).toBe('口頭');
		expect(await text('.detail form [data-report="demo"]')).toBe('DEMO 網頁');
		expect(await pressed('.detail form [data-report="oral"]')).toBe('true');
		expect(await pressed('.detail form [data-report="demo"]')).toBe('false');
		expect(await tab.eval<boolean>(FITS)).toBe(true);
		// Tap targets are 44px tall and on one line with room to spare.
		expect(await tab.eval<number>(`Math.min(...[...document.querySelectorAll('.detail form [data-report]')].map((b) => b.getBoundingClientRect().height))`)).toBeGreaterThanOrEqual(44);
		// The same size as the other choices on the form (the board's own text size setting).
		expect(await tab.eval<boolean>(`getComputedStyle(document.querySelector('.detail form [data-report]')).fontSize === getComputedStyle(document.querySelector('.detail form [data-effort]')).fontSize`)).toBe(true);
		await shot(tab, `${width}-1-report-oral`, { box: '.detail form #automation-report' });

		await click('.detail form [data-report="demo"]');
		expect(await pressed('.detail form [data-report="demo"]')).toBe('true');
		expect(await pressed('.detail form [data-report="oral"]')).toBe('false');
		await shot(tab, `${width}-2-report-demo`, { box: '.detail form #automation-report' });
		await click('.detail form button.primary');
		await tab.until(`!!document.querySelector('.detail .task')`, 'the task page after saving');
		await openDetails();
		expect(await text('.detail .task [data-report]')).toContain('DEMO 網頁');
		expect(await tab.eval<boolean>(FITS)).toBe(true);
		await shot(tab, `${width}-3-task-page-demo`, { box: '.detail .task [data-report]' });
		expect((await snapshot()).tasks.find((view) => view.task.id === ids.agent)!.task.agent!.report).toBe('demo');

		// Back to 口頭: the choice is not stored at all.
		await click('.detail .actions button:nth-child(3)');
		await tab.until(`!!document.querySelector('.detail form')`, 'the form again');
		expect(await pressed('.detail form [data-report="demo"]')).toBe('true');
		await click('.detail form [data-report="oral"]');
		await click('.detail form button.primary');
		await tab.until(`!!document.querySelector('.detail .task')`, 'the task page after saving again');
		await openDetails();
		await tab.until(`document.querySelector('.detail .task [data-report]')?.innerText === '口頭'`, 'the task page back on 口頭');
		expect((await snapshot()).tasks.find((view) => view.task.id === ids.agent)!.task.agent!.report).toBeUndefined();
	}, 60_000);
}
