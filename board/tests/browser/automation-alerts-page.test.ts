// Automation red cards and 允許通知 in a real browser at 1280px and 390px: the cards on top of the
// 待辦 list beside a question and a report, a card's page with its run and 重跑一次, 打開自動化設定
// and 知道了，關掉紅卡; a missed card naming its periods; an address from a push opening its card,
// with or without a board tab open; 允許通知 turning this device's pushes on and off; and the reason
// shown on a page that is not https. The push service is faked: the page's PushManager hands out a
// subscription to a service on this host, which the board is told to take.
import { createECDH } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { question, sleep, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, shot, type Browser, type Tab } from '../browser.ts';
import type { AlertsSnapshot, AutomationAlert } from '../../src/lib/board/alerts.ts';
import type { AutomationSnapshot, AutomationTask } from '../../src/lib/board/automation.ts';
import { NOT_HTTPS } from '../../src/lib/board/push-setup.ts';

const SCREEN = `({ search: location.search, middle: document.querySelector('.inbox')?.innerText.slice(0, 300) ?? '', detail: document.querySelector('.detail')?.innerText.slice(0, 300) ?? '', settings: document.querySelector('dialog[open]')?.innerText.slice(0, 300) ?? '' })`;
/** Nothing reaches past the window's width, nor past its own box in the cards and the card's page. */
const FITS = `document.documentElement.scrollWidth <= window.innerWidth && [...document.querySelectorAll('[data-alert-row], [data-alert-row] *, .detail [data-alert], .detail [data-alert] *, [data-push], [data-push] *')].every((node) => node.scrollWidth <= node.clientWidth + 1)`;

const tpe = (year: number, month: number, day: number, hour = 12, minute = 0) => Date.UTC(year, month - 1, day, hour - 8, minute);

const service = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(null, { status: 201 }) });
const PUSH_ORIGIN = `http://127.0.0.1:${service.port}`;

