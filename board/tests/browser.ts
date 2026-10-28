// What every browser test shares: finding Chrome, starting one on a port the system picks, and
// speaking to its tab over the DevTools protocol. Nothing here reads or writes the real profile.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Where a Chrome may be; `CHROME` in the environment names the only one to use. */
export const CHROME_PATHS = process.env.CHROME ? [process.env.CHROME] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const found = CHROME_PATHS.find((path) => existsSync(path));
// A browser test without Chrome fails instead of skipping, so a host without one never reads as a pass.
if (!found) throw new Error(`找不到 Chrome（找過 ${CHROME_PATHS.join('、')}）：安裝 Chrome 或 Chromium，或以環境變數 CHROME 指定執行檔`);
/** The Chrome the tests use. */
export const CHROME: string = found;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long a request to Chrome may go unanswered: as long as the other waits here (a page load, a
 * `Tab.until`), and well inside the 30 s the board's tests give a test, so a stalled request fails
 * its own test with its name instead of running into Bun's timeout, which also kills the shared
 * board the file started in `beforeAll`.
 */
export const REQUEST_MS = 10_000;
/** How long `Tab.until` waits for its `screen` after a timeout: a page that stopped answering may not show it. */
const SCREEN_MS = 2_000;
/** How long a closed tab waits for its Chrome to exit, to say how Chrome ended. */
const EXIT_MS = 1_000;

/** A request as a failure names it: the method and what it was given, cut short. */
function describe(method: string, params: object): string {
	const shown = 'expression' in params ? String(params.expression) : JSON.stringify(params);
	return `${method} ${shown.length > 200 ? `${shown.slice(0, 200)}…` : shown}`;
}

