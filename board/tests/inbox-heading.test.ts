// The 待辦 tab's top row in a real browser: headless Chrome driven over its DevTools protocol, on
// the built board, at a desktop and a phone width. Skipped when the host has no Chrome.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { PORT_BASE, sleep, startFixture, type Fixture } from './harness.ts';

const CHROME = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(
	(path) => path && existsSync(path)
);
const DEBUG_PORT = PORT_BASE + 52;

/** One Chrome tab, spoken to over the DevTools protocol. */
class Tab {
	#socket: WebSocket;
	#next = 0;
	#waiting = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();
	constructor(socket: WebSocket) {
		this.#socket = socket;
		socket.addEventListener('message', (event) => {
			const message = JSON.parse(String(event.data));
			this.#waiting.get(message.id)?.(message);
			this.#waiting.delete(message.id);
		});
	}
	static async open(): Promise<Tab> {
		const deadline = Date.now() + 10_000;
		let target: { webSocketDebuggerUrl: string } | undefined;
		while (!target) {
			if (Date.now() > deadline) throw new Error('timed out waiting for Chrome to listen');
			target = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' }).then(
				(response) => response.json(),
				() => undefined
			);
			if (!target) await sleep(100);
		}
		const socket = new WebSocket(target.webSocketDebuggerUrl);
		await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
		return new Tab(socket);
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
	async until(expression: string, what = expression) {
		const deadline = Date.now() + 10_000;
		while (!(await this.eval(expression).catch(() => false))) {
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; the page shows ${JSON.stringify(await this.eval(`document.querySelector('.inbox')?.innerText ?? ''`))}`);
			await sleep(50);
		}
	}
	close() {
		this.#socket.close();
	}
}

let fixture: Fixture;
let cookie: string;
let chrome: ChildProcess | undefined;
let profile: string;
let tab: Tab;

beforeAll(async () => {
	fixture = await startFixture(51);
	cookie = await fixture.login();
}, 30_000);
afterEach(async () => {
	if (!chrome || chrome.exitCode !== null) return;
	tab.close();
	const exited = new Promise((resolve) => chrome!.once('exit', resolve));
	chrome.kill('SIGKILL');
	await exited;
	rmSync(profile, { recursive: true, force: true });
});
afterAll(async () => {
	await fixture?.cleanup();
});

async function visit(width: number) {
	profile = mkdtempSync(join(tmpdir(), 'lat-board-test-chrome-'));
	chrome = spawn(
		CHROME!,
		['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-extensions', `--user-data-dir=${profile}`, `--remote-debugging-port=${DEBUG_PORT}`, 'about:blank'],
		{ stdio: 'ignore' }
	);
	tab = await Tab.open();
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 761 });
	await tab.send('Page.navigate', { url: `${fixture.url}/?tab=inbox` });
	await tab.until(`JSON.stringify(history.state).includes('depth')`, 'the board to start');
	await tab.until(`!!document.querySelector('.inbox .toggle')`, 'the 待辦 tab');
}

for (const width of [1280, 360]) {
	test.skipIf(!CHROME)(`${width}px: no visible 待辦 title in the tab, the view switch sits at the left, the area keeps its name`, async () => {
		await visit(width);
		const row = await tab.eval<{ visibleTitles: string[]; toggleLeft: number; inboxLeft: number; toggleTop: number; headerTop: number; named: string[]; fits: boolean }>(`(() => {
			const inbox = document.querySelector('.inbox');
			const header = inbox.querySelector('header');
			const toggle = header.querySelector('.toggle');
			// Titles a reader of the screen sees: headings with a box of more than a pixel.
			const visibleTitles = [...inbox.querySelectorAll('h1, h2, h3')].filter((node) => node.getBoundingClientRect().width > 1).map((node) => node.innerText);
			return {
				visibleTitles,
				toggleLeft: toggle.getBoundingClientRect().left,
				inboxLeft: inbox.getBoundingClientRect().left,
				toggleTop: toggle.getBoundingClientRect().top,
				headerTop: header.getBoundingClientRect().top,
				named: [header.querySelector('h2')?.textContent, toggle.getAttribute('aria-label')],
				fits: document.documentElement.scrollWidth <= window.innerWidth
			};
		})()`);
		expect(row.visibleTitles).toEqual([]);
		// Left-aligned: the first button starts where the column's content starts, on the header's row.
		expect(row.toggleLeft - row.inboxLeft).toBeLessThan(30);
		expect(Math.abs(row.toggleTop - row.headerTop)).toBeLessThan(2);
		// Still named for assistive technology: a heading that is hidden from the eye only.
		expect(row.named).toEqual(['待辦', '待辦檢視']);
		expect(row.fits).toBe(true);
	}, 30_000);
}