/** The page's push service, faked: one subscription at a time, to the fake service, with real keys. */
const keys = (() => {
	const ecdh = createECDH('prime256v1');
	return { p256dh: Buffer.from(ecdh.generateKeys()).toString('base64url'), auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url') };
})();
const FAKE_PUSH = `(() => {
	if (typeof PushManager !== 'function') return;
	let current = null;
	const make = (options) => ({
		endpoint: ${JSON.stringify(`${PUSH_ORIGIN}/push/browser`)},
		options: { applicationServerKey: options.applicationServerKey.buffer ?? options.applicationServerKey },
		toJSON() { return { endpoint: this.endpoint, keys: ${JSON.stringify(keys)} }; },
		async unsubscribe() { current = null; return true; }
	});
	PushManager.prototype.subscribe = async function (options) { current = make(options); return current; };
	PushManager.prototype.getSubscription = async function () { return current; };
})()`;

let fixture: Fixture;
let cookie: string;
let work: string;
let browser: Browser | undefined;
let tab: Tab;
let failedTask: AutomationTask;
let failedCard: AutomationAlert;
let missedCard: AutomationAlert;

const send = (path: string, method: string, body?: unknown) =>
	fixture.fetch(path, { method, cookie, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const alerts = async (): Promise<AutomationAlert[]> => ((await (await fixture.fetch('/api/alerts', { cookie })).json()) as AlertsSnapshot).alerts;
const automation = async (): Promise<AutomationSnapshot> => (await fixture.fetch('/api/automation', { cookie })).json();
async function create(body: object): Promise<AutomationTask> {
	const response = await send('/api/automation', 'POST', body);
	if (response.status !== 201) throw new Error(`create: ${response.status} ${await response.text()}`);
	return response.json();
}
const command = (name: string, line: string, schedule: object = { type: 'monthly', fromDay: 1, toDay: 2 }) => ({
	name,
	schedule,
	time: '09:00',
	limitMinutes: 30,
	kind: 'command',
	command: { command: line, folder: work, checks: [] },
	review: { enabled: false, checklist: [] }
});
async function eventually<T>(read: () => Promise<T | undefined | false>, what: string): Promise<T> {
	for (let i = 0; i < 100; i++) {
		const value = await read();
		if (value) return value;
		await sleep(100);
	}
	throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
	fixture = await startFixture({ env: { TZ: 'UTC', LAT_BOARD_AUTOMATION_TICK_SECONDS: '0.2', LAT_BOARD_PUSH_TEST_ORIGIN: PUSH_ORIGIN, LAT_BOARD_URL: 'https://board.example.test' } });
	fixture.setClock(tpe(2026, 11, 11, 8));
	await sleep(1_000);
	cookie = await fixture.login();
	work = join(fixture.dir, 'work');
	mkdirSync(work, { recursive: true });
	const cleanup = await create(command('每天清暫存檔', 'echo ok', { type: 'daily' }));
	// Added on 11/11 before its time, down from then to 11/13: 11/12 is missed (11/11 began before the task did).
	await sleep(600);
	await fixture.stop();
	fixture.setClock(tpe(2026, 11, 13, 10, 41));
	await fixture.start();
	missedCard = await eventually(async () => (await alerts()).find((alert) => alert.taskId === cleanup.id), 'the missed card');
	// This device takes pushes, so the card says where it was pushed.
	const subscribed = await send('/api/push/subscription', 'PUT', { endpoint: `${PUSH_ORIGIN}/push/setup`, keys });
	if (subscribed.status !== 200) throw new Error(`subscribe: ${subscribed.status}`);
	failedTask = await create(command('客發展覽維護報告', 'echo 發票沒開立; exit 3'));
	await send(`/api/automation/${failedTask.id}/run`, 'POST');
	failedCard = await eventually(async () => (await alerts()).find((alert) => alert.taskId === failedTask.id && alert.pushed), 'the failed card, pushed');

	const gebu = fixture.bound('LoopAgentTeams', 'gebu', {
		questions: [question({ id: 'Q-1', title: '跑完後的檢查 Agent：任務預設開、腳本預設關，可以嗎？', asked_at: new Date(tpe(2026, 11, 13, 10, 8)).toISOString() })]
	});
	fixture.list([gebu]);
	fixture.report(gebu.session_id, { tag: 'DONE', summary: '#112、#113 已修好、推送到 main', time: new Date(tpe(2026, 11, 13, 10, 2)).toISOString(), hcom_name: 'gebu', workspace: gebu.workspace });
	await fixture.refresh(cookie);
}, 60_000);
afterEach(async () => {
	expect(tab?.errors ?? []).toEqual([]);
	await browser?.close();
	browser = undefined;
});
afterAll(async () => {
	await fixture?.cleanup();
	service.stop(true);
});

async function visit(width: number, path = '/?tab=inbox', origin = fixture.url, args: string[] = []) {
	browser = await launchChrome({ screen: SCREEN, scripts: [FAKE_PUSH], args });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: origin });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height: width < 761 ? 844 : 800, deviceScaleFactor: width < 761 ? 2 : 1, mobile: width < 761 });
	// A browser away from Taipei: every automation time must still read in Taipei.
	await tab.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });
	await tab.send('Page.navigate', { url: `${origin}/login` });
	await tab.until(`document.readyState === 'complete'`, 'a page of the board');
	await tab.eval(`localStorage.setItem('lat-board-inbox-width', '400')`);
	await tab.send('Page.navigate', { url: `${origin}${path}` });
	await tab.until(`JSON.stringify(history.state).includes('depth')`, 'the board to start');
}
const click = (selector: string) => tab.eval(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error('no ${selector.replace(/'/g, '')}'); node.click(); })()`);
const text = (selector: string) => tab.eval<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`);
const button = (scope: string, label: string) => `[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => b.innerText.trim() === ${JSON.stringify(label)})`;
async function bothThemes(name: string) {
	await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
	await shot(tab, `${name}-light`);
	await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
	await shot(tab, `${name}-dark`);
	await tab.send('Emulation.setEmulatedMedia', { features: [] });
}

for (const width of [1280, 390]) {
	test.skipIf(!CHROME)(`${width}px: red cards sit on top of the 待辦 list; a card's page shows its run and three buttons`, async () => {
		await visit(width);
		await tab.until(`document.querySelectorAll('[data-alert-row]').length === 2 && !!document.querySelector('.inbox [data-item^="question"], .inbox [data-kind="question"]')`, 'the cards and the question');
		// Newest first, above every other entry.
		const order = await tab.eval<string[]>(`[...document.querySelectorAll('.inbox [data-item]')].map((row) => row.dataset.item)`);
		expect(order.slice(0, 2)).toEqual([`alert:${failedCard.id}`, `alert:${missedCard.id}`]);
		expect(await text(`[data-alert-row="${failedCard.id}"]`)).toContain('失敗');
		expect(await text(`[data-alert-row="${failedCard.id}"]`)).toContain('客發展覽維護報告：這次執行失敗');
		expect(await text(`[data-alert-row="${failedCard.id}"]`)).toContain('自動化');
		expect(await text(`[data-alert-row="${missedCard.id}"]`)).toContain('每天清暫存檔：本期錯過，沒有自動補跑');
		// Shown in Taipei time (10:41, made at 02:41 UTC), though the server and browser run in UTC.
		expect(await tab.eval(`Intl.DateTimeFormat().resolvedOptions().timeZone`)).toBe('UTC');
		// A day other than today gets its date in front, so only the time of day is compared.
		expect(await text(`[data-alert-row="${failedCard.id}"] time`)).toMatch(/(^|\s)10:41:00$/);
		expect(await tab.eval<boolean>(FITS)).toBe(true);
		await bothThemes(`${width}-a1-inbox`);

		await click(`[data-alert-row="${failedCard.id}"] .main`);
		await tab.until(`!!document.querySelector('.detail [data-alert="${failedCard.id}"] [data-run]')`, 'the card page');
		expect(await tab.eval(`location.search`)).toBe(`?alert=${failedCard.id}`);
		const page = await text('.detail [data-alert]');
		expect(page).toContain('客發展覽維護報告：失敗');
		expect(page).toContain('結束碼 3');
		expect(page).toContain('已推播到 1 台裝置');
		for (const label of ['重跑一次', '打開自動化設定', '知道了，關掉紅卡']) expect(await tab.eval<boolean>(`!!${button('.detail [data-alert]', label)}`)).toBe(true);
		// Every button at least 44px tall.
		expect(await tab.eval<number>(`Math.min(...[...document.querySelectorAll('.detail [data-alert] button')].map((b) => b.getBoundingClientRect().height))`)).toBeGreaterThanOrEqual(44);
		expect(await tab.eval<boolean>(FITS)).toBe(true);
		await bothThemes(`${width}-a2-card`);

		await tab.eval(`history.back()`);
		await tab.until(`location.search === '' || location.search === '?tab=inbox'`, 'back on the list');
		await click(`[data-alert-row="${missedCard.id}"] .main`);
		await tab.until(`!!document.querySelector('.detail [data-alert="${missedCard.id}"] [data-missed]')`, 'the missed card page');
		expect(await text('.detail [data-missed]')).toContain('11/12');
		expect(await tab.eval<boolean>(FITS)).toBe(true);
		await bothThemes(`${width}-a3-missed`);
	});
}

