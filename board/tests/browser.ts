// What every browser test shares: finding Chrome, starting one on a port the system picks, and
// speaking to its tab over the DevTools protocol. Nothing here reads or writes the real profile.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
/** How Chrome fails a request still connecting when the host's network changes: another program
 *  adding or removing an interface or address (Docker does, for each container) is enough. */
const NETWORK_CHANGED = 'net::ERR_NETWORK_CHANGED';
/** How many times `Tab.navigate` loads a page whose load lost a request to such a change. */
const NAVIGATE_TRIES = 3;

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
	/** The loader of each request still going, and the loaders that lost one to a network change. */
	#loaderOf = new Map<string, string>();
	#networkChanged = new Set<string>();
	/** How many errors to keep when the next document commits: those of a load that is loaded again go. */
	#keepErrors: number | undefined;
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
			if (message.method === 'Network.requestWillBeSent') this.#loaderOf.set(message.params.requestId, message.params.loaderId);
			if (message.method === 'Network.loadingFinished' || message.method === 'Network.loadingFailed') {
				const loader = this.#loaderOf.get(message.params.requestId);
				if (loader && message.params.errorText === NETWORK_CHANGED) this.#networkChanged.add(loader);
				this.#loaderOf.delete(message.params.requestId);
			}
			if (message.method === 'Page.frameNavigated' && !message.params.frame.parentId && this.#keepErrors !== undefined) {
				this.errors.length = this.#keepErrors;
				this.#keepErrors = undefined;
			}
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
		await tab.start(scripts);
		return tab;
	}
	/** What the tab reports from then on: loads, errors and requests (for `navigate`); `scripts` run
	 *  first in every document. */
	async start(scripts: string[] = []) {
		await this.send('Page.enable');
		await this.send('Runtime.enable');
		await this.send('Page.setLifecycleEventsEnabled', { enabled: true });
		await this.send('Network.enable');
		for (const source of scripts) await this.send('Page.addScriptToEvaluateOnNewDocument', { source });
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
	/** A finger put down at (x, y) and moved by (dx, dy) in `steps` moves over `ms` ms, then lifted;
	 *  touch emulation must be on. `hold` leaves it down at the end instead of lifting. */
	async swipe(x: number, y: number, dx: number, { dy = 0, ms = 200, steps = 10, hold = false } = {}) {
		await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
		for (let step = 1; step <= steps; step++) {
			await sleep(ms / steps);
			await this.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * step) / steps, y: y + (dy * step) / steps }] });
		}
		if (!hold) await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	}
	/** As `swipe`, starting at the centre of the first element matching `selector`. */
	async swipeOn(selector: string, dx: number, options: { dy?: number; ms?: number; steps?: number; hold?: boolean } = {}) {
		const { x, y } = await this.eval<{ x: number; y: number }>(
			`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`
		);
		await this.swipe(x, y, dx, options);
	}
	async liftFinger() {
		await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	}
	/** Load a new document and wait until it has loaded. A load that lost a request to a change in the
	 *  host's network loads again, up to NAVIGATE_TRIES times: nothing in the page caused it, and a page
	 *  without one of its modules never starts. Only that error does; any other failure stays. */
	async navigate(url: string) {
		const kept = this.errors.length;
		try {
			for (let tries = 1; ; tries++) {
				const again = tries < NAVIGATE_TRIES;
				// The page given up on: its errors go once the next document commits.
				if (tries > 1) this.#keepErrors = kept;
				// The load of this navigation's own document: the tab's first, empty one also fires a load.
				const { loaderId, errorText } = await this.send('Page.navigate', { url });
				if (errorText === NETWORK_CHANGED && again) continue;
				if (errorText) throw new Error(`${url}: ${errorText}`);
				const deadline = Date.now() + 10_000;
				while (!this.#loaded.has(loaderId)) {
					if (this.#gone) throw await this.#gone;
					if (Date.now() > deadline) throw new Error(`timed out loading ${url}`);
					await sleep(20);
				}
				if (!this.#networkChanged.has(loaderId) || !again) return;
				console.error(`${url}: a request was lost to a change in the host's network (${NETWORK_CHANGED}); loading the page again`);
			}
		} finally {
			// A try that failed before its document committed leaves nothing for a later commit to cut.
			this.#keepErrors = undefined;
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
	/** Chrome's profile folder, removed when it ends. */
	profile: string;
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

/** What every test Chrome's profile folder in the temporary folder is called, before its random end. */
export const PROFILE_PREFIX = 'lat-board-test-chrome-';
/** The file in a test Chrome's profile that says whose it is: the PIDs and start times of the test
 *  process that started it (`owner`) and of the Chrome (`chrome`). A sweep goes by it and by nothing else. */
export const OWNER_FILE = 'lat-test-owner.json';

/** When the process `pid` started, in clock ticks since boot (field 22 of /proc/<pid>/stat), or
 *  undefined once it is gone: a PID with the start time it was recorded with is still that process. */
export function startTime(pid: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
		return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
	} catch {
		return undefined;
	}
}

interface Owner {
	owner: number;
	ownerStart: string;
	chrome?: number;
	chromeStart?: string;
}

/** How old a profile without `OWNER_FILE` must be before a sweep judges it: a younger one may be
 *  one a test just made and is about to mark. */
const UNMARKED_MS = 10 * 60_000;

/** Whether `profile` holds an `OWNER_FILE` whose owner is gone; undefined when it holds none. */
function ownerGone(profile: string): Owner | false | undefined {
	let owner: Owner;
	try {
		owner = JSON.parse(readFileSync(join(profile, OWNER_FILE), 'utf8'));
	} catch {
		return undefined;
	}
	return Number.isInteger(owner.owner) && startTime(owner.owner) !== owner.ownerStart && owner;
}

/** Whether a profile without `OWNER_FILE` (one an older version of these tests made) is still in
 *  use: the PID in Chrome's own `SingletonLock` (`<host>-<pid>`) runs a Chrome of this profile. */
function inUse(profile: string): boolean {
	let pid: number;
	try {
		pid = Number(readlinkSync(join(profile, 'SingletonLock')).split('-').pop());
	} catch {
		return false;
	}
	try {
		// Chrome rewrites its command line as one line; the profile path is still in it.
		return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(`--user-data-dir=${profile}`);
	} catch {
		return false;
	}
}

/**
 * End the test Chromes whose test process is gone and remove their profiles. A profile's
 * `OWNER_FILE` says whose it is: while that owner runs with its recorded start time, nothing of it
 * is touched, in any worktree; once it is gone, the Chrome it records is ended by its PID, and only
 * while that PID still has the recorded start time, and the profile goes. A profile without the
 * file (an older version's) goes once it is UNMARKED_MS old and no Chrome uses it. Processes are
 * found only by the PIDs these records name, never by name. Without /proc it does nothing.
 */
export function sweepLeftovers(dir = tmpdir()) {
	if (startTime(process.pid) === undefined) return;
	for (const name of readdirSync(dir)) {
		if (!name.startsWith(PROFILE_PREFIX)) continue;
		const profile = join(dir, name);
		const owner = ownerGone(profile);
		if (owner === false) continue;
		if (owner === undefined) {
			let made: number;
			try {
				made = statSync(profile).mtimeMs;
			} catch {
				continue;
			}
			if (Date.now() - made < UNMARKED_MS || inUse(profile)) continue;
		} else if (owner.chrome !== undefined && Number.isInteger(owner.chrome) && owner.chrome > 1 && [owner.chromeStart, undefined].includes(startTime(owner.chrome))) {
			// A PID above 1 only: a group kill of 0 or -1 would reach far more than one Chrome. A Chrome
			// whose PID is gone may have left its group running: no other group can take its number while it does.
			try {
				process.kill(-owner.chrome, 'SIGKILL');
			} catch {}
		}
		// Another start sweeping at the same time may be removing it too.
		try {
			rmSync(profile, { recursive: true, force: true });
		} catch {}
	}
}
let swept = false;

/** Linux's way to have the kernel kill a process when the one that started it ends (see `startChrome`). */
const SETPRIV = ['/usr/bin/setpriv', '/bin/setpriv'].find((path) => existsSync(path));

/** A test Chrome as started: the process, its profile, the end of its stderr, and `end`, which
 *  ends it and everything it started and removes its profile. */
export interface Started {
	chrome: ChildProcess;
	profile: string;
	tail(): string;
	end(): void;
}

/**
 * Start Chrome with `flags`, a profile of its own and its DevTools on a port it picks. It leads its
 * own process group, which `end` ends. Where `setpriv` is found it starts with `--pdeathsig KILL`:
 * the kernel kills it the moment the test process ends, however it ends (a SIGKILL included), and
 * the rest of its group follows it. Its profile records whose it is (`OWNER_FILE`), and the first
 * start in a process sweeps what gone test processes left (see `sweepLeftovers`).
 */
export function startChrome(flags: string[]): Started {
	if (!swept) {
		swept = true;
		sweepLeftovers();
	}
	const profile = mkdtempSync(join(tmpdir(), PROFILE_PREFIX));
	const marker = join(profile, OWNER_FILE);
	const mark = (record: Owner) => {
		writeFileSync(`${marker}.new`, JSON.stringify(record));
		renameSync(`${marker}.new`, marker);
	};
	const owner: Owner = { owner: process.pid, ownerStart: startTime(process.pid) ?? '' };
	mark(owner);
	const command = [CHROME, ...flags, `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'];
	if (SETPRIV) command.unshift(SETPRIV, '--pdeathsig', 'KILL');
	const chrome = spawn(command[0], command.slice(1), { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
	if (chrome.pid !== undefined) mark({ ...owner, chrome: chrome.pid, chromeStart: startTime(chrome.pid) });
	// The end of what Chrome wrote to stderr, to say why it ended.
	let stderr = '';
	chrome.stderr!.on('data', (chunk: Buffer) => (stderr = (stderr + chunk).slice(-2000)));
	const end = () => {
		if (chrome.pid !== undefined && chrome.exitCode === null && chrome.signalCode === null) {
			try {
				process.kill(-chrome.pid, 'SIGKILL');
			} catch {
				chrome.kill('SIGKILL');
			}
		}
		rmSync(profile, { recursive: true, force: true });
	};
	return { chrome, profile, tail: () => stderr.trim().split('\n').slice(-5).join('\n'), end };
}

/**
 * Start a headless Chrome with a profile of its own and a tab on it. Chrome picks the debugging
 * port itself (`--remote-debugging-port=0`) and says which in the profile's `DevToolsActivePort`.
 * A failure while starting ends the Chrome before it throws. `scripts` run first in every document;
 * `screen` is what `Tab.until` reports when a wait times out; `args` are more Chrome flags.
 */
export async function launchChrome(options: { scripts?: string[]; screen?: string; args?: string[] } = {}): Promise<Browser> {
	const { chrome, profile, tail, end } = startChrome([...CHROME_FLAGS, ...(options.args ?? [])]);
	const exited = new Promise<void>((resolve) => chrome.once('exit', () => resolve()));
	const ended = async () => {
		await Promise.race([exited, sleep(EXIT_MS)]);
		if (chrome.exitCode === null && chrome.signalCode === null) return 'Chrome is still running';
		return `Chrome exited with ${chrome.signalCode ?? `code ${chrome.exitCode}`}${tail() ? `; its stderr ends:\n${tail()}` : ''}`;
	};
	let tab: Tab | undefined;
	const close = async () => {
		tab?.close();
		end();
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
		return { tab, debugPort, pid: chrome.pid!, profile, close };
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

/** Voice input that works without a microphone or the speech service: run in a loaded page, a
 *  recording is a few bytes and the board answers every one with `text`. */
export const fakeMic = (text: string) => `(() => {
	Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [] }) } });
	window.MediaRecorder = class {
		mimeType = 'audio/webm';
		start() {}
		stop() {
			this.ondataavailable?.({ data: new Blob(['x']) });
			this.onstop?.();
		}
	};
	const fetch = window.fetch;
	window.fetch = (input, init) =>
		String(input).includes('/api/voice')
			? Promise.resolve(new Response(JSON.stringify({ text: ${JSON.stringify(text)} }), { headers: { 'content-type': 'application/json' } }))
			: fetch(input, init);
})()`;

/** The mic beside a text box that is not a MessageBox. */
export const micOf = (box: string) => `document.querySelector(${JSON.stringify(box)})?.parentElement.querySelector(':scope > button.mic')`;

/** How much the icon of the mic beside `box` differs in size from the command line's mic icon, in
 *  CSS pixels: the larger of the width and height differences. */
export const micIconOff = (box: string) => `(() => {
	const size = (mic) => mic.querySelector('svg').getBoundingClientRect();
	const mine = size(${micOf(box)});
	const line = size(document.querySelector('.cmd .voice-slot button'));
	return Math.max(Math.abs(mine.width - line.width), Math.abs(mine.height - line.height));
})()`;

/** Speak into a box through its mic (after `fakeMic`): pressed with the pointer to record, again to
 *  stop, and waited for until the mic is ready again. */
export async function speak(tab: Tab, box: string) {
	await tab.until(`${micOf(box)}?.dataset.voice === 'idle' && !${micOf(box)}.disabled`, `the mic beside ${box}`);
	await tab.eval(`(${micOf(box)}).dataset.speaking = ''`);
	await tab.eval(`${micOf(box)}.scrollIntoView({ block: 'center' })`);
	await tab.pointerClick('button.mic[data-speaking]');
	await tab.until(`${micOf(box)}.dataset.voice === 'recording'`, `recording into ${box}`);
	await tab.pointerClick('button.mic[data-speaking]');
	await tab.until(`${micOf(box)}.dataset.voice === 'idle'`, `the speech put into ${box}`);
	await tab.eval(`delete (${micOf(box)}).dataset.speaking`);
}

/** Run in a loaded page: requests to a path containing `path` wait until `release()` is called in
 *  the page, then go on as usual. */
export const holdRequests = (path: string) => `(() => {
	let go;
	const held = new Promise((resolve) => (go = resolve));
	window.release = () => go();
	const fetch = window.fetch;
	window.fetch = (input, init) => (String(input).includes(${JSON.stringify(path)}) ? held.then(() => fetch(input, init)) : fetch(input, init));
})()`;

/** A screenshot saved as `<name>.png` in the folder `LAT_BOARD_SHOTS` names; nothing without it.
 *  With `phone`, taken in a 390×844 phone window, `box` scrolled to the middle first, and the
 *  window put back to `back` after. */
export async function shot(tab: Tab, name: string, { phone = false, box, back }: { phone?: boolean; box?: string; back?: { width: number; height: number; mobile?: boolean } } = {}) {
	const folder = process.env.LAT_BOARD_SHOTS;
	if (!folder) return;
	if (phone) await tab.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
	if (box) await tab.eval(`document.querySelector(${JSON.stringify(box)})?.scrollIntoView({ block: 'center' })`);
	await sleep(300);
	const { data } = (await tab.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, `${name}.png`), Buffer.from(data, 'base64'));
	if (back) await tab.send('Emulation.setDeviceMetricsOverride', { width: back.width, height: back.height, deviceScaleFactor: 1, mobile: back.mobile ?? false });
}
