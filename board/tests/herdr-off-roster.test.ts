// A controller still bound whose client is closed and whose reports are all archived, in a real
// browser: headless Chrome driven over its DevTools protocol, on the built board with fake hcom,
// Herdr, helper and input command, wide and at a phone's width. It is off the roster, so the To-do
// tab does not list it, but on the Herdr tab its card opens the controller's page and the command
// line wakes it, resuming its conversation. Skipped when the host has no Chrome.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { SentEntry } from '../src/lib/board/answers.ts';
import type { BoardSnapshot } from '../src/lib/board/types.ts';
import { NODE, PORT_BASE, sleep, startFixture, type Fixture } from './harness.ts';

const CHROME = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(
	(path) => path && existsSync(path)
);
const DEBUG_PORT = PORT_BASE + 80;

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
		const tab = new Tab(socket);
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
	/** A click with the pointer at the centre of the first element matching `selector`: it lands on
	 *  whatever is on top there, which an element's own click() does not. */
	async until(expression: string, what = expression) {
		const deadline = Date.now() + 10_000;
		while (!(await this.eval(expression).catch(() => false))) {
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; the page shows ${JSON.stringify(await this.eval(SCREEN))}`);
			await sleep(50);
		}
	}
	close() {
		this.#socket.close();
	}
}

const SCREEN = `({ search: location.search, detail: document.querySelector('.detail')?.innerText ?? '', notices: document.querySelector('.dock')?.innerText ?? '' })`;
/** The tab strip's labels, without their counts. */
const TABS = `[...document.querySelectorAll('.detail [role="tablist"] [role="tab"]')].map((b) => b.innerText.replace(/\\s*\\d+$/, '').trim())`;
const FITS = `document.documentElement.scrollWidth <= window.innerWidth`;
const BOX = '.dock .cmd textarea';
const SEND = '.dock .cmd .send-slot button';
const OPTIONS = '.dock .cmd button.options';
const POPUP = '.dock .popup[aria-label="喚醒選項"]';
const CARD = `document.querySelector('.inbox button.agent[data-agent="s-old"]')`;
/** Click the first button in `scope` whose text includes `text`. */
const click = (scope: string, text: string) =>
	`[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => b.innerText.includes(${JSON.stringify(text)})).click()`;
const pageOf = (header: string) => `document.querySelector('.detail .profile h2')?.innerText === ${JSON.stringify(header)}`;

const DAY_MS = 24 * 60 * 60_000;

const injectDir = mkdtempSync(join(tmpdir(), 'lat-board-inject-'));
let fixture: Fixture;
let cookie: string;
let chrome: ChildProcess | undefined;
let profile: string;
let tab: Tab;
let old: ReturnType<Fixture['bound']>;

function herdrAgent(session: string, cwd: string) {
	return {
		agent: 'claude',
		agent_session: { kind: 'id', value: session },
		agent_status: 'idle',
		cwd,
		pane_id: `wA:p-${session}`,
		tab_id: `wA:t-${session}`,
		workspace_id: 'wA'
	};
}
const lines = (file: string): any[] => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
const injects = (): string[][] => lines(join(injectDir, 'inject-calls.jsonl'));
const resumes = (): string[][] => lines(join(fixture.dir, 'hcom-calls.jsonl')).map((call: { args: string[] }) => call.args).filter((args) => args[0] === 'r');
async function sentLog(controllerId: string): Promise<SentEntry[]> {
	return (await (await fixture.fetch(`/api/messages?controller=${encodeURIComponent(controllerId)}`, { cookie })).json()).entries;
}
async function agentLog(agentId: string): Promise<unknown[]> {
	return (await (await fixture.fetch(`/api/agents/log?session=${encodeURIComponent(agentId)}`, { cookie })).json()).entries;
}

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture(81, {
		env: {
			LAT_BOARD_INJECT_COMMAND: JSON.stringify([NODE, join(import.meta.dir, 'fake-inject.mjs'), injectDir]),
			LAT_BOARD_HCOM_TIMEOUT_SECONDS: '1'
		}
	});
	cookie = await fixture.login('herdr-off-roster');
	old = fixture.bound('qa', 'old', { session_id: 's-old' });
	// Its only report is over 7 days old, so archived.
	fixture.report('s-old', { tag: 'DONE', summary: '早就收工', message: '早就收工了。', time: new Date(Date.now() - 8 * DAY_MS).toISOString(), hcom_name: 'old', workspace: old.workspace });
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', 's-old.jsonl'), JSON.stringify({ kind: 'assistant', time: new Date(Date.now() - 8 * DAY_MS).toISOString(), text: '早就收工了。' }) + '\n');
	fixture.list([old]);
	// Bound, but hcom no longer lists it: closed, its pane still in Herdr.
	fixture.setHcom({ agents: [] });
	const agent = herdrAgent('s-old', old.workspace);
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents: [agent],
			panes: [{ pane_id: agent.pane_id, workspace_id: agent.workspace_id, cwd: agent.cwd }],
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
			tabs: [{ tab_id: agent.tab_id, workspace_id: agent.workspace_id, label: '分頁-s-old' }]
		})
	);
	await fixture.refresh(cookie);
}, 30_000);

beforeEach(() => {
	if (!CHROME) return;
	for (const file of ['inject-calls.jsonl', 'inject-typed.jsonl']) rmSync(join(injectDir, file), { force: true });
	rmSync(join(fixture.dir, 'hcom-calls.jsonl'), { force: true });
});
afterEach(async () => {
	if (!chrome || chrome.exitCode !== null || chrome.signalCode !== null) return;
	tab?.close();
	const exited = new Promise((resolve) => chrome!.once('exit', resolve));
	chrome.kill('SIGKILL');
	await exited;
	rmSync(profile, { recursive: true, force: true });
});
afterAll(async () => {
	await fixture?.cleanup();
	rmSync(injectDir, { recursive: true, force: true });
});

/** A new Chrome, logged in, on the board in a window `width` wide. */
async function visit(width: number) {
	profile = mkdtempSync(join(tmpdir(), 'lat-board-test-chrome-'));
	chrome = spawn(
		CHROME!,
		['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-extensions', '--disable-component-extensions-with-background-pages', `--user-data-dir=${profile}`, `--remote-debugging-port=${DEBUG_PORT}`, 'about:blank'],
		{ stdio: 'ignore' }
	);
	tab = await Tab.open();
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width < 761 });
	await tab.send('Page.navigate', { url: `${fixture.url}/` });
	await tab.until(`JSON.stringify(history.state).includes('depth')`, 'the board to start');
}
const type = (text: string) =>
	tab.eval(`(() => {
		const box = document.querySelector(${JSON.stringify(BOX)});
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(text)});
		box.dispatchEvent(new Event('input', { bubbles: true }));
	})()`);

test.skipIf(!CHROME)('it is off the roster and its report stays archived, but a controller on the Herdr tab', async () => {
	const snapshot: BoardSnapshot = await fixture.board(cookie);
	expect(snapshot.controllers).toEqual([]);
	expect(snapshot.offRoster.map((controller) => [controller.id, controller.status])).toEqual([['s-old', 'closed']]);
	expect(snapshot.inbox).toEqual([]);
	expect(snapshot.agents.map((agent) => [agent.id, agent.controller])).toEqual([['s-old', true]]);
});

for (const width of [1280, 390]) {
	test.skipIf(!CHROME)(`${width}px: its card opens the controller's page, whose command line wakes it; the To-do tab still does not list it`, async () => {
		const text = `醒來 ${width}`;
		await visit(width);
		// The To-do tab: no controller on its roster, nothing in its list.
		expect(await tab.eval(`!!document.querySelector('[data-controller="old"]')`)).toBe(false);
		expect(await tab.eval(`document.querySelector('.unfolded .roster, .unfolded')?.innerText.includes('qa') ?? false`)).toBe(false);
		await tab.eval(`document.querySelector('[data-middle="agents"]').click()`);
		await tab.until(`!!${CARD}`, 'its card');
		expect(await tab.eval<string>(`${CARD}.innerText`)).toContain('主控');
		await tab.eval(`${CARD}.click()`);
		await tab.until(`${pageOf('qa')} && document.querySelector(${JSON.stringify(SEND)})?.innerText.trim() === '喚醒'`, "the controller's page");
		expect(new URLSearchParams(await tab.eval<string>('location.search')).get('agent')).toBe('s-old');
		expect(await tab.eval(TABS)).toEqual(['對話紀錄', '回報', '送出紀錄', '操作紀錄']);
		expect(await tab.eval<string>(`document.querySelector('.detail .profile').innerText`)).toContain('已關閉');
		if (width > 760) expect(await tab.eval(`document.querySelector('.dock .to').innerText`)).toBe('→ @old');
		// The wake's options, as on any closed controller's page.
		await type(text);
		await tab.eval(`document.querySelector(${JSON.stringify(OPTIONS)}).click()`);
		await tab.until(`!!document.querySelector(${JSON.stringify(POPUP)})`, 'the wake options');
		expect(await tab.eval<string>(`document.querySelector(${JSON.stringify(POPUP)}).innerText`)).toContain('開新一輪 LAT');
		expect(await tab.eval(FITS)).toBe(true);
		await tab.eval(`document.querySelector(${JSON.stringify(SEND)}).click()`);
		await tab.until(`document.querySelector(${JSON.stringify(BOX)}).value === ''`, 'the box emptied');
		// Resumed by its session ID; nothing typed, nothing sent as an agent.
		expect(resumes()).toEqual([['r', 's-old', '--terminal', 'herdr', '--no-run-here', '--go', '--hcom-prompt', text]]);
		expect(injects()).toEqual([]);
		expect(await agentLog('s-old')).toEqual([]);
		const wake = (await sentLog('s-old')).find((entry) => 'text' in entry && entry.text === text);
		expect(wake).toMatchObject({ kind: 'wake', route: 'resume' });
		await tab.eval(click('.detail [role="tablist"]', '送出紀錄'));
		await tab.until(`document.querySelector('#panel-sent:not([hidden])')?.innerText.includes(${JSON.stringify(text)})`, 'the wake in the sent log');
		// Back on the To-do tab, it is still not listed and its report not brought back.
		if (await tab.eval(`!!document.querySelector('.topbar')`)) {
			await tab.eval(`document.querySelector('.topbar button').click()`);
			await tab.until(`!document.querySelector('.topbar')`, 'the list again');
		}
		await tab.eval(`document.querySelector('[data-middle="inbox"]').click()`);
		await tab.until(`document.querySelector('[data-middle="inbox"]').getAttribute('aria-pressed') === 'true'`, 'the To-do tab');
		expect(await tab.eval(`!!document.querySelector('[data-controller="old"]')`)).toBe(false);
		expect(await tab.eval<string>(`document.querySelector('.inbox').innerText`)).not.toContain('早就收工');
		const after: BoardSnapshot = await fixture.board(cookie);
		expect(after.controllers).toEqual([]);
		expect(after.inbox).toEqual([]);
		// The attempt stays open until the resumed client shows; given up for the next test.
		await fixture.fetch('/api/wake/abandon', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ controllerId: 's-old', wakeId: wake!.id }),
			cookie
		});
	}, 60_000);
}
