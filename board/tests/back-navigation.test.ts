// Going back through the board's screens in a real browser: headless Chrome driven over its
// DevTools protocol, on the built board with fake data. Skipped when the host has no Chrome.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { ARCHIVE_PAGE } from '../src/lib/board/archive.ts';
import type { InboxReport } from '../src/lib/board/types.ts';
import { DAY, PORT_BASE, question, sleep, startFixture, type Fixture } from './harness.ts';

const CHROME = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(
	(path) => path && existsSync(path)
);

/** One Chrome tab, spoken to over the DevTools protocol. */
class Tab {
	#socket: WebSocket;
	#next = 0;
	#waiting = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();
	#listening: ((method: string) => void)[] = [];
	#closeTarget: () => Promise<unknown>;
	constructor(socket: WebSocket, closeTarget: () => Promise<unknown>) {
		this.#socket = socket;
		this.#closeTarget = closeTarget;
		socket.addEventListener('message', (event) => {
			const message = JSON.parse(String(event.data));
			if (message.method) for (const heard of this.#listening.splice(0)) heard(message.method);
			this.#waiting.get(message.id)?.(message);
			this.#waiting.delete(message.id);
		});
	}
	/** A new tab, so nothing a tab before it still had under way can reach into it. */
	static async open(debugPort: number): Promise<Tab> {
		const deadline = Date.now() + 10_000;
		let target: { id: string; webSocketDebuggerUrl: string } | undefined;
		while (!target) {
			if (Date.now() > deadline) throw new Error('timed out waiting for Chrome to listen');
			target = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' }).then(
				(response) => response.json(),
				() => undefined
			);
			if (!target) await sleep(100);
		}
		const socket = new WebSocket(target.webSocketDebuggerUrl);
		await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
		const tab = new Tab(socket, () => fetch(`http://127.0.0.1:${debugPort}/json/close/${target.id}`));
		await tab.send('Page.enable');
		return tab;
	}
	send(method: string, params: object = {}): Promise<any> {
		const id = ++this.#next;
		this.#socket.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) =>
			this.#waiting.set(id, (message) => (message.error ? reject(new Error(message.error.message)) : resolve(message.result)))
		);
	}
	async eval<T = unknown>(expression: string): Promise<T> {
		const { result, exceptionDetails } = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
		if (exceptionDetails) throw new Error(`${expression}: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
		return result.value;
	}
	/** Load a new document and wait until it has loaded. */
	async navigate(url: string) {
		const loaded = new Promise<void>((resolve) => {
			const heard = (method: string) => (method === 'Page.loadEventFired' ? resolve() : this.#listening.push(heard));
			this.#listening.push(heard);
		});
		await this.send('Page.navigate', { url });
		await loaded;
	}
	/** Wait for an expression in the page to be true. */
	async until(expression: string, what = expression) {
		const deadline = Date.now() + 10_000;
		while (!(await this.eval(expression).catch(() => false))) {
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; the page shows ${JSON.stringify(await this.eval(SCREEN))}`);
			await sleep(50);
		}
	}
	async close() {
		this.#socket.close();
		await this.#closeTarget();
	}
}

/** What the page shows: the address's query and the start of the content column's text. */
const SCREEN = `({ search: location.search, text: document.querySelector('.detail')?.innerText ?? '' })`;
/** Click the first button in `scope` whose text includes `text`. */
const click = (scope: string, text: string) =>
	`[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => b.innerText.includes(${JSON.stringify(text)})).click()`;
const ARROW = `document.querySelector('.topbar button').click()`;

