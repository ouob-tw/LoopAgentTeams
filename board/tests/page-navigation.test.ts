// Loading the board's pages as new documents in one tab, the way the address bar or a link from
// elsewhere does. The 中文 switch across the three pages that show a conversation: a controller's
// information page, a Herdr agent's page and a closed agent's page, each loaded in turn, at a
// desktop's and a phone's width; the same English reply is on all three, and once translated it
// shows translated on each. The pages left behind are kept for the back button, so this also
// shows that they do not hold the board's connections (six over HTTP/1.1) and starve the page in
// view. And going back to the board from another page loads it again, its feeds live and its
// command-line draft still there. Skipped when the host has no Chrome.
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { NODE, PORT_BASE, sleep, startFixture, type Fixture } from './harness.ts';

const CHROME = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(
	(path) => path && existsSync(path)
);
const DEBUG_PORT = PORT_BASE + 73;
const ROOT = join(import.meta.dir, '..');
const codexDir = mkdtempSync(join(tmpdir(), 'lat-board-codex-'));
/** One Chrome tab, spoken to over the DevTools protocol. */
class Tab {
	#socket: WebSocket;
	#next = 0;
	#waiting = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();
	/** The documents that have loaded, by the loader that loaded them. */
	#loaded = new Set<string>();
	constructor(socket: WebSocket) {
		this.#socket = socket;
		socket.addEventListener('message', (event) => {
			const message = JSON.parse(String(event.data));
			if (message.method === 'Page.lifecycleEvent' && message.params.name === 'load') this.#loaded.add(message.params.loaderId);
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
		await tab.send('Page.setLifecycleEventsEnabled', { enabled: true });
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
		const { loaderId, errorText } = await this.send('Page.navigate', { url });
		if (errorText) throw new Error(`${url}: ${errorText}`);
		const deadline = Date.now() + 10_000;
		while (!this.#loaded.has(loaderId)) {
			if (Date.now() > deadline) throw new Error(`timed out loading ${url}`);
			await sleep(20);
		}
	}
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

const SCREEN = `document.querySelector('.detail')?.innerText ?? ''`;
const ENGLISH = 'The server now saves each completed translation and reuses it on another device.';
const DONE = `!!document.querySelector('.detail [data-translation="done"]')`;
const STATE = `[...document.querySelectorAll('.detail [data-translation]')].map((li) => li.dataset.translation).join(',')`;
const PRESSED = `[...document.querySelectorAll('.detail .language button')].find((b) => b.innerText === '中文')?.getAttribute('aria-pressed') === 'true'`;
const line = (kind: string, text: string) => JSON.stringify({ kind, time: '2026-10-21T01:00:00Z', text }) + '\n';

let fixture: Fixture;
let cookie: string;
let chrome: ChildProcess;
let profile: string;
let tab: Tab;
let lead: ReturnType<Fixture['bound']>;

function herdrAgent(session: string) {
	return {
		agent: 'claude',
		agent_session: { kind: 'id', value: session },
		agent_status: 'idle',
		cwd: `/home/someone/projects/${session}`,
		pane_id: `wA:p-${session}`,
		tab_id: `wA:t-${session}`,
		workspace_id: 'wA'
	};
}
function setHerdr(agents: ReturnType<typeof herdrAgent>[]) {
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents,
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
			panes: agents.map((agent) => ({ pane_id: agent.pane_id, workspace_id: agent.workspace_id, cwd: agent.cwd, tab_id: agent.tab_id })),
			tabs: agents.map((agent) => ({ tab_id: agent.tab_id, workspace_id: agent.workspace_id, label: `分頁-${agent.agent_session.value}` }))
		})
	);
}

beforeAll(async () => {
	if (!CHROME) return;
	writeFileSync(join(codexDir, 'codex.json'), JSON.stringify({ prefix: '譯：', delayMs: 300 }));
	fixture = await startFixture(72, {
		env: { LAT_BOARD_TRANSLATE_COMMAND: JSON.stringify([NODE, join(ROOT, 'tests/fake-codex.mjs'), codexDir]) }
	});
	cookie = await fixture.login('translate-pages');
	lead = fixture.bound('alpha', 'lead');
	fixture.list([lead]);
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	for (const session of [lead.session_id, 's-live', 's-gone']) {
		writeFileSync(join(fixture.dir, 'transcripts', `${session}.jsonl`), line('user', 'Please keep my English request unchanged.') + line('assistant', ENGLISH));
	}
	// The board sees both in Herdr, then the second is gone: closed by its pane.
	setHerdr([herdrAgent('s-live'), herdrAgent('s-gone')]);
	await fixture.refresh(cookie);
	setHerdr([herdrAgent('s-live')]);
	const event = {
		data: { action: 'stopped', by: 'pty', reason: 'killed', snapshot: { name: 'gone', session_id: 's-gone', tool: 'claude', directory: '/home/someone/projects/s-gone' } },
		id: 2,
		instance: 'gone',
		ts: new Date(Date.now() - 60_000).toISOString(),
		type: 'life'
	};
	appendFileSync(join(fixture.dir, 'hcom-events.jsonl'), JSON.stringify(event) + '\n');
	await fixture.refresh(cookie);
}, 30_000);