test.skipIf(!CHROME)('重跑一次 starts the task now; 打開自動化設定 opens the task; 知道了 closes the card and keeps the runs', async () => {
	await visit(1280, `/?alert=${failedCard.id}`);
	await tab.until(`!!document.querySelector('.detail [data-alert] [data-run]')`, 'the card page');
	const before = (await automation()).tasks.find((view) => view.task.id === failedTask.id)!.runs.length;
	await tab.eval(`${button('.detail [data-alert]', '重跑一次')}.click()`);
	await tab.until(`document.querySelector('.detail [data-alert]').innerText.includes('已開始執行')`, 'the run started');
	const runs = await eventually(async () => {
		const own = (await automation()).tasks.find((view) => view.task.id === failedTask.id)!.runs;
		return own.length === before + 1 && own.every((run) => run.status !== 'running') && own;
	}, 'the second run');
	expect(runs[0].trigger).toBe('manual');
	// The second failure makes a card of its own.
	await tab.until(`document.querySelectorAll('[data-alert-row]').length === 3`, 'the new card');

	await tab.eval(`${button('.detail [data-alert]', '打開自動化設定')}.click()`);
	await tab.until(`location.search.includes('automation=${failedTask.id}') && !!document.querySelector('.detail [data-task="${failedTask.id}"]')`, 'the task page');
	expect(await tab.eval(`document.querySelector('[data-middle="automation"]').getAttribute('aria-pressed')`)).toBe('true');

	await tab.send('Page.navigate', { url: `${fixture.url}/?alert=${failedCard.id}` });
	await tab.until(`JSON.stringify(history.state).includes('depth') && !!${button('.detail [data-alert]', '知道了，關掉紅卡')}`, 'the card page again');
	const kept = JSON.stringify((await automation()).tasks.find((view) => view.task.id === failedTask.id)!.runs);
	await tab.eval(`${button('.detail [data-alert]', '知道了，關掉紅卡')}.click()`);
	await tab.until(`!document.querySelector('[data-alert-row="${failedCard.id}"]') && !!document.querySelector('.detail [data-closed]')`, 'the card closed');
	expect(JSON.stringify((await automation()).tasks.find((view) => view.task.id === failedTask.id)!.runs)).toBe(kept);
	expect((await alerts()).find((alert) => alert.id === failedCard.id)!.dismissedAt).toBeNumber();
});

