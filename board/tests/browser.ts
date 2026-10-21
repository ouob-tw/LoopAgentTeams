// What every browser test shares: finding Chrome, starting one on a port the system picks, and
// speaking to its tab over the DevTools protocol. Nothing here reads or writes the real profile.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Where a Chrome may be; `CHROME` in the environment names one first. */
export const CHROME_PATHS = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
/** The Chrome the tests use, or undefined (they skip) when the host has none. */
export const CHROME = CHROME_PATHS.find((path) => path && existsSync(path));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One Chrome tab, spoken to over the DevTools protocol. */
export class Tab {
	#socket: WebSocket;
	#next = 0;
	#waiting = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();
	/** The documents that have loaded, by the loader that loaded them. */
	#loaded = new Set<string>();
	/** The requests held by `Fetch.enable`, waiting for `Fetch.continueRequest`. */
	paused: string[] = [];
	/** An expression in the page whose value a timed out wait reports, to show what the page was doing. */
	screen: string | undefined;
	constructor(socket: WebSocket) {
		this.#socket = socket;
		socket.addEventListener('message', (event) => {
			const message = JSON.parse(String(event.data));
			if (message.method === 'Page.lifecycleEvent' && message.params.name === 'load') this.#loaded.add(message.params.loaderId);
			if (message.method === 'Fetch.requestPaused') this.paused.push(message.params.requestId);
			this.#waiting.get(message.id)?.(message);
			this.#waiting.delete(message.id);
		});
	}
	/** A new tab of the Chrome listening on `debugPort`. `scripts` run first in every document. */
	static async open(debugPort: number, scripts: string[] = []): Promise<Tab> {
		const deadline = Date.now() + 10_000;
		let target: { webSocketDebuggerUrl: string } | undefined;
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
		const tab = new Tab(socket);
		await tab.send('Page.enable');
		await tab.send('Page.setLifecycleEventsEnabled', { enabled: true });
		for (const source of scripts) await tab.send('Page.addScriptToEvaluateOnNewDocument', { source });
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
	/** A click with the pointer at the centre of the first element matching `selector`: it lands on
	 *  whatever is on top there, which an element's own click() does not. */
	async pointerClick(selector: string) {
		const { x, y } = await this.eval<{ x: number; y: number }>(
			`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`
		);
		for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
			await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
		}
	}
	/** Load a new document and wait until it has loaded. */
	async navigate(url: string) {
		// The load of this navigation's own document: the tab's first, empty one also fires a load.
		const { loaderId, errorText } = await this.send('Page.navigate', { url });
		if (errorText) throw new Error(`${url}: ${errorText}`);
		const deadline = Date.now() + 10_000;
		while (!this.#loaded.has(loaderId)) {
			if (Date.now() > deadline) throw new Error(`timed out loading ${url}`);
			await sleep(20);
		}
	}
	/** Wait for an expression in the page to be true. */
	async until(expression: string, what = expression, ms = 10_000) {
		const deadline = Date.now() + ms;
		while (!(await this.eval(expression).catch(() => false))) {
			if (Date.now() > deadline) {
				const shown = this.screen ? `; the page shows ${JSON.stringify(await this.eval(this.screen).catch(() => null))}` : '';
				throw new Error(`timed out waiting for ${what}${shown}`);
			}
			await sleep(50);
		}
	}
	close() {
		this.#socket.close();
	}
}

export interface Browser {
	tab: Tab;
	/** The port Chrome's DevTools listens on. */
	debugPort: number;
	/** The Chrome process's PID. */
	pid: number;
	/** Close the tab, end this Chrome (by its PID) and remove its profile. */
	close(): Promise<void>;
}

/** Kill the Chrome and everything it started, by its PID: Chrome leads its own process group. */
function endProcess(chrome: ChildProcess) {
	if (chrome.pid === undefined || chrome.exitCode !== null) return;
	try {
		process.kill(-chrome.pid, 'SIGKILL');
	} catch {
		chrome.kill('SIGKILL');
	}
}

/**
 * Start a headless Chrome with a profile of its own and a tab on it. Chrome picks the debugging
 * port itself (`--remote-debugging-port=0`) and says which in the profile's `DevToolsActivePort`.
 * A failure while starting ends the Chrome before it throws. `scripts` run first in every document;
 * `screen` is what `Tab.until` reports when a wait times out.
 */
export async function launchChrome(options: { scripts?: string[]; screen?: string } = {}): Promise<Browser> {
	if (!CHROME) throw new Error('no Chrome on this host');
	const profile = mkdtempSync(join(tmpdir(), 'lat-board-test-chrome-'));
	const chrome = spawn(
		CHROME,
		['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-extensions', '--disable-component-extensions-with-background-pages', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'],
		{ stdio: 'ignore', detached: true }
	);
	const exited = new Promise<void>((resolve) => chrome.once('exit', () => resolve()));
	let tab: Tab | undefined;
	const close = async () => {
		tab?.close();
		endProcess(chrome);
		if (chrome.exitCode === null && chrome.signalCode === null) await exited;
		rmSync(profile, { recursive: true, force: true });
	};
	try {
		const debugPort = await debuggingPort(profile, chrome);
		tab = await Tab.open(debugPort, options.scripts);
		tab.screen = options.screen;
		return { tab, debugPort, pid: chrome.pid!, close };
	} catch (error) {
		await close();
		throw error;
	}
}

/** The port Chrome wrote to its profile's `DevToolsActivePort` (the file's first line). */
async function debuggingPort(profile: string, chrome: ChildProcess): Promise<number> {
	const file = join(profile, 'DevToolsActivePort');
	const deadline = Date.now() + 10_000;
	for (;;) {
		if (existsSync(file)) {
			const [first, rest] = readFileSync(file, 'utf8').split('\n');
			// The second line is written together with the first; a half-written file has neither.
			if (rest !== undefined && Number(first) > 0) return Number(first);
		}
		if (chrome.exitCode !== null) throw new Error(`Chrome exited with ${chrome.exitCode}`);
		if (Date.now() > deadline) throw new Error('timed out waiting for Chrome to say which port it listens on');
		await sleep(50);
	}
}