/** One Chrome tab, spoken to over the DevTools protocol. */
export class Tab {
	#socket: WebSocket;
	/** Why the tab is gone, once its socket closed: every request since fails with it. */
	#gone: Promise<Error> | undefined;
	#next = 0;
	#waiting = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();
	#failures = new Set<(error: Error) => void>();
	/** The documents that have loaded, by the loader that loaded them. */
	#loaded = new Set<string>();
	/** The requests held by `Fetch.enable`, waiting for `Fetch.continueRequest`. */
	paused: string[] = [];
	/** The page's uncaught exceptions and console errors; empty it (`errors.length = 0`) to start over. */
	errors: string[] = [];
	/** An expression in the page whose value a timed out wait reports, to show what the page was doing. */
	screen: string | undefined;
	/** What the Chrome behind the tab has written to stderr lately; an unanswered request's failure adds it. */
	#stderr: (() => string) | undefined;
	/** `ended`, when given, says how the Chrome behind the tab ended; a closed tab's failures add it. */
	constructor(socket: WebSocket, ended?: () => Promise<string>, stderr?: () => string) {
		this.#socket = socket;
		this.#stderr = stderr;
		socket.addEventListener('message', (event) => {
			const message = JSON.parse(String(event.data));
			if (message.method === 'Page.lifecycleEvent' && message.params.name === 'load') this.#loaded.add(message.params.loaderId);
			if (message.method === 'Fetch.requestPaused') this.paused.push(message.params.requestId);
			if (message.method === 'Runtime.exceptionThrown') this.errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
			if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
				this.errors.push(message.params.args.map((arg: { value?: string; description?: string }) => arg.value ?? arg.description).join(' '));
			}
			this.#waiting.get(message.id)?.(message);
			this.#waiting.delete(message.id);
		});
		// A tab that is gone answers nothing: every request still waiting fails instead of hanging.
		const gone = (what: string) => {
			this.#gone ??= (ended?.() ?? Promise.resolve('')).then((how) => new Error(how ? `${what}: ${how}` : what));
			this.#gone.then((error) => this.#fail(error));
		};
		socket.addEventListener('close', () => gone('the Chrome tab closed'));
		socket.addEventListener('error', () => gone('the Chrome tab failed'));
	}
	#fail(error: Error) {
		for (const fail of this.#failures) fail(error);
		this.#failures.clear();
		this.#waiting.clear();
	}
	/** A new tab of the Chrome listening on `debugPort`. `scripts` run first in every document. */
	static async open(debugPort: number, scripts: string[] = [], ended?: () => Promise<string>, stderr?: () => string): Promise<Tab> {
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
		await new Promise((resolve, reject) => {
			socket.addEventListener('open', resolve, { once: true });
			socket.addEventListener('error', () => reject(new Error('the Chrome tab did not open')), { once: true });
		});
		const tab = new Tab(socket, ended, stderr);
		await tab.send('Page.enable');
		await tab.send('Runtime.enable');
		await tab.send('Page.setLifecycleEventsEnabled', { enabled: true });
		for (const source of scripts) await tab.send('Page.addScriptToEvaluateOnNewDocument', { source });
		return tab;
	}
	/** A DevTools request; one Chrome does not answer within `ms` fails, naming the request. */
	send(method: string, params: object = {}, ms = REQUEST_MS): Promise<any> {
		// A closed socket drops what is sent to it: the request would wait forever.
		if (this.#gone) return this.#gone.then((error) => Promise.reject(error));
		const id = ++this.#next;
		this.#socket.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => {
			const fail = (error: Error) => {
				clearTimeout(timer);
				reject(error);
			};
			const timer = setTimeout(() => {
				// A tab that closed meanwhile fails the request with why it closed, once that is known.
				if (this.#gone) return;
				this.#failures.delete(fail);
				this.#waiting.delete(id);
				const tail = this.#stderr?.() ?? '';
				reject(new Error(`no answer from Chrome in ${ms} ms to ${describe(method, params)}${tail ? `; Chrome's stderr ends:\n${tail}` : ''}`));
			}, ms);
			this.#failures.add(fail);
			this.#waiting.set(id, (message) => {
				clearTimeout(timer);
				this.#failures.delete(fail);
				message.error ? reject(new Error(message.error.message)) : resolve(message.result);
			});
		});
	}
	async eval<T = unknown>(expression: string, ms = REQUEST_MS): Promise<T> {
		const { result, exceptionDetails } = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, ms);
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
			if (this.#gone) throw await this.#gone;
			if (Date.now() > deadline) throw new Error(`timed out loading ${url}`);
			await sleep(20);
		}
	}
	/** Wait for an expression in the page to be true. */
	async until(expression: string, what = expression, ms = 10_000) {
		const deadline = Date.now() + ms;
		const timedOut = async () => {
			const shown = this.screen ? `; the page shows ${JSON.stringify(await this.eval(this.screen, SCREEN_MS).catch(() => null))}` : '';
			return new Error(`timed out waiting for ${what}${shown}`);
		};
		for (;;) {
			const left = deadline - Date.now();
			if (left <= 0) throw await timedOut();
			// A check gets only the time left (at most REQUEST_MS): one Chrome does not answer in it ends
			// the wait, since a page that stopped answering would only keep the test waiting.
			const met = await this.eval(expression, Math.min(left, REQUEST_MS)).catch((error: Error) => {
				if (this.#gone) throw error;
				if (error.message.startsWith('no answer from Chrome')) throw new Error(`timed out waiting for ${what}: ${error.message}`);
				return false;
			});
			// An answer after the deadline is too late, whatever it says.
			if (Date.now() > deadline) throw await timedOut();
			if (met) return;
			await sleep(Math.min(50, deadline - Date.now()));
		}
	}
	close() {
		this.#gone ??= Promise.resolve(new Error('the test closed the Chrome tab'));
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

/**
 * How every test Chrome starts, before its profile and port. `--password-store=basic` (and, on macOS,
 * `--use-mock-keychain`) keeps the cookie-encryption key in the profile: without it, Chrome on Linux
 * asks the session D-Bus (gnome-keyring, the XDG secret portal, 25 s timeout each) before its cookie
 * store can answer, so the test's first `Network.setCookie` waits on services the test does not own.
 */
export const CHROME_FLAGS = ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-extensions', '--disable-component-extensions-with-background-pages', '--password-store=basic', '--use-mock-keychain'];

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
 * `screen` is what `Tab.until` reports when a wait times out; `args` are more Chrome flags.
 */
export async function launchChrome(options: { scripts?: string[]; screen?: string; args?: string[] } = {}): Promise<Browser> {
	const profile = mkdtempSync(join(tmpdir(), 'lat-board-test-chrome-'));
	const chrome = spawn(CHROME, [...CHROME_FLAGS, ...(options.args ?? []), `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
	const exited = new Promise<void>((resolve) => chrome.once('exit', () => resolve()));
	// The end of what Chrome wrote to stderr, to say why it ended.
	let stderr = '';
	chrome.stderr!.on('data', (chunk: Buffer) => (stderr = (stderr + chunk).slice(-2000)));
	const tail = () => stderr.trim().split('\n').slice(-5).join('\n');
	const ended = async () => {
		await Promise.race([exited, sleep(EXIT_MS)]);
		if (chrome.exitCode === null && chrome.signalCode === null) return 'Chrome is still running';
		return `Chrome exited with ${chrome.signalCode ?? `code ${chrome.exitCode}`}${tail() ? `; its stderr ends:\n${tail()}` : ''}`;
	};
	let tab: Tab | undefined;
	const close = async () => {
		tab?.close();
		endProcess(chrome);
		if (chrome.exitCode === null && chrome.signalCode === null) await exited;
		rmSync(profile, { recursive: true, force: true });
	};
	try {
		const debugPort = await debuggingPort(profile, chrome);
		// Chrome that stops answering after it said its port must not hang the setup past its own cleanup.
		let giveUp: ReturnType<typeof setTimeout>;
		const timeout = new Promise<never>((_, reject) => (giveUp = setTimeout(() => reject(new Error('timed out opening a Chrome tab')), 20_000)));
		tab = await Promise.race([Tab.open(debugPort, options.scripts, ended, tail), timeout]).finally(() => clearTimeout(giveUp));
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
