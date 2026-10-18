// The 所有 Agent tab in a real browser: headless Chrome driven over its DevTools protocol, on the
// built board with fake data, wide and at a phone's width. Skipped when the host has no Chrome.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { PORT_BASE, sleep, startFixture, type Fixture } from './harness.ts';

const CHROME = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(
	(path) => path && existsSync(path)
);
const DEBUG_PORT = PORT_BASE + 33;

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
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; the page shows ${JSON.stringify(await this.eval(SCREEN))}`);
			await sleep(50);
		}
	}
	close() {
		this.#socket.close();
	}
}

const SCREEN = `({ search: location.search, middle: document.querySelector('.inbox')?.innerText ?? '', detail: document.querySelector('.detail')?.innerText ?? '', notices: document.querySelector('.dock')?.innerText ?? '' })`;
const screen = () => tab.eval<{ search: string; middle: string; detail: string; notices: string }>(SCREEN);
/** Nothing on the page reaches past the window's width, so nothing scrolls sideways. */
const FITS = `document.documentElement.scrollWidth <= window.innerWidth`;

let fixture: Fixture;
let cookie: string;
let chrome: ChildProcess | undefined;
let profile: string;
let tab: Tab;

function herdrAgent(session: string, fields: { client?: string; status?: string; workspace?: string; cwd?: string }) {
	const workspace = fields.workspace ?? 'wA';
	return {
		agent: fields.client ?? 'claude',
		agent_session: { kind: 'id', value: session },
		agent_status: fields.status ?? 'idle',
		cwd: fields.cwd ?? `/home/someone/projects/${session}`,
		pane_id: `${workspace}:p-${session}`,
		tab_id: `${workspace}:t-${session}`,
		workspace_id: workspace
	};
}
const AGENTS = [
	herdrAgent('s-lead', { status: 'done', cwd: '/home/someone/projects/a-very-long-project-folder-name-that-must-not-push-the-page-sideways' }),
	herdrAgent('s-plain', { status: 'blocked', client: 'codex' }),
	herdrAgent('s-other', { status: 'working', workspace: 'wB' })
];
function setHerdr(agents: object[]) {
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents,
			workspaces: [
				{ workspace_id: 'wA', number: 1, label: 'Alpha' },
				{ workspace_id: 'wB', number: 2, label: 'Beta' }
			],
			tabs: agents.map((agent) => {
				const { tab_id, workspace_id, agent_session } = agent as { tab_id: string; workspace_id: string; agent_session: { value: string } };
				return { tab_id, workspace_id, label: `分頁-${agent_session.value}` };
			})
		})
	);
}
function record(session: string, texts: string[]) {
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	const lines = texts.map((text, index) => ({ kind: index % 2 ? 'assistant' : 'user', time: '2026-10-19T09:00:00.000Z', text }));
	writeFileSync(join(fixture.dir, 'transcripts', `${session}.jsonl`), lines.map((line) => JSON.stringify(line) + '\n').join(''));
}

beforeAll(async () => {
	fixture = await startFixture(32);
	cookie = await fixture.login();
	const lead = fixture.bound('lat', 'lead', { session_id: 's-lead' });
	fixture.list([lead]);
	fixture.setHcom({ agents: [{ name: 'lead', session_id: 's-lead', status: 'active' }] });
	setHerdr(AGENTS);
	record('s-plain', ['幫我看一下測試', '測試都過了。']);
	await fixture.refresh(cookie);
}, 30_000);
afterEach(async () => {
	if (!chrome || chrome.exitCode !== null) return;
	tab.close();
	const exited = new Promise((resolve) => chrome!.once('exit', resolve));
	chrome.kill('SIGKILL');
	await exited;
	rmSync(profile, { recursive: true, force: true });
});
afterAll(() => fixture?.cleanup());

/** A new Chrome on the board at `search` in a window `width` wide. */
async function visit(width: number, search = '') {
	profile = mkdtempSync(join(tmpdir(), 'lat-board-test-chrome-'));
	chrome = spawn(
		CHROME!,
		['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-extensions', `--user-data-dir=${profile}`, `--remote-debugging-port=${DEBUG_PORT}`, 'about:blank'],
		{ stdio: 'ignore' }
	);
	tab = await Tab.open();
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width < 761 });
	await tab.send('Page.navigate', { url: `${fixture.url}/${search}` });
	// Started: the board's first history write is done, so its buttons work.
	await tab.until(`JSON.stringify(history.state).includes('depth')`, 'the board to start');
}
const openTab = () => tab.eval(`document.querySelector('[data-middle="agents"]').click()`);
const openAgent = (id: string) => tab.eval(`document.querySelector('[data-agent="${id}"]').click()`);

for (const width of [1280, 390]) {
	test.skipIf(!CHROME)(`${width}px: the tab lists the agents by workspace, and an agent opens at its conversation`, async () => {
		await visit(width);
		await openTab();
		await tab.until(`!!document.querySelector('.inbox [data-agent="s-plain"]')`, 'the agent list');
		const list = (await screen()).middle;
		// By workspace, who needs the user first within one; the controller is marked.
		expect(list.indexOf('Alpha')).toBeLessThan(list.indexOf('分頁-s-plain'));
		expect(list.indexOf('分頁-s-plain')).toBeLessThan(list.indexOf('lead'));
		expect(list.indexOf('lead')).toBeLessThan(list.indexOf('Beta'));
		expect(list).toContain('主控');
		expect(list).toContain('等待輸入');
		expect(list).toContain('沒接 HCOM');
		expect(await tab.eval(FITS)).toBe(true);

		await openAgent('s-plain');
		await tab.until(`document.querySelector('.detail')?.innerText.includes('測試都過了。')`, 'the conversation');
		const { search, detail } = await screen();
		expect(search).toBe('?agent=s-plain');
		expect(detail).toContain('codex');
		expect(detail).toContain('/home/someone/projects/s-plain');
		expect(detail).toContain('Alpha（工作區#1）');
		expect(detail).toContain('幫我看一下測試');
		expect(await tab.eval(FITS)).toBe(true);

		if (width < 761) {
			// The phone's "←" goes back to the list, still on the tab.
			await tab.eval(`document.querySelector('.topbar button').click()`);
			await tab.until(`location.search === '' && !!document.querySelector('.inbox [data-agent="s-plain"]')`, 'the list again');
		}
	}, 30_000);
}

test.skipIf(!CHROME)('a reload keeps the open agent and its tab; an agent Herdr no longer lists says so', async () => {
	await visit(1280, '?agent=s-lead');
	await tab.until(`!!document.querySelector('.detail [data-agent="s-lead"]')`, 'the agent page');
	expect(await tab.eval(`document.querySelector('[data-middle="agents"]').getAttribute('aria-selected')`)).toBe('true');
	// Its conversation cannot be read: the reason shows in a notice.
	await tab.until(`document.querySelector('.dock')?.innerText.includes('對話紀錄讀不到')`, 'the notice');

	setHerdr(AGENTS.filter((agent) => agent.agent_session.value !== 's-lead'));
	await fixture.refresh(cookie);
	await tab.until(`document.querySelector('.detail')?.innerText.includes('這個 Agent 已不在 Herdr 的清單上')`, 'the agent gone');
	expect(await tab.eval(`!!document.querySelector('.inbox [data-agent="s-lead"]')`)).toBe(false);
	setHerdr(AGENTS);
	await fixture.refresh(cookie);
}, 30_000);