afterAll(async () => {
	await stopChrome();
	await fixture?.cleanup();
	rmSync(codexDir, { recursive: true, force: true });
});

async function stopChrome() {
	if (!chrome || chrome.exitCode !== null || chrome.signalCode !== null) return;
	tab.close();
	const exited = new Promise((resolve) => chrome.once('exit', resolve));
	chrome.kill('SIGKILL');
	await exited;
	rmSync(profile, { recursive: true, force: true });
}

async function visit(width: number) {
	await stopChrome();
	profile = mkdtempSync(join(tmpdir(), 'lat-board-test-chrome-'));
	chrome = spawn(
		CHROME!,
		['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-extensions', '--disable-component-extensions-with-background-pages', `--user-data-dir=${profile}`, `--remote-debugging-port=${DEBUG_PORT}`, 'about:blank'],
		{ stdio: 'ignore' }
	);
	tab = await Tab.open();
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 761 });
}

for (const width of [1440, 412]) {
	test.skipIf(!CHROME)(`switched on at a controller's page, the agent and closed agent pages loaded next show the reply translated (${width}px)`, async () => {
		await visit(width);
		await tab.navigate(`${fixture.url}/?controller=${lead.session_id}`);
		// The switch is drawn by the server first: clicked once the page has started.
		await tab.until(`!!document.querySelector('.detail .language') && performance.now() > 1500`, "the controller's conversation");
		await tab.eval(`[...document.querySelectorAll('.detail .language button')].find((b) => b.innerText === '中文').click()`);
		await tab.until(DONE, 'the translation on the controller page');
		for (let round = 0; round < 3; round++) {
			for (const session of ['s-live', 's-gone']) {
				await tab.navigate(`${fixture.url}/?agent=${session}&tab=agents`);
				await tab.until(`!!document.querySelector('.detail .language')`, `${session}'s page`);
				// The saved choice is put back once the page has started.
				await tab.until(PRESSED, `中文 on ${session}'s page`);
				const deadline = Date.now() + 10_000;
				while (!(await tab.eval(DONE))) {
					if (Date.now() > deadline) throw new Error(`no translation on ${session}'s page (round ${round}): ${await tab.eval(STATE)}`);
					await sleep(50);
				}
			}
		}
	}, 120_000);
}

test.skipIf(!CHROME)("going back to the board from another page loads it again, with live updates and the command-line draft", async () => {
	await visit(1440);
	await tab.navigate(`${fixture.url}/?controller=${lead.session_id}`);
	await tab.until(`!!document.querySelector('.detail .language') && !!document.querySelector('.dock textarea') && performance.now() > 1500`, "the controller's conversation and command line");
	await tab.eval(`(() => {
		window.leftBehind = true;
		const box = document.querySelector('.dock textarea');
		box.value = 'a draft to keep';
		box.dispatchEvent(new Event('input', { bubbles: true }));
	})()`);
	// The page saves the draft once it has started: leave only once it has.
	await tab.until(`localStorage.getItem('lat-board-command-draft') === 'a draft to keep'`, 'the draft to be saved');
	await tab.navigate('about:blank');
	await tab.eval('history.back()');
	// Loaded again, not brought back as it was left: no mark of the old document, and the
	// browser says it was a reload.
	await tab.until(
		`location.pathname === '/' && window.leftBehind === undefined && performance.getEntriesByType('navigation')[0]?.type === 'reload' && !!document.querySelector('.detail .language')`,
		'the board to load again'
	);
	await tab.until(`document.querySelector('.dock textarea')?.value === 'a draft to keep'`, 'the draft');
	// Its feeds are live: a reply written now shows without a reload.
	const fresh = 'A reply written after the page came back.';
	appendFileSync(join(fixture.dir, 'transcripts', `${lead.session_id}.jsonl`), line('assistant', fresh));
	await tab.until(`document.querySelector('.detail')?.innerText.includes(${JSON.stringify(fresh)})`, 'the new reply');
}, 60_000);