test.skipIf(!CHROME)('390px: a push opens its card with no board tab open, and in a board tab that is open', async () => {
	// No tab open: the service worker opens /?alert=<id>, which shows the card on its own screen; back reaches the list.
	await visit(390, `/?alert=${missedCard.id}`);
	await tab.until(`!!document.querySelector('.detail [data-alert="${missedCard.id}"]')`, 'the card');
	await tab.eval(`document.querySelector('.detail .topbar button').click()`);
	await tab.until(`!!document.querySelector('[data-alert-row="${missedCard.id}"]') && document.querySelector('[data-middle="inbox"]').getAttribute('aria-pressed') === 'true'`, 'the list with the card');

	// A tab open on another list: the worker's message switches it to 待辦 and the card.
	await tab.eval(`document.querySelector('[data-middle="automation"]').click()`);
	await tab.eval(`navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'alert-open', alert: ${JSON.stringify(missedCard.id)} } }))`);
	await tab.until(`location.search.includes('alert=${missedCard.id}') && !!document.querySelector('.detail [data-alert="${missedCard.id}"]')`, 'the card from the message');
	await shot(tab, '390-a4-from-push');
});

for (const width of [1280, 390]) {
	test.skipIf(!CHROME)(`${width}px: 允許通知 turns this device's pushes on and 關閉通知 off`, async () => {
		await visit(width);
		await tab.send('Browser.grantPermissions', { origin: fixture.url, permissions: ['notifications'] });
		// 關閉通知 was pressed on this device before, so the granted permission does not turn it on by itself.
		await tab.eval(`localStorage.setItem('lat-board-push-off', '1')`);
		await click('button[aria-label="設定"]');
		await tab.until(`document.querySelector('[data-push]')?.dataset.push === 'off'`, 'pushes off');
		expect(await text('[data-push]')).toContain('這台裝置：未開啟');
		expect(await tab.eval<boolean>(FITS)).toBe(true);
		await tab.eval(`document.querySelector('[data-push]').scrollIntoView({ block: 'center' })`);
		await bothThemes(`${width}-p1-off`);

		await tab.eval(`${button('[data-push]', '允許通知')}.click()`);
		await tab.until(`document.querySelector('[data-push]')?.dataset.push === 'on'`, 'pushes on');
		expect(await text('[data-push]')).toContain('這台裝置：已開啟');
		const server = await (await fixture.fetch('/api/push', { cookie })).json();
		expect(server.endpoint).toBe(`${PUSH_ORIGIN}/push/browser`);
		expect(await tab.eval<number>(`${button('[data-push]', '關閉通知')}.getBoundingClientRect().height`)).toBeGreaterThanOrEqual(44);
		expect(await tab.eval<boolean>(FITS)).toBe(true);
		await bothThemes(`${width}-p2-on`);

		await tab.eval(`${button('[data-push]', '關閉通知')}.click()`);
		await tab.until(`document.querySelector('[data-push]')?.dataset.push === 'off'`, 'pushes off again');
		expect((await (await fixture.fetch('/api/push', { cookie })).json()).endpoint).toBeNull();
	});
}

test.skipIf(!CHROME)('390px: on plain http under a LAN name the setting says why pushes cannot work, with no button', async () => {
	const origin = `http://board.lan.test:${new URL(fixture.url).port}`;
	await visit(390, '/?tab=inbox', origin, ['--host-resolver-rules=MAP board.lan.test 127.0.0.1']);
	expect(await tab.eval(`window.isSecureContext`)).toBe(false);
	await click('button[aria-label="設定"]');
	await tab.until(`document.querySelector('[data-push]')?.dataset.push === 'unsupported'`, 'the reason');
	expect(await text('[data-push]')).toContain(NOT_HTTPS);
	expect(await tab.eval(`document.querySelectorAll('[data-push] button').length`)).toBe(0);
	expect(await tab.eval<boolean>(FITS)).toBe(true);
	await tab.eval(`document.querySelector('[data-push]').scrollIntoView({ block: 'center' })`);
	await bothThemes('390-p3-not-https');
});

const pushNow = async () => (await (await fixture.fetch('/api/push', { cookie })).json()).endpoint as string | null;
const reload = async () => {
	await tab.eval(`window.__old = true`);
	await tab.send('Page.reload');
	await tab.until(`!window.__old && JSON.stringify(history.state).includes('depth')`, 'the board again');
	await sleep(1000);
};
const openSettings = async (label = 'the push state') => {
	// A fresh opening each time: the settings read the push state only when they open.
	await tab.eval(`document.querySelector('dialog[open]')?.close()`);
	await click('button[aria-label="設定"]');
	await tab.until(`['on', 'off'].includes(document.querySelector('[data-push]')?.dataset.push)`, label);
	await tab.until(`document.querySelector('[data-push]')?.dataset.push === 'on' || !${button('[data-push]', '允許通知')}?.disabled`, 'the push state settled');
};