let fixture: Fixture;
let chrome: ChildProcess;
let profile: string;
let tab: Tab;
let debugPort: number;
let luna: ReturnType<Fixture['bound']>;
let cookie: string;
let oldest: InboxReport;
const questions = Array.from({ length: 30 }, (_, index) => question({ id: `Q-${index + 1}`, title: `題目 ${index + 1}` }));

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture(29);
	cookie = await fixture.login('back-navigation');
	luna = fixture.bound('alpha', 'luna', { questions });
	fixture.report(luna.session_id, { tag: 'DONE', summary: '交付第二張票', hcom_name: 'luna', workspace: luna.workspace });
	// More archived reports than the archive's first page holds, of a controller long gone: past
	// the inbox's 7 days, inside the archive's 30.
	const gone = join(fixture.dir, 'workspaces', 'gone');
	for (let index = 0; index < ARCHIVE_PAGE + 10; index++) {
		const time = new Date(Date.now() - 8 * DAY - index * 60_000).toISOString();
		fixture.report('session-gone', { tag: 'DONE', summary: `封存回報 ${index}`, time, hcom_name: 'vega', workspace: gone });
	}
	fixture.list([luna]);
	await fixture.refresh(cookie);
	oldest = (await fixture.archive(cookie)).at(-1)!;

	profile = mkdtempSync(join(tmpdir(), 'lat-board-test-chrome-'));
	debugPort = PORT_BASE + 30;
	chrome = spawn(
		CHROME,
		['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, 'about:blank'],
		{ stdio: 'ignore' }
	);
	tab = await Tab.open(debugPort);
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
}, 30_000);

afterAll(async () => {
	await tab?.close();
	chrome?.kill('SIGKILL');
	if (profile) rmSync(profile, { recursive: true, force: true });
	await fixture?.cleanup();
});

/** The page before the board in every visit; going back to it is leaving the board. */
const START = 'data:text/html,start';
const LEFT = `location.protocol === 'data:'`;
/** A new tab: the start page, then the board at `search` in a window `width` wide. */
async function visit(width: number, search = '') {
	await tab.close();
	tab = await Tab.open(debugPort);
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width < 761 });
	await tab.navigate(START);
	await tab.navigate(`${fixture.url}/${search}`);
	await tab.until(STARTED, 'the board to start');
	// Started: the board's first history write is done.
	await tab.until(`JSON.stringify(history.state).includes('depth')`, "the board's first history entry");
}
const screen = () => tab.eval<{ search: string; text: string }>(SCREEN);
const back = () => tab.eval(`history.back()`);
/** The board has started in this document: once mounted it reads every source, which is done. */
const STARTED = `!window.beforeReload && performance.getEntriesByType('resource').some((entry) => entry.name.endsWith('/api/refresh'))`;
async function reload() {
	await tab.eval('window.beforeReload = true');
	await tab.send('Page.reload');
	await tab.until(STARTED, 'the reloaded board to start');
}
async function shows(search: string, text: string) {
	await tab.until(`location.search === ${JSON.stringify(search)} && document.querySelector('.detail')?.innerText.includes(${JSON.stringify(text)})`, `${search} showing ${text}`);
}
async function showsList() {
	await tab.until(`location.search === '' && getComputedStyle(document.querySelector('.inbox')).display !== 'none'`, 'the list');
}

const QUESTION = (n: number) => `?item=${encodeURIComponent(`q:${luna.session_id}:Q-${n}`)}`;
const CONTROLLER = () => `?controller=${luna.session_id}`;

test.skipIf(!CHROME)('phone: question, its controller, "←" back to the question, then the list where it was scrolled, then back leaves', async () => {
	await visit(390);
	await tab.eval(`[...document.querySelectorAll('.inbox button')].find((b) => b.innerText.includes('題目 20')).scrollIntoView()`);
	const scrolled = await tab.eval<number>('scrollY');
	expect(scrolled).toBeGreaterThan(500);

	await tab.eval(click('.inbox', '題目 20'));
	await shows(QUESTION(20), '題目 20');
	await tab.eval(click('.detail', '看主控資訊'));
	await shows(CONTROLLER(), '@luna');

	await tab.eval(ARROW);
	await shows(QUESTION(20), '題目 20');
	await tab.eval(ARROW);
	await showsList();
	await tab.until(`Math.abs(scrollY - ${scrolled}) <= 1`, `the list scrolled back to ${scrolled}`);

	await back();
	await tab.until(LEFT, 'leaving the board');
}, 30_000);