test.skipIf(!CHROME)('390px: a granted permission turns this device on at opening the settings, 關閉通知 stops that across reloads, 允許通知 brings it back', async () => {
	await send('/api/push/subscription', 'DELETE', {});
	await visit(390);
	await tab.send('Browser.grantPermissions', { origin: fixture.url, permissions: ['notifications'] });
	await tab.eval(`window.__asked = 0; const ask = Notification.requestPermission; Notification.requestPermission = function () { window.__asked++; return ask.apply(this, arguments); }`);
	await openSettings();
	await tab.until(`document.querySelector('[data-push]')?.dataset.push === 'on'`, 'on without a press');
	expect(await text('[data-push]')).toContain('這台裝置：已開啟');
	expect(await pushNow()).toBe(`${PUSH_ORIGIN}/push/browser`);
	expect(await tab.eval<number>(`window.__asked`)).toBe(0);
	expect(await tab.eval<boolean>(FITS)).toBe(true);
	await tab.eval(`document.querySelector('[data-push]').scrollIntoView({ block: 'center' })`);
	await bothThemes('390-p4-auto-on');

	await tab.eval(`${button('[data-push]', '關閉通知')}.click()`);
	await tab.until(`document.querySelector('[data-push]')?.dataset.push === 'off'`, 'off');
	expect(await pushNow()).toBeNull();

	// A reload of the page, then the settings again: still off, nothing registered.
	await reload();
	await openSettings('push state after reload');
	await sleep(500);
	expect(await text('[data-push]')).toContain('這台裝置：未開啟');
	expect(await pushNow()).toBeNull();
	await shot(tab, '390-p5-off-stays');

	// 允許通知 again, then the board loses the subscription: the next opening registers again.
	await tab.eval(`${button('[data-push]', '允許通知')}.click()`);
	await tab.until(`document.querySelector('[data-push]')?.dataset.push === 'on'`, 'on again');
	expect(await tab.eval<string | null>(`localStorage.getItem('lat-board-push-off')`)).toBeNull();
	await send('/api/push/subscription', 'DELETE', {});
	await tab.eval(`navigator.serviceWorker.getRegistration('/').then((r) => r?.pushManager.getSubscription()).then((s) => s?.unsubscribe())`);
	await reload();
	await openSettings();
	await tab.until(`document.querySelector('[data-push]')?.dataset.push === 'on'`, 'registered again');
	expect(await pushNow()).toBe(`${PUSH_ORIGIN}/push/browser`);
	await send('/api/push/subscription', 'DELETE', {});
});

test.skipIf(!CHROME)('390px: with the permission not asked yet the settings open with the 允許通知 button and no browser question', async () => {
	await visit(390);
	await tab.eval(`window.__asked = 0; Notification.requestPermission = function () { window.__asked++; return Promise.resolve('default'); }`);
	expect(await tab.eval(`Notification.permission`)).toBe('default');
	await openSettings();
	await sleep(500);
	expect(await text('[data-push]')).toContain('這台裝置：未開啟');
	expect(await tab.eval<number>(`window.__asked`)).toBe(0);
	expect(await tab.eval<boolean>(`!${button('[data-push]', '允許通知')}.disabled`)).toBe(true);
	expect(await pushNow()).toBeNull();
});

test.skipIf(!CHROME)('390px: an automatic subscribing that fails says what a pressed 允許通知 says and leaves the button usable', async () => {
	await visit(390);
	await tab.send('Browser.grantPermissions', { origin: fixture.url, permissions: ['notifications'] });
	await tab.eval(`PushManager.prototype.subscribe = async function () { throw new Error('no service'); }`);
	await openSettings();
	await tab.until(`!!document.querySelector('[data-push] [role="alert"]')`, 'the notice');
	const automatic = await text('[data-push] [role="alert"]');
	expect(automatic).toBe('瀏覽器沒有建立推播訂閱：no service');
	expect(await text('[data-push]')).toContain('這台裝置：未開啟');
	expect(await tab.eval<boolean>(`!${button('[data-push]', '允許通知')}.disabled`)).toBe(true);
	expect(await tab.eval<boolean>(FITS)).toBe(true);
	await shot(tab, '390-p6-auto-failed');

	await tab.eval(`${button('[data-push]', '允許通知')}.click()`);
	await sleep(500);
	expect(await text('[data-push] [role="alert"]')).toBe(automatic);
	expect(await tab.eval<boolean>(`!${button('[data-push]', '允許通知')}.disabled`)).toBe(true);
	expect(await pushNow()).toBeNull();
});