test.skipIf(!CHROME)("phone: a controller's question goes back to the controller by the browser's back, and back to a report finds it again", async () => {
	await visit(390);
	await tab.eval(click('.roster', '@luna'));
	await shows(CONTROLLER(), '題目 3');
	await tab.eval(click('.detail', '題目 3'));
	await shows(QUESTION(3), '題目 3');
	await back();
	await shows(CONTROLLER(), '題目 3');

	// A report opens in its controller's conversation; back to it finds it there again.
	await tab.eval(ARROW);
	await showsList();
	await tab.eval(click('.inbox', '交付第二張票'));
	await tab.until(`location.search.startsWith('?item=') && !location.search.startsWith('?item=q')`, 'the report');
	const report = await tab.eval<string>('location.search');
	await tab.eval(click('.roster', '@luna'));
	await shows(CONTROLLER(), '題目 3');
	await back();
	await shows(report, '交付第二張票');
	await tab.until(`document.querySelector('.placeholder') === null`, 'the report placed in its conversation');
	await reload();
	await shows(report, '交付第二張票');
	await back();
	await showsList();
	await back();
	await tab.until(LEFT, 'leaving the board');
}, 30_000);

test.skipIf(!CHROME)('a reload keeps the open screen and the way back', async () => {
	await visit(390);
	await tab.eval(click('.inbox', '題目 5'));
	await shows(QUESTION(5), '題目 5');
	await tab.eval(click('.detail', '看主控資訊'));
	await shows(CONTROLLER(), '@luna');

	await reload();
	await shows(CONTROLLER(), '@luna');
	await tab.eval(ARROW);
	await shows(QUESTION(5), '題目 5');
	await reload();
	await shows(QUESTION(5), '題目 5');
	await back();
	await showsList();
	await back();
	await tab.until(LEFT, 'leaving the board');
}, 30_000);

test.skipIf(!CHROME)('the new-controller form comes back after a reload', async () => {
	await visit(390);
	await tab.eval(click('.roster', '新建'));
	await shows('?launch', '新建主控');
	await reload();
	await shows('?launch', '新建主控');
	await tab.eval(ARROW);
	await showsList();
}, 30_000);

test.skipIf(!CHROME)('a reloaded screen that no longer exists says so, and back goes to the list', async () => {
	await visit(390, '?item=q%3Anobody%3AQ-9');
	await shows('?item=q%3Anobody%3AQ-9', '這一則已不存在');
	await tab.eval(ARROW);
	await showsList();
	await back();
	await tab.until(LEFT, 'leaving the board');

	await visit(390, '?controller=nobody');
	await shows('?controller=nobody', '這個主控已不存在');
	await back();
	await showsList();
}, 30_000);

test.skipIf(!CHROME)('wide: the browser back goes to the screen before', async () => {
	await visit(1400);
	await tab.eval(click('.inbox', '題目 1'));
	await shows(QUESTION(1), '題目 1');
	await tab.eval(click('.inbox', '題目 2'));
	await shows(QUESTION(2), '題目 2');
	await tab.eval(click('.roster', '@luna'));
	await shows(CONTROLLER(), '@luna');
	await back();
	await shows(QUESTION(2), '題目 2');
	await back();
	await shows(QUESTION(1), '題目 1');
	await back();
	await tab.until(`location.search === ''`, 'the list');
	expect((await screen()).text).toContain('從信箱選一則');
}, 30_000);

test.skipIf(!CHROME)('a reload on an archived report past the first archive page opens it again', async () => {
	expect(oldest.title).toBe(`封存回報 ${ARCHIVE_PAGE + 9}`);
	const search = `?item=${encodeURIComponent(oldest.key)}`;
	await visit(390, search);
	await shows(search, oldest.title);
	await reload();
	await shows(search, oldest.title);
	await back();
	await showsList();
}, 30_000);

test.skipIf(!CHROME)('phone: the list comes back where it was scrolled after a reload, by "←" and by the browser back', async () => {
	for (const goBack of [() => tab.eval(ARROW), back]) {
		await visit(390);
		await tab.eval(`[...document.querySelectorAll('.inbox button')].find((b) => b.innerText.includes('題目 25')).scrollIntoView()`);
		const scrolled = await tab.eval<number>('Math.round(scrollY)');
		expect(scrolled).toBeGreaterThan(500);
		await tab.eval(click('.inbox', '題目 25'));
		await shows(QUESTION(25), '題目 25');
		await tab.eval(click('.detail', '看主控資訊'));
		await shows(CONTROLLER(), '@luna');

		await reload();
		await shows(CONTROLLER(), '@luna');
		await goBack();
		await shows(QUESTION(25), '題目 25');
		await goBack();
		await showsList();
		await tab.until(`Math.abs(scrollY - ${scrolled}) <= 1`, `the list scrolled back to ${scrolled}`);
	}
}, 60_000);
