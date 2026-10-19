// The 所有 Agent tab in a real browser: headless Chrome driven over its DevTools protocol, on the
// built board with fake data, wide and at a phone's width. Skipped when the host has no Chrome.
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { AGENT_HCOM_UNKNOWN_REASON } from '../src/lib/board/agent-actions.ts';
import { AGENT_FIXED_MODEL_REASON, AGENT_HCOM_UNKNOWN_SWITCH_REASON, AGENT_NOT_LINKED_SWITCH_REASON, LOCK_UNKNOWN_TEXT } from '../src/lib/board/models.ts';
import { NODE, PORT_BASE, sleep, startFixture, type Fixture } from './harness.ts';

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

const SCREEN = `({ search: location.search, middle: document.querySelector('.inbox')?.innerText ?? '', detail: document.querySelector('.detail')?.innerText ?? '', notices: document.querySelector('.dock .toasts')?.innerText ?? '' })`;
const screen = () => tab.eval<{ search: string; middle: string; detail: string; notices: string }>(SCREEN);
/** Nothing on the page reaches past the window's width, so nothing scrolls sideways. */
const FITS = `document.documentElement.scrollWidth <= window.innerWidth`;

let fixture: Fixture;
let cookie: string;
const injectDir = mkdtempSync(join(tmpdir(), 'lat-board-inject-'));
/** Herdr's socket, which moves a tab in the fake Herdr's tab list the way Herdr would, and logs
 *  each request with the CLI's calls; `moveFails` is the error it answers with instead. */
const socketPath = join(injectDir, 'herdr.sock');
let socket: Server;
let moveFails: string | null = null;
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
	herdrAgent('s-other', { status: 'working', workspace: 'wB' }),
	herdrAgent('s-long', { status: 'idle', workspace: 'wB' }),
	// Herdr does not know its session yet.
	{ ...herdrAgent('s-unknown', { status: 'idle', workspace: 'wB' }), agent_session: { kind: 'id', value: null } }
];
function setHerdr(agents: object[], extra: object = {}) {
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			...extra,
			agents,
			workspaces: [
				{ workspace_id: 'wA', number: 1, label: 'Alpha' },
				{ workspace_id: 'wB', number: 2, label: 'Beta' }
			],
			tabs: agents.map((agent) => {
				const { tab_id, workspace_id, agent_session } = agent as { tab_id: string; workspace_id: string; agent_session: { value: string | null } };
				return { tab_id, workspace_id, label: `分頁-${agent_session.value ?? tab_id}` };
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
	socket = createServer((connection) => {
		connection.on('data', (chunk) => {
			const request = JSON.parse(chunk.toString().trim());
			appendFileSync(join(fixture.dir, 'herdr-calls.jsonl'), JSON.stringify(['socket', request.method, request.params]) + '\n');
			if (moveFails) return connection.write(JSON.stringify({ id: request.id, error: { message: moveFails } }) + '\n');
			const planFile = join(fixture.dir, 'herdr.json');
			const plan = JSON.parse(readFileSync(planFile, 'utf8'));
			// As Herdr 0.9.5 does: before the tab at insert_index among the workspace's tabs as they are.
			const moved = plan.tabs.find((candidate: { tab_id: string }) => candidate.tab_id === request.params.tab_id);
			const before = plan.tabs.filter((candidate: { workspace_id: string }) => candidate.workspace_id === moved.workspace_id)[request.params.insert_index];
			const others = plan.tabs.filter((candidate: object) => candidate !== moved);
			const own = others.filter((candidate: { workspace_id: string }) => candidate.workspace_id === moved.workspace_id);
			const at = before === moved ? plan.tabs.indexOf(moved) : before ? others.indexOf(before) : others.indexOf(own.at(-1)) + 1;
			plan.tabs = [...others.slice(0, at), moved, ...others.slice(at)];
			writeFileSync(planFile, JSON.stringify(plan));
			connection.write(JSON.stringify({ id: request.id, result: { type: 'tab_moved' } }) + '\n');
		});
	});
	await new Promise<void>((resolve) => socket.listen(socketPath, resolve));
	// The linked controller would be typed into through hcom's input command: a fake one.
	fixture = await startFixture(32, {
		env: { LAT_BOARD_INJECT_COMMAND: JSON.stringify([NODE, join(import.meta.dir, 'fake-inject.mjs'), injectDir]), HERDR_SOCKET_PATH: socketPath }
	});
	cookie = await fixture.login();
	const lead = fixture.bound('lat', 'lead', { session_id: 's-lead' });
	fixture.list([lead]);
	fixture.setHcom({ agents: [{ name: 'lead', session_id: 's-lead', status: 'active' }] });
	setHerdr(AGENTS);
	record('s-plain', ['幫我看一下測試', '測試都過了。']);
	record('s-long', Array.from({ length: 60 }, (_, index) => `第 ${index} 段`));
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
afterAll(async () => {
	await fixture?.cleanup();
	socket?.close();
	rmSync(injectDir, { recursive: true, force: true });
});

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
/** The command line, which is the open agent's box; its send button, and the stop that stands in
 *  for it while the agent works and nothing is typed. */
const BOX = '.dock .cmd textarea';
const SEND = '.dock .cmd .send-slot button[aria-label="送出"]';
const STOP = '.dock [data-action="interrupt"]';
const CONFIRM_STOP = '.dock [data-action="confirm-interrupt"]';
const click = (selector: string) => tab.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
const openAgent = (id: string) => tab.eval(`document.querySelector('[data-agent="${id}"]').click()`);

for (const width of [1280, 390]) {
	test.skipIf(!CHROME)(`${width}px: the tab lists the agents by workspace, and an agent opens at its conversation`, async () => {
		await visit(width);
		await openTab();
		await tab.until(`!!document.querySelector('.inbox [data-agent="s-plain"]')`, 'the agent list');
		const list = (await screen()).middle;
		// By workspace, in Herdr's own order within one; a card is titled by its tab; the controller
		// is marked.
		expect(list.indexOf('Alpha')).toBeLessThan(list.indexOf('分頁-s-lead'));
		expect(list.indexOf('分頁-s-lead')).toBeLessThan(list.indexOf('分頁-s-plain'));
		expect(list.indexOf('分頁-s-plain')).toBeLessThan(list.indexOf('Beta'));
		// Its tab already says its hcom name, so the name is not added.
		expect(await tab.eval(`document.querySelector('.inbox [data-agent="s-lead"] .card-name').innerText`)).toBe('分頁-s-lead');
		expect(list).toContain('主控');
		expect(list).toContain('等待輸入');
		// Linked has its badge; not linked has none on its card.
		expect(await tab.eval(`!!document.querySelector('.inbox [data-agent="s-lead"] .hcom.linked')`)).toBe(true);
		expect(await tab.eval(`!!document.querySelector('.inbox [data-agent="s-plain"] .hcom')`)).toBe(false);
		// Listed, but nothing to open without a session ID.
		expect(await tab.eval(`document.querySelector('[data-pane="wB:p-s-unknown"]')?.tagName`)).toBe('DIV');
		expect(list).toContain('Herdr 還沒回報它的 session ID，暫時無法開啟');
		expect(await tab.eval(FITS)).toBe(true);

		await openAgent('s-plain');
		await tab.until(`document.querySelector('.detail')?.innerText.includes('測試都過了。')`, 'the conversation');
		expect((await screen()).search).toBe('?agent=s-plain');
		// Where it runs is behind 詳細資料, as on a controller's page.
		expect((await screen()).detail).not.toContain('/home/someone/projects/s-plain');
		await click('.detail .more');
		const detail = (await screen()).detail;
		expect(detail).toContain('codex');
		expect(detail).toContain('/home/someone/projects/s-plain');
		expect(detail).toContain('Alpha（工作區#1）・分頁-s-plain（分頁#2）');
		expect(detail).toContain('沒接');
		expect(detail).toContain('幫我看一下測試');
		// The command line is its box now.
		expect(await tab.eval(`document.querySelector(${JSON.stringify(BOX)}).placeholder`)).toContain('傳話給 分頁-s-plain');
		expect(await tab.eval(FITS)).toBe(true);

		if (width < 761) {
			// The phone's "←" goes back to the list, still on the tab.
			await tab.eval(`document.querySelector('.topbar button').click()`);
			await tab.until(`location.search === '?tab=agents' && !!document.querySelector('.inbox [data-agent="s-plain"]')`, 'the list again');
		}
	}, 30_000);
}

test.skipIf(!CHROME)('the conversation shows the newest first and loads earlier parts at its end', async () => {
	await visit(1280, '?agent=s-long');
	const texts = `[...document.querySelectorAll('.detail .history li')].map((li) => li.innerText)`;
	await tab.until(`${texts}.some((text) => text.includes('第 59 段'))`, 'the latest page');
	let shown = await tab.eval<string[]>(texts);
	expect(shown[0]).toContain('第 59 段');
	expect(shown.some((text) => text.includes('第 9 段'))).toBe(false);
	await tab.eval(`document.querySelector('.detail .earlier').scrollIntoView()`);
	await tab.until(`${texts}.some((text) => text.includes('第 0 段'))`, 'the earlier part');
	shown = await tab.eval<string[]>(texts);
	expect(shown.at(-1)).toContain('第 0 段');
}, 30_000);

test.skipIf(!CHROME)('a reload keeps the tab the list was switched to', async () => {
	await visit(1280);
	await openTab();
	await tab.until(`!!document.querySelector('.inbox [data-agent="s-plain"]')`, 'the agent list');
	await tab.eval('window.beforeReload = true');
	await tab.send('Page.reload');
	await tab.until(`!window.beforeReload && JSON.stringify(history.state).includes('depth')`, 'the reloaded board');
	await tab.until(`!!document.querySelector('.inbox [data-agent="s-plain"]')`, 'the agent list after the reload');
	expect(await tab.eval(`document.querySelector('[data-middle="agents"]').getAttribute('aria-pressed')`)).toBe('true');
}, 30_000);

test.skipIf(!CHROME)('an address that opens an agent shows its tab; an agent Herdr no longer lists says so', async () => {
	await visit(1280, '?agent=s-lead');
	await tab.until(`!!document.querySelector('.detail [data-agent="s-lead"]')`, 'the agent page');
	expect(await tab.eval(`document.querySelector('[data-middle="agents"]').getAttribute('aria-pressed')`)).toBe('true');
	// It has written no record yet: an empty conversation, and no notice about it.
	await tab.until(`document.querySelector('.detail #agent-panel-transcript')?.innerText.includes('還沒有對話')`, 'the empty conversation');
	expect((await screen()).notices).not.toContain('對話紀錄讀不到');

	setHerdr(AGENTS.filter((agent) => agent.agent_session.value !== 's-lead'));
	await fixture.refresh(cookie);
	await tab.until(`document.querySelector('.detail')?.innerText.includes('這個 Agent 已不在 Herdr 的清單上')`, 'the agent gone');
	expect(await tab.eval(`!!document.querySelector('.inbox [data-agent="s-lead"]')`)).toBe(false);
	setHerdr(AGENTS);
	await fixture.refresh(cookie);
}, 30_000);

/** The Herdr commands that act on an agent, not the lists every read makes nor the pane list that
 *  checks a close. */
function herdrCalls(): string[][] {
	const file = join(fixture.dir, 'herdr-calls.jsonl');
	const calls: string[][] = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
	return calls.filter((call) => call.join(' ') !== 'pane list');
}
/** Type into the command line the way a person would, so the page's own binding sees it. */
const type = (text: string) =>
	tab.eval(`(() => {
		const box = document.querySelector(${JSON.stringify(BOX)});
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(text)});
		box.dispatchEvent(new Event('input', { bubbles: true }));
	})()`);
const boxText = () => tab.eval<string>(`document.querySelector(${JSON.stringify(BOX)}).value`);

for (const width of [1280, 390]) {
	test.skipIf(!CHROME)(`${width}px: text is sent to an agent and an interrupt asks first; both show in its record`, async () => {
		for (const file of ['herdr-calls.jsonl', 'board-state/sent-log.jsonl']) rmSync(join(fixture.dir, file), { force: true });
		await visit(width, '?agent=s-plain');
		// It waits on the user and nothing is typed: the send button is a stop.
		await tab.until(`!!document.querySelector('.detail [data-agent="s-plain"]') && !!document.querySelector(${JSON.stringify(STOP)})`, 'the agent page');
		await type('請先停下來');
		await click(SEND);
		await tab.until(`document.querySelector(${JSON.stringify(BOX)}).value === ''`, 'the box emptied');
		expect(herdrCalls()).toEqual([['agent', 'prompt', 'wA:p-s-plain', '請先停下來']]);

		await click(STOP);
		await tab.until(`!!document.querySelector(${JSON.stringify(CONFIRM_STOP)})`, 'the confirmation');
		expect(await tab.eval(`document.querySelector('.dock .popup').innerText`)).toContain('Esc');
		// Nothing is pressed before it is confirmed.
		expect(herdrCalls()).toHaveLength(1);
		expect(await tab.eval(FITS)).toBe(true);
		await click(CONFIRM_STOP);
		await tab.until(`document.querySelector('.dock')?.innerText.includes('已對')`, 'the interrupt notice');
		expect(herdrCalls()).toEqual([
			['agent', 'prompt', 'wA:p-s-plain', '請先停下來'],
			['agent', 'send-keys', 'wA:p-s-plain', 'esc']
		]);

		await click('.detail [data-tab="log"]');
		// Read again after the interrupt: it is the newest entry.
		await tab.until(`document.querySelector('.detail #agent-panel-log li')?.dataset.action === 'interrupt'`, 'the record');
		expect(await tab.eval(`document.querySelectorAll('.detail #agent-panel-log li').length`)).toBe(2);
		const log = await tab.eval<string>(`document.querySelector('.detail #agent-panel-log').innerText`);
		expect(log.indexOf('中斷')).toBeLessThan(log.indexOf('請先停下來'));
		expect(log).toContain('已送出');
		expect(await tab.eval(FITS)).toBe(true);
	}, 30_000);
}

test.skipIf(!CHROME)('text Herdr refuses stays in the box with Herdr\'s reason, and is not sent again', async () => {
	rmSync(join(fixture.dir, 'herdr-calls.jsonl'), { force: true });
	const stderr = JSON.stringify({ error: { code: 'agent_blocked', message: 'agent is blocked' } });
	setHerdr(AGENTS, { fail: { 'agent prompt': { exit: 1, stderr } } });
	try {
		await visit(1280, '?agent=s-plain');
		await tab.until(`!!document.querySelector('.detail [data-agent="s-plain"]') && !!document.querySelector(${JSON.stringify(BOX)})`, 'the agent page');
		await type('核准了嗎');
		await click(SEND);
		await tab.until(`document.querySelector('.dock')?.innerText.includes('agent is blocked')`, 'the reason');
		const notices = (await screen()).notices;
		expect(notices).toContain('確認畫面');
		expect(notices).toContain('文字還在輸入框裡');
		expect(await boxText()).toBe('核准了嗎');
		await sleep(500);
		expect(herdrCalls()).toEqual([['agent', 'prompt', 'wA:p-s-plain', '核准了嗎']]);
	} finally {
		setHerdr(AGENTS);
	}
}, 30_000);

test.skipIf(!CHROME)('while hcom cannot tell whether an agent is linked, its box is off but it can still be interrupted', async () => {
	rmSync(join(fixture.dir, 'herdr-calls.jsonl'), { force: true });
	fixture.setHcom({ listFail: { exit: 1, stderr: 'hcom down' } });
	setHerdr([...AGENTS, herdrAgent('s-new', { status: 'working' })]);
	try {
		await fixture.refresh(cookie);
		await visit(390, '?agent=s-new');
		await tab.until(`!!document.querySelector('.detail [data-agent="s-new"]') && !!document.querySelector(${JSON.stringify(STOP)})`, 'the agent page');
		expect(await tab.eval(`document.querySelector(${JSON.stringify(BOX)}).disabled`)).toBe(true);
		expect((await screen()).detail).toContain('HCOM 連線無法確認');
		expect(await tab.eval(`document.querySelector(${JSON.stringify(STOP)}).disabled`)).toBe(false);
		// Nor can it be closed: which of hcom and Herdr would close it is not known.
		expect(await tab.eval(`document.querySelector('.detail [data-action="close"]').disabled`)).toBe(true);
		await click(STOP);
		await tab.until(`!!document.querySelector(${JSON.stringify(CONFIRM_STOP)})`, 'the confirmation');
		await click(CONFIRM_STOP);
		await tab.until(`document.querySelector('.dock')?.innerText.includes('已對')`, 'the interrupt notice');
		expect(herdrCalls()).toEqual([['agent', 'send-keys', 'wA:p-s-new', 'esc']]);
		expect(await tab.eval(FITS)).toBe(true);
	} finally {
		fixture.setHcom({ agents: [{ name: 'lead', session_id: 's-lead', status: 'active' }] });
		setHerdr(AGENTS);
		await fixture.refresh(cookie);
	}
}, 30_000);

test.skipIf(!CHROME)('an action from another device shows in an open record at once', async () => {
	await visit(1280, '?agent=s-plain');
	await tab.until(`!!document.querySelector('.detail [data-tab="log"]')`, 'the agent page');
	await click('.detail [data-tab="log"]');
	// Loaded: its section is there before the record is.
	await tab.until(`!!document.querySelector('.detail #agent-panel-log ol, .detail #agent-panel-log .empty')`, 'the record');
	const count = await tab.eval<number>(`document.querySelectorAll('.detail #agent-panel-log li').length`);
	// Another device interrupts it; nothing in the list of agents changes.
	const response = await fixture.fetch('/api/agents/interrupt', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ session: 's-plain' }),
		cookie
	});
	expect(response.status).toBe(200);
	await tab.until(`document.querySelectorAll('.detail #agent-panel-log li').length === ${count + 1}`, 'the new entry');
}, 30_000);

test.skipIf(!CHROME)('an interrupt\'s notice names the agent interrupted, even when another one is open by then', async () => {
	setHerdr(AGENTS, { slowMs: { 'agent send-keys': 1_500 } });
	try {
		await visit(1280, '?agent=s-plain');
		await tab.until(`!!document.querySelector('.detail [data-agent="s-plain"]') && !!document.querySelector(${JSON.stringify(STOP)})`, 'the agent page');
		await click(STOP);
		await tab.until(`!!document.querySelector(${JSON.stringify(CONFIRM_STOP)})`, 'the confirmation');
		await click(CONFIRM_STOP);
		await openTab();
		await openAgent('s-other');
		await tab.until(`location.search === '?agent=s-other'`, 'the other agent');
		await tab.until(`document.querySelector('.dock')?.innerText.includes('已對')`, 'the interrupt notice');
		const notices = (await screen()).notices;
		expect(notices).toContain('已對 分頁-s-plain 送出 Esc');
		expect(notices).not.toContain('分頁-s-other');
	} finally {
		setHerdr(AGENTS);
	}
}, 30_000);

for (const width of [1280, 390]) {
	test.skipIf(!CHROME)(`${width}px: closing an agent asks first, shows the result and the agent is not listed after a reload`, async () => {
		rmSync(join(fixture.dir, 'herdr-calls.jsonl'), { force: true });
		try {
			await visit(width, '?agent=s-plain');
			await tab.until(`!!document.querySelector('.detail [data-action="close"]')`, 'the agent page');
			await click('.detail [data-action="close"]');
			await tab.until(`!!document.querySelector('.detail [data-action="confirm-close"]')`, 'the confirmation');
			// Not linked to hcom: the board cannot bring it back.
			expect(await tab.eval(`document.querySelector('.detail .confirm').innerText`)).toContain('看板沒辦法把這段對話接回來');
			expect(await tab.eval(FITS)).toBe(true);
			expect(herdrCalls()).toEqual([]);
			await click('.detail [data-action="confirm-close"]');
			await tab.until(`document.querySelector('.dock')?.innerText.includes('已關閉 分頁-s-plain')`, 'the close notice');
			expect(herdrCalls()).toEqual([['pane', 'close', 'wA:p-s-plain']]);
			await tab.until(`document.querySelector('.detail')?.innerText.includes('已不在 Herdr 的清單上')`, 'the page saying it is gone');

			// Away from its page and reloaded: not listed, and its address no longer opens it.
			await openTab();
			await tab.until(`!!document.querySelector('.inbox [data-agent="s-other"]')`, 'the agent list');
			await tab.eval('window.beforeReload = true');
			await tab.send('Page.reload');
			await tab.until(`!window.beforeReload && !!document.querySelector('.inbox [data-agent="s-other"]')`, 'the reloaded list');
			expect(await tab.eval(`!!document.querySelector('.inbox [data-agent="s-plain"]')`)).toBe(false);
		} finally {
			setHerdr(AGENTS);
			await fixture.refresh(cookie);
		}
	}, 30_000);
}

test.skipIf(!CHROME)('a close Herdr refuses says why and leaves the agent on its page; a controller\'s confirmation says it can be woken', async () => {
	rmSync(join(fixture.dir, 'herdr-calls.jsonl'), { force: true });
	const stderr = JSON.stringify({ error: { code: 'pane_not_found', message: 'pane went away' } });
	setHerdr(AGENTS, { fail: { 'pane close': { exit: 1, stderr } } });
	try {
		await visit(390, '?agent=s-plain');
		await tab.until(`!!document.querySelector('.detail [data-action="close"]')`, 'the agent page');
		await click('.detail [data-action="close"]');
		await tab.until(`!!document.querySelector('.detail [data-action="confirm-close"]')`, 'the confirmation');
		await click('.detail [data-action="confirm-close"]');
		await tab.until(`document.querySelector('.dock')?.innerText.includes('pane went away')`, 'the reason');
		expect((await screen()).detail).toContain('分頁-s-plain');
		expect(herdrCalls()).toEqual([['pane', 'close', 'wA:p-s-plain']]);

		// The controller is linked to hcom, and its own page can wake it again; cancelling runs nothing.
		await openTab();
		await openAgent('s-lead');
		await tab.until(`!!document.querySelector('.detail [data-agent="s-lead"]')`, 'the controller\'s agent page');
		await click('.detail [data-action="close"]');
		await tab.until(`!!document.querySelector('.detail [data-action="confirm-close"]')`, 'its confirmation');
		const confirm = await tab.eval<string>(`document.querySelector('.detail .confirm').innerText`);
		expect(confirm).toContain('hcom kill @lead');
		expect(confirm).toContain('主控資訊頁喚醒接回');
		await tab.eval(`[...document.querySelectorAll('.detail .confirm button')].find((button) => button.innerText === '取消').click()`);
		await tab.until(`!!document.querySelector('.detail [data-action="close"]')`, 'the buttons again');
		expect(herdrCalls()).toHaveLength(1);
	} finally {
		setHerdr(AGENTS);
	}
}, 30_000);

/** A Claude linked to hcom and listening, with every agent's pane in Herdr, for a model switch. */
const LINKED = herdrAgent('s-link', { status: 'idle' });
function setLinked(hcom: object = {}) {
	const agents = [...AGENTS, LINKED];
	setHerdr(agents, { panes: agents.map((agent) => ({ pane_id: agent.pane_id, workspace_id: agent.workspace_id, cwd: agent.cwd })) });
	fixture.setHcom({
		agents: [
			{ name: 'lead', session_id: 's-lead', status: 'active' },
			{ name: 'lino', session_id: 's-link', status: 'listening', launch_context: { pane_id: LINKED.pane_id } }
		],
		...hcom
	});
}
const hcomCalls = (): string[][] => {
	const file = join(fixture.dir, 'hcom-calls.jsonl');
	return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line).args) : [];
};
/** The open agent's model and effort beside the send button, the button that applies what was
 *  picked, and the ⚠ of a switch left unfinished. */
const part = (kind: 'model' | 'effort') => `.dock [data-pick="${kind}"]`;
const pickable = (kind: 'model' | 'effort') => `document.querySelector(${JSON.stringify(part(kind))})?.getAttribute('aria-disabled') === 'false'`;
const partTitle = (kind: 'model' | 'effort') => tab.eval<string>(`document.querySelector(${JSON.stringify(part(kind))}).title`);
const APPLY = '.dock [data-action="apply"]';
const SWITCH_STATUS = '.dock [data-action="switch-status"]';
const pickerText = () => tab.eval<string>(`document.querySelector('.dock .picker .menu').innerText`);
async function pickSetting(kind: 'model' | 'effort', value: string) {
	await click(part(kind));
	await tab.until(`!!document.querySelector('.dock .picker [role="menuitemradio"]')`, `the ${kind} menu`);
	await tab.eval(
		`[...document.querySelectorAll('.dock .picker [role="menuitemradio"]')].find((item) => item.querySelector('small')?.innerText === ${JSON.stringify(value)}).click()`
	);
}
/** Click what the ⚠'s pop-up offers, opening it first. */
async function fromStatus(action: string) {
	if (!(await tab.eval(`!!document.querySelector('.dock [data-action="${action}"]')`))) await click(SWITCH_STATUS);
	await tab.until(`!!document.querySelector('.dock [data-action="${action}"]')`, action);
	await click(`.dock [data-action="${action}"]`);
}

for (const width of [1280, 390]) {
	test.skipIf(!CHROME)(`${width}px: a switch asks first; one left unfinished stays listed, and giving it up asks first and runs nothing`, async () => {
		for (const file of ['hcom-calls.jsonl', 'hcom-added.json', 'board-state/sent-log.jsonl']) rmSync(join(fixture.dir, file), { force: true });
		// The stop goes through; the resume fails.
		setLinked({ exit: 1, stderr: 'resume refused' });
		await fixture.refresh(cookie);
		try {
			await visit(width, '?agent=s-link');
			await tab.until(pickable('effort'), 'the switch parts');
			// Nothing picked: nothing to send.
			expect(await tab.eval(`!!document.querySelector(${JSON.stringify(APPLY)})`)).toBe(false);
			await pickSetting('effort', 'high');
			await click(APPLY);
			await tab.until(`!!document.querySelector('.dock [data-action="confirm-switch"]')`, 'the confirmation');
			expect(await pickerText()).toContain('思考強度 high');
			expect(await tab.eval(FITS)).toBe(true);
			expect(hcomCalls()).toEqual([]);
			await click('.dock [data-action="confirm-switch"]');
			await tab.until(`document.querySelector('.dock')?.innerText.includes('resume refused')`, 'the resume failure');
			expect(hcomCalls().map((args) => args[0])).toEqual(['kill', 'r']);

			// No longer in Herdr, still on its page and in the list, marked; only continue and give up.
			await tab.until(`!!document.querySelector(${JSON.stringify(SWITCH_STATUS)})`, 'the unfinished switch');
			const detail = (await screen()).detail;
			expect(detail).toContain('切換未完成');
			expect(detail).toContain('已不在 Herdr 的清單上');
			expect(await tab.eval(`!!document.querySelector('.detail [data-action="close"], ${STOP}')`)).toBe(false);
			expect(await tab.eval(`document.querySelector(${JSON.stringify(BOX)}).disabled`)).toBe(true);
			await openTab();
			await tab.until(`document.querySelector('.inbox [data-agent="s-link"]')?.innerText.includes('切換未完成')`, 'the marked row');
			await openAgent('s-link');
			await tab.until(`!!document.querySelector('.detail [data-agent="s-link"]') && !!document.querySelector(${JSON.stringify(SWITCH_STATUS)})`, 'its page again');
			// Its record shows the switch.
			await click('.detail [data-tab="log"]');
			await tab.until(`document.querySelector('.detail [data-action="model-switch"][data-state="resume-failed"]')`, 'the switch in the record');

			await fromStatus('abandon');
			await tab.until(`!!document.querySelector('.dock [data-action="confirm-abandon"]')`, 'the give-up confirmation');
			expect(await tab.eval(FITS)).toBe(true);
			await click('.dock [data-action="confirm-abandon"]');
			await tab.until(`document.querySelector('.dock')?.innerText.includes('已放棄 lino 的這次切換')`, 'the give-up notice');
			expect(hcomCalls().map((args) => args[0])).toEqual(['kill', 'r']);
			// Not in Herdr: gone from the list.
			await tab.until(`document.querySelector('.detail')?.innerText.includes('已不在 Herdr 的清單上')`, 'the page saying it is gone');
			await openTab();
			await tab.until(`!!document.querySelector('.inbox [data-agent="s-other"]')`, 'the agent list');
			expect(await tab.eval(`!!document.querySelector('.inbox [data-agent="s-link"]')`)).toBe(false);
		} finally {
			setHerdr(AGENTS);
			fixture.setHcom({ agents: [{ name: 'lead', session_id: 's-lead', status: 'active' }] });
			await fixture.refresh(cookie);
		}
	}, 30_000);
}

test.skipIf(!CHROME)('繼續切換 asks first and resumes an unfinished switch; a busy agent, or one not linked, says why it cannot switch', async () => {
	for (const file of ['hcom-calls.jsonl', 'hcom-added.json', 'board-state/sent-log.jsonl']) rmSync(join(fixture.dir, file), { force: true });
	setLinked({ exit: 1, stderr: 'resume refused' });
	await fixture.refresh(cookie);
	try {
		await visit(390, '?agent=s-link');
		await tab.until(pickable('model'), 'the switch parts');
		await pickSetting('model', 'claude-sonnet-5-5');
		await click(APPLY);
		await tab.until(`!!document.querySelector('.dock [data-action="confirm-switch"]')`, 'the confirmation');
		await click('.dock [data-action="confirm-switch"]');
		await tab.until(`!!document.querySelector(${JSON.stringify(SWITCH_STATUS)})`, 'the unfinished switch');

		// The resume goes through this time and puts it back in Herdr.
		fixture.setHcom({ agents: [{ name: 'lead', session_id: 's-lead', status: 'active' }], resumed: { name: 'lino', session_id: 's-link', status: 'listening' }, resumedHerdr: LINKED });
		await fromStatus('continue');
		await tab.until(`!!document.querySelector('.dock [data-action="confirm-continue"]')`, 'the continue confirmation');
		expect(hcomCalls().map((args) => args[0])).toEqual(['kill', 'r']);
		await click('.dock [data-action="confirm-continue"]');
		await tab.until(`document.querySelector('.dock')?.innerText.includes('已繼續切換 lino')`, 'the continue notice');
		expect(hcomCalls().map((args) => args[0])).toEqual(['kill', 'r', 'r']);
		expect(hcomCalls()[2]).toContain('claude-sonnet-5-5');
		await fixture.refresh(cookie);
		await tab.until(`${pickable('effort')} && document.querySelector(${JSON.stringify(BOX)})?.disabled === false`, 'the page as usual');

		// At work: the parts say to wait for the turn to end.
		fixture.setHcom({ agents: [{ name: 'lino', session_id: 's-link', status: 'active', launch_context: { pane_id: LINKED.pane_id } }] });
		await fixture.refresh(cookie);
		await tab.until(`document.querySelector(${JSON.stringify(part('effort'))})?.title.includes('這一回合做完')`, 'the busy reason');
		expect(await tab.eval(pickable('effort'))).toBe(false);

		// Not linked to hcom: the parts are off and say why.
		await openTab();
		await openAgent('s-plain');
		await tab.until(`!!document.querySelector('.detail [data-agent="s-plain"]') && document.querySelector(${JSON.stringify(part('model'))})?.title.includes('沒有接 HCOM')`, 'the not-linked reason');
		expect(await tab.eval(pickable('model'))).toBe(false);
		expect(await tab.eval(`!!document.querySelector(${JSON.stringify(APPLY)})`)).toBe(false);
	} finally {
		setHerdr(AGENTS);
		rmSync(join(fixture.dir, 'hcom-added.json'), { force: true });
		fixture.setHcom({ agents: [{ name: 'lead', session_id: 's-lead', status: 'active' }] });
		await fixture.refresh(cookie);
	}
}, 30_000);

test.skipIf(!CHROME)('an agent still in Herdr whose switch did not stop it offers only continuing or giving up the switch', async () => {
	for (const file of ['hcom-calls.jsonl', 'hcom-added.json', 'board-state/sent-log.jsonl']) rmSync(join(fixture.dir, file), { force: true });
	setLinked({ kill: { exit: 1, stderr: 'no such agent' } });
	await fixture.refresh(cookie);
	try {
		await visit(390, '?agent=s-link');
		await tab.until(pickable('effort'), 'the switch parts');
		await pickSetting('effort', 'low');
		await click(APPLY);
		await tab.until(`!!document.querySelector('.dock [data-action="confirm-switch"]')`, 'the confirmation');
		await click('.dock [data-action="confirm-switch"]');
		await tab.until(`!!document.querySelector(${JSON.stringify(SWITCH_STATUS)})`, 'the unfinished switch');
		await click(SWITCH_STATUS);
		await tab.until(`!!document.querySelector('.dock [data-action="abandon"]')`, 'what it offers');
		expect(await pickerText()).toContain('停止失敗');
		expect(await tab.eval(`!!document.querySelector('.detail [data-action="close"], ${STOP}')`)).toBe(false);
		expect(await tab.eval(`document.querySelector(${JSON.stringify(BOX)}).disabled`)).toBe(true);
		expect(await tab.eval(FITS)).toBe(true);
	} finally {
		setHerdr(AGENTS);
		rmSync(join(fixture.dir, 'board-state/sent-log.jsonl'), { force: true });
		fixture.setHcom({ agents: [{ name: 'lead', session_id: 's-lead', status: 'active' }] });
		await fixture.refresh(cookie);
	}
}, 30_000);

test.skipIf(!CHROME)('a Herdr list that cannot be read is reported while the last one stays listed, and the next one read replaces it', async () => {
	await visit(1280);
	await openTab();
	await tab.until(`!!document.querySelector('.inbox [data-agent="s-plain"]')`, 'the agent list');
	// Herdr would list a new agent now, but its list cannot be read.
	setHerdr([...AGENTS, herdrAgent('s-fresh', {})], { fail: { 'agent list': { exit: 1, stderr: 'herdr server not running' } } });
	try {
		await fixture.refresh(cookie);
		await tab.until(`document.querySelector('.dock')?.innerText.includes('herdr server not running')`, 'the notice');
		expect((await screen()).notices).toContain('Herdr 的 Agent 清單讀不到：herdr server not running，「Herdr」分頁沿用上次讀到的清單');
		const list = (await screen()).middle;
		expect(list).toContain('分頁-s-plain');
		expect(list).toContain('分頁-s-other');
		expect(await tab.eval(`!!document.querySelector('.inbox [data-agent="s-fresh"]')`)).toBe(false);
		// An agent kept on the list still opens at its conversation.
		await openAgent('s-plain');
		await tab.until(`document.querySelector('.detail')?.innerText.includes('測試都過了。')`, 'the conversation');

		setHerdr([...AGENTS, herdrAgent('s-fresh', {})]);
		await fixture.refresh(cookie);
		await tab.until(`!document.querySelector('.dock')?.innerText.includes('herdr server not running')`, 'the notice gone');
		await openTab();
		await tab.until(`!!document.querySelector('.inbox [data-agent="s-fresh"]')`, 'the list read again');
		expect(await tab.eval(`!!document.querySelector('.inbox [data-agent="s-plain"]')`)).toBe(true);
	} finally {
		setHerdr(AGENTS);
		await fixture.refresh(cookie);
	}
}, 30_000);

test.skipIf(!CHROME)('a conversation not written yet is empty without a notice; one that cannot be read says why, and shows once it can be', async () => {
	const transcript = `document.querySelector('.detail #agent-panel-transcript')?.innerText ?? ''`;
	const fail = join(fixture.dir, 'transcripts', 's-lead.fail');
	try {
		await visit(1280, '?agent=s-lead');
		await tab.until(`!!document.querySelector('.detail [data-agent="s-lead"]')`, 'the agent page');
		await tab.until(`(${transcript}).includes('還沒有對話')`, 'the empty conversation');
		expect((await screen()).notices).not.toContain('對話紀錄讀不到');

		// There, but unreadable: why shows, and the conversation once it can be read.
		writeFileSync(fail, '紀錄檔讀不出來');
		await tab.until(`document.querySelector('.dock')?.innerText.includes('對話紀錄讀不到：紀錄檔讀不出來')`, 'the reason');
		rmSync(fail);
		record('s-lead', ['主控在嗎', '在。']);
		await tab.until(`(${transcript}).includes('主控在嗎')`, 'the conversation');
		expect(await tab.eval(transcript)).not.toContain('對話紀錄讀不到');
	} finally {
		rmSync(fail, { force: true });
		rmSync(join(fixture.dir, 'transcripts', 's-lead.jsonl'), { force: true });
	}
}, 30_000);

test.skipIf(!CHROME)('while hcom cannot tell whether an agent is linked its page says what is off and still shows its conversation; a list read again restores it', async () => {
	rmSync(join(fixture.dir, 'herdr-calls.jsonl'), { force: true });
	fixture.setHcom({ listFail: { exit: 1, stderr: 'hcom down' } });
	setHerdr([...AGENTS, herdrAgent('s-new', { status: 'working' })]);
	record('s-new', ['新的工作', '開始了。']);
	try {
		await fixture.refresh(cookie);
		await visit(1280, '?agent=s-new');
		await tab.until(`document.querySelector('.detail #agent-panel-transcript')?.innerText.includes('開始了。')`, 'the conversation');
		const detail = (await screen()).detail;
		expect(detail).toContain(AGENT_HCOM_UNKNOWN_REASON);
		expect(await partTitle('effort')).toBe(AGENT_HCOM_UNKNOWN_SWITCH_REASON);
		expect(await tab.eval(`document.querySelector(${JSON.stringify(BOX)}).disabled`)).toBe(true);
		expect(await tab.eval(`document.querySelector('.detail [data-action="close"]').disabled`)).toBe(true);
		expect(await tab.eval(`document.querySelector(${JSON.stringify(STOP)}).disabled`)).toBe(false);

		fixture.setHcom({ agents: [{ name: 'lead', session_id: 's-lead', status: 'active' }] });
		await fixture.refresh(cookie);
		await tab.until(`document.querySelector(${JSON.stringify(BOX)})?.disabled === false`, 'the box on again');
		expect(await tab.eval(`document.querySelector('.detail [data-action="close"]').disabled`)).toBe(false);
		expect((await screen()).detail).not.toContain('HCOM 連線無法確認');
		// Now known not to be linked: the switch says that instead.
		expect(await partTitle('effort')).toBe(AGENT_NOT_LINKED_SWITCH_REASON);
		expect(herdrCalls()).toEqual([]);
	} finally {
		fixture.setHcom({ agents: [{ name: 'lead', session_id: 's-lead', status: 'active' }] });
		setHerdr(AGENTS);
		await fixture.refresh(cookie);
	}
}, 30_000);

test.skipIf(!CHROME)('an interrupt Herdr does not carry out says why, is recorded as failed, and the page stays usable', async () => {
	rmSync(join(fixture.dir, 'herdr-calls.jsonl'), { force: true });
	const stderr = JSON.stringify({ error: { code: 'pane_not_found', message: 'pane went away' } });
	setHerdr(AGENTS, { fail: { 'agent send-keys': { exit: 1, stderr } } });
	try {
		await visit(390, '?agent=s-plain');
		await tab.until(`!!document.querySelector('.detail [data-agent="s-plain"]') && !!document.querySelector(${JSON.stringify(STOP)})`, 'the agent page');
		await click(STOP);
		await tab.until(`!!document.querySelector(${JSON.stringify(CONFIRM_STOP)})`, 'the confirmation');
		await click(CONFIRM_STOP);
		await tab.until(`document.querySelector('.dock')?.innerText.includes('pane went away')`, 'the reason');
		const notices = (await screen()).notices;
		expect(notices).toContain('Herdr 沒有送出 Esc：pane went away');
		expect(notices).not.toContain('已對');

		await click('.detail [data-tab="log"]');
		await tab.until(`!!document.querySelector('.detail #agent-panel-log li[data-action="interrupt"]')`, 'the record');
		const entry = await tab.eval<string>(`document.querySelector('.detail #agent-panel-log li[data-action="interrupt"]').innerText`);
		expect(entry).toContain('✗ Herdr 沒有送出 Esc：pane went away');
		expect(entry).not.toContain('已送出 Esc');

		// Still on its page, and it can be interrupted again or sent text.
		expect((await screen()).detail).toContain('分頁-s-plain');
		expect(await tab.eval(`document.querySelector(${JSON.stringify(STOP)}).disabled`)).toBe(false);
		await type('還在嗎');
		await click(SEND);
		await tab.until(`document.querySelector(${JSON.stringify(BOX)}).value === ''`, 'the box emptied');
		expect(herdrCalls()).toEqual([
			['agent', 'send-keys', 'wA:p-s-plain', 'esc'],
			['agent', 'prompt', 'wA:p-s-plain', '還在嗎']
		]);
		expect(await tab.eval(FITS)).toBe(true);
	} finally {
		setHerdr(AGENTS);
	}
}, 30_000);

test.skipIf(!CHROME)('text typed for one agent stays with it: another agent opened meanwhile neither shows nor gets it', async () => {
	rmSync(join(fixture.dir, 'herdr-calls.jsonl'), { force: true });
	const shown = (id: string) => `location.search === '?agent=${id}' && !!document.querySelector('.detail [data-agent="${id}"]') && !!document.querySelector(${JSON.stringify(BOX)})`;
	setHerdr(AGENTS, { slowMs: { 'agent prompt': 1_500 } });
	try {
		await visit(1280, '?agent=s-plain');
		await tab.until(shown('s-plain'), 'the agent page');
		await type('只給 plain 的話');
		await openTab();
		await openAgent('s-other');
		await tab.until(shown('s-other'), 'the other agent');
		expect(await boxText()).toBe('');
		// Nothing to send for it: it works, so the button is its stop.
		expect(await tab.eval(`!!document.querySelector(${JSON.stringify(STOP)})`)).toBe(true);

		// Sent to the other one, which is left before Herdr answers.
		await type('給 other 的話');
		await click(SEND);
		await openTab();
		await openAgent('s-plain');
		await tab.until(shown('s-plain'), 'the first agent again');
		expect(await boxText()).toBe('只給 plain 的話');
		// Herdr answers the send meanwhile.
		await sleep(2_000);
		expect(herdrCalls()).toEqual([['agent', 'prompt', 'wB:p-s-other', '給 other 的話']]);
		expect(await boxText()).toBe('只給 plain 的話');

		await openTab();
		await openAgent('s-other');
		await tab.until(shown('s-other'), 'the other agent again');
		expect(await boxText()).toBe('');
	} finally {
		setHerdr(AGENTS);
	}
}, 30_000);

test.skipIf(!CHROME)('on an agent\'s page a line starting with @name still goes to that controller, apart from the agent\'s own draft', async () => {
	rmSync(join(fixture.dir, 'herdr-calls.jsonl'), { force: true });
	rmSync(join(injectDir, 'inject-calls.jsonl'), { force: true });
	await visit(1280, '?agent=s-plain');
	await tab.until(`!!document.querySelector('.detail [data-agent="s-plain"]') && !!document.querySelector(${JSON.stringify(BOX)})`, 'the agent page');
	expect(await tab.eval(`document.querySelector('.dock .to').innerText`)).toBe('→ 分頁-s-plain');
	await type('@lead 給主控的話');
	// Named: the controller is the recipient, with its own model and effort beside the button.
	await tab.until(`document.querySelector('.dock .to').innerText === '→ @lead'`, 'the controller as recipient');
	expect(await tab.eval(`!!document.querySelector('.dock [data-action="apply"], .dock [data-pick]')`)).toBe(false);
	await click(SEND);
	await tab.until(`document.querySelector(${JSON.stringify(BOX)}).value === ''`, 'the box emptied');
	const injected = readFileSync(join(injectDir, 'inject-calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
	expect(injected[0][0]).toBe('lead');
	expect(injected.flat().some((arg: string) => arg.includes('給主控的話'))).toBe(true);
	// Nothing reached the agent.
	expect(herdrCalls()).toEqual([]);
}, 30_000);

test.skipIf(!CHROME)('a card is titled by its tab, then the short hcom name, which goes when the tab name alone does not fit', async () => {
	const wide = { ...herdrAgent('s-wide', { status: 'idle' }) };
	const write = (label: string) =>
		writeFileSync(
			join(fixture.dir, 'herdr.json'),
			JSON.stringify({
				agents: [...AGENTS, wide],
				workspaces: [
					{ workspace_id: 'wA', number: 1, label: 'Alpha' },
					{ workspace_id: 'wB', number: 2, label: 'Beta' }
				],
				tabs: [...AGENTS, wide].map((agent) => ({
					tab_id: agent.tab_id,
					workspace_id: agent.workspace_id,
					label: agent === wide ? label : `分頁-${agent.agent_session.value ?? agent.tab_id}`
				}))
			})
		);
	fixture.setHcom({
		agents: [
			{ name: 'lead', session_id: 's-lead', status: 'active' },
			{ name: 'lat-team-wido', session_id: 's-wide', status: 'listening' }
		]
	});
	const card = `document.querySelector('.inbox [data-agent="s-wide"] .card-name')?.textContent`;
	try {
		write('寬');
		await fixture.refresh(cookie);
		await visit(390);
		await openTab();
		await tab.until(`${card} === '寬·wido'`, 'the tab, then the short hcom name');
		write('一個很長很長很長很長很長很長很長很長很長很長很長很長很長很長的分頁名稱');
		await fixture.refresh(cookie);
		await tab.until(`${card}?.startsWith('一個很長') && !${card}.includes('wido')`, 'the tab name alone');
		expect(await tab.eval(FITS)).toBe(true);
		// Its page names it by the short name, its tab after it.
		await openAgent('s-wide');
		await tab.until(`!!document.querySelector('.detail [data-agent="s-wide"]')`, 'its page');
		expect(await tab.eval(`document.querySelector('.detail h2').innerText`)).toBe('wido');
		expect(await tab.eval(`document.querySelector('.dock .to').innerText`)).toBe('→ @wido');
	} finally {
		fixture.setHcom({ agents: [{ name: 'lead', session_id: 's-lead', status: 'active' }] });
		setHerdr(AGENTS);
		await fixture.refresh(cookie);
	}
}, 30_000);

test.skipIf(!CHROME)('the list tabs stay on one line, and the address names the tab shown', async () => {
	await visit(390);
	await openTab();
	await tab.until(`location.search === '?tab=agents'`, 'the tab in the address');
	const tops = await tab.eval<number[]>(`[...document.querySelectorAll('.middle-tabs button')].map((button) => button.offsetTop)`);
	expect(new Set(tops).size).toBe(1);
	await tab.eval(`document.querySelector('[data-middle="inbox"]').click()`);
	await tab.until(`location.search === ''`, 'the inbox, which the address leaves unsaid');
}, 30_000);

test.skipIf(!CHROME)('a record that cannot be read, a request that gets no answer and a record that cannot be written are each said so', async () => {
	rmSync(join(fixture.dir, 'herdr-calls.jsonl'), { force: true });
	const sentLog = join(fixture.dir, 'board-state', 'sent-log.jsonl');
	try {
		await visit(1280, '?agent=s-plain');
		await tab.until(`!!document.querySelector('.detail [data-agent="s-plain"]') && !!document.querySelector(${JSON.stringify(BOX)})`, 'the agent page');
		// The board server stops answering this page, as when the network drops.
		await tab.eval(`(() => {
			window.realFetch = window.fetch;
			window.fetch = (input, init) => (String(input).includes('/api/agents/') ? Promise.reject(new TypeError('Failed to fetch')) : window.realFetch(input, init));
		})()`);
		// Its record is read again when it is opened again.
		await openTab();
		await openAgent('s-other');
		await tab.until(`location.search === '?agent=s-other'`, 'the other agent');
		await openAgent('s-plain');
		await tab.until(`location.search === '?agent=s-plain' && !!document.querySelector('.detail [data-agent="s-plain"]')`, 'the agent page again');
		await tab.until(`document.querySelector('.dock')?.innerText.includes('分頁-s-plain 的操作紀錄讀取失敗。')`, 'the record failure');

		await type('有人在嗎');
		await click(SEND);
		await tab.until(`document.querySelector('.dock')?.innerText.includes('沒有收到看板伺服器的回應')`, 'the unknown outcome');
		expect((await screen()).notices).toContain('不確定有沒有執行；再試之前請先看操作紀錄。（文字還在輸入框裡）');
		expect(await boxText()).toBe('有人在嗎');
		expect(herdrCalls()).toEqual([]);

		// Answering again, a send whose record cannot be written says so; its record reads again after.
		await tab.eval(`window.fetch = window.realFetch`);
		appendFileSync(sentLog, '');
		chmodSync(sentLog, 0o400);
		await click(SEND);
		await tab.until(`document.querySelector('.dock')?.innerText.includes('送出紀錄寫入失敗')`, 'the write failure');
		expect(await boxText()).toBe('');
		expect(herdrCalls()).toEqual([['agent', 'prompt', 'wA:p-s-plain', '有人在嗎']]);
		await tab.until(`!document.querySelector('.dock')?.innerText.includes('操作紀錄讀取失敗')`, 'the record read again');
	} finally {
		chmodSync(sentLog, 0o600);
	}
}, 30_000);

test.skipIf(!CHROME)('a Codex started with a fixed model offers only its effort and says why; one started with -c model= is not locked, and unread launch arguments say so', async () => {
	const launches: Record<string, unknown> = {
		's-fix': ['--model', 'gpt-6.1-sol'],
		's-fixm': ['-m', 'gpt-6.1-sol'],
		's-oss': ['--oss'],
		's-cfg': ['-c', 'model="gpt-6.1-sol"'],
		's-unk': { unknown: '讀不到 s-unk 的啟動參數' }
	};
	const sessions = Object.keys(launches);
	rmSync(join(fixture.dir, 'hcom-calls.jsonl'), { force: true });
	writeFileSync(join(fixture.dir, 'launch-args.json'), JSON.stringify(launches));
	setHerdr([...AGENTS, ...sessions.map((session) => herdrAgent(session, { client: 'codex' }))]);
	fixture.setHcom({
		agents: [
			{ name: 'lead', session_id: 's-lead', status: 'active' },
			...sessions.map((session) => ({ name: `x${session}`, session_id: session, status: 'listening', launch_context: { pane_id: `wA:p-${session}` } }))
		]
	});
	const formOf = (id: string) => `!!document.querySelector('.detail [data-agent="${id}"]') && ${pickable('effort')}`;
	const disabled = async (kind: 'model' | 'effort') => !(await tab.eval<boolean>(pickable(kind)));
	try {
		await fixture.refresh(cookie);
		await visit(390, '?agent=s-fix');
		for (const session of sessions) {
			if (session !== 's-fix') {
				await openTab();
				await openAgent(session);
			}
			await tab.until(formOf(session), `${session}'s switch form`);
			const fixed = ['s-fix', 's-fixm', 's-oss'].includes(session);
			expect(await disabled('model')).toBe(fixed);
			expect(await disabled('effort')).toBe(false);
			expect((await partTitle('model')) === AGENT_FIXED_MODEL_REASON).toBe(fixed);
			if (!fixed) {
				// Its model menu says when the launch arguments could not be read.
				await click(part('model'));
				await tab.until(`!!document.querySelector('.dock .picker [role="menuitemradio"]')`, 'the model menu');
				if (session === 's-unk') expect(await pickerText()).toContain(`${LOCK_UNKNOWN_TEXT}：讀不到 s-unk 的啟動參數`);
				else expect(await pickerText()).not.toContain(LOCK_UNKNOWN_TEXT);
				await click(part('model'));
			}
			// The effort alone can still be picked and sent.
			await pickSetting('effort', 'high');
			expect(await tab.eval(`document.querySelector(${JSON.stringify(APPLY)})?.getAttribute('aria-disabled')`)).toBe('false');
			expect(await tab.eval(FITS)).toBe(true);
		}

		// One not linked to hcom has no form, only why.
		await openTab();
		await openAgent('s-plain');
		await tab.until(`!!document.querySelector('.detail [data-agent="s-plain"]') && document.querySelector(${JSON.stringify(part('model'))})?.title === ${JSON.stringify(AGENT_NOT_LINKED_SWITCH_REASON)}`, 'the not-linked reason');
		expect(await tab.eval(pickable('model'))).toBe(false);
		expect(await tab.eval(`!!document.querySelector(${JSON.stringify(APPLY)})`)).toBe(false);
		expect(hcomCalls()).toEqual([]);
	} finally {
		rmSync(join(fixture.dir, 'launch-args.json'), { force: true });
		setHerdr(AGENTS);
		fixture.setHcom({ agents: [{ name: 'lead', session_id: 's-lead', status: 'active' }] });
		await fixture.refresh(cookie);
	}
}, 60_000);

/** A card in the list, and its drag handle. */
const CARD = (id: string) => `.inbox [data-card="${id}"]`;
const GRIP = (id: string) => `${CARD(id)} .grip`;
const RENAME = '.inbox input.rename';
/** The middle of an element on the screen, or this far from its left edge. */
const point = (selector: string, fromLeft?: number) =>
	tab.eval<{ x: number; y: number }>(
		`(() => { const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: ${fromLeft === undefined ? 'box.left + box.width / 2' : `box.left + ${fromLeft}`}, y: box.top + box.height / 2 }; })()`
	);
/** The cards of a workspace, in the order the list shows them. */
const cardsOf = (workspace: string) =>
	tab.eval<string[]>(`[...document.querySelectorAll('.inbox [data-workspace="${workspace}"] [data-card]')].map((card) => card.dataset.card)`);
const hasClass = (selector: string, name: string) => tab.eval<boolean>(`!!document.querySelector(${JSON.stringify(selector)})?.classList.contains('${name}')`);

/** Press at `from`, move to `to` in steps, run `meanwhile` while still pressed, then let go: with
 *  the mouse at a wide window, with a finger at a phone's width. */
async function drag(touch: boolean, from: { x: number; y: number }, to: { x: number; y: number }, meanwhile: () => Promise<void> = async () => {}) {
	const at = (step: number) => ({ x: from.x + ((to.x - from.x) * step) / 6, y: from.y + ((to.y - from.y) * step) / 6 });
	if (touch) {
		await tab.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
		for (let step = 1; step <= 6; step++) await tab.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [at(step)] });
		await meanwhile();
		await tab.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	} else {
		await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', buttons: 1, clickCount: 1 });
		for (let step = 1; step <= 6; step++) await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at(step), button: 'left', buttons: 1 });
		await meanwhile();
		await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...to, button: 'left', buttons: 0, clickCount: 1 });
	}
}
const key = async (name: 'Enter' | 'Escape') => {
	const code = { Enter: 13, Escape: 27 }[name];
	for (const type of ['keyDown', 'keyUp']) await tab.send('Input.dispatchKeyEvent', { type, key: name, code: name, windowsVirtualKeyCode: code });
};
/** Open a card's menu: a right click with the mouse, a long press with a finger. */
async function openMenu(touch: boolean, id: string) {
	const at = await point(CARD(id), 40);
	if (touch) {
		await tab.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
		await sleep(700);
		await tab.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	} else {
		await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'right', buttons: 2, clickCount: 1 });
		await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'right', buttons: 0, clickCount: 1 });
	}
	await tab.until(`!!document.querySelector('.menu')`, 'the card menu');
}
async function freshTabs() {
	for (const file of ['herdr-calls.jsonl', 'board-state/sent-log.jsonl']) rmSync(join(fixture.dir, file), { force: true });
	moveFails = null;
	setHerdr(AGENTS);
	await fixture.refresh(cookie);
}

for (const width of [1280, 390]) {
	const touch = width < 761;
	test.skipIf(!CHROME)(`${width}px: a card's handle drags its tab within its workspace, showing where it lands; outside it nothing moves`, async () => {
		await freshTabs();
		await visit(width);
		if (touch) await tab.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
		await openTab();
		await tab.until(`!!document.querySelector(${JSON.stringify(GRIP('s-plain'))})`, 'the handles');
		expect(await cardsOf('wA')).toEqual(['s-lead', 's-plain']);
		// The handle is the card's last thing on the right, and it lets touch drag instead of scroll.
		expect(await tab.eval(`getComputedStyle(document.querySelector(${JSON.stringify(GRIP('s-plain'))})).touchAction`)).toBe('none');

		await drag(touch, await point(GRIP('s-plain')), await point(CARD('s-lead')), async () => {
			expect(await hasClass(CARD('s-plain'), 'dragging')).toBe(true);
			expect(await hasClass(CARD('s-lead'), 'drop-before')).toBe(true);
		});
		await tab.until(`JSON.stringify([...document.querySelectorAll('.inbox [data-workspace="wA"] [data-card]')].map((card) => card.dataset.card)) === '["s-plain","s-lead"]'`, 'Herdr’s new order');
		expect(herdrCalls()).toEqual([['socket', 'tab.move', { tab_id: 'wA:t-s-plain', insert_index: 0 }]]);
		// Dragging by the handle does not open the agent.
		expect((await screen()).search).not.toContain('agent=');

		// Into another workspace: marked as no place to drop, and put back without asking Herdr.
		await drag(touch, await point(GRIP('s-lead')), await point(CARD('s-other')), async () => {
			expect(await hasClass(CARD('s-lead'), 'refused')).toBe(true);
			expect(await tab.eval(`document.querySelector('.refuse-tip')?.innerText`)).toBe('不能拖到別的工作區');
		});
		await tab.until(`document.querySelector('.dock .toasts')?.innerText.includes('不能拖到別的工作區')`, 'the notice');
		expect(await tab.eval(`document.querySelector(${JSON.stringify(CARD('s-lead'))}).style.transform`)).toBe('');
		expect(await tab.eval(`!!document.querySelector('.refuse-tip')`)).toBe(false);
		expect(herdrCalls()).toHaveLength(1);

		// Herdr refuses: its reason shows, and the list keeps Herdr's real order.
		moveFails = 'tab is busy';
		await drag(touch, await point(GRIP('s-lead')), await point(CARD('s-plain')));
		await tab.until(`document.querySelector('.dock .toasts')?.innerText.includes('排序失敗：移動分頁失敗：tab is busy')`, 'the failure');
		expect(await cardsOf('wA')).toEqual(['s-plain', 's-lead']);
		expect(herdrCalls()).toHaveLength(2);
		expect(await tab.eval(FITS)).toBe(true);
	}, 30_000);

	test.skipIf(!CHROME)(`${width}px: ${touch ? 'a long press' : 'a right click'} opens the card's menu, and its one item renames the tab on the card`, async () => {
		await freshTabs();
		await visit(width);
		if (touch) await tab.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
		await openTab();
		await tab.until(`!!document.querySelector(${JSON.stringify(CARD('s-plain'))})`, 'the list');
		await openMenu(touch, 's-plain');
		expect(await tab.eval(`[...document.querySelectorAll('.menu button')].map((item) => item.innerText)`)).toEqual(['改分頁名稱']);
		// The press that opened it does not open the agent.
		expect((await screen()).search).not.toContain('agent=');
		expect(await tab.eval(FITS)).toBe(true);

		await click('.menu button');
		await tab.until(`document.activeElement?.matches(${JSON.stringify(RENAME)})`, 'the name box');
		expect(await tab.eval(`document.querySelector(${JSON.stringify(RENAME)}).value`)).toBe('分頁-s-plain');
		expect(await tab.eval(`!!document.querySelector('.menu')`)).toBe(false);
		// A blank name is not sent; Esc leaves the name as it was.
		await tab.eval(`document.querySelector(${JSON.stringify(RENAME)}).value = '   '`);
		await key('Enter');
		await tab.until(`document.querySelector('.dock .toasts')?.innerText.includes('分頁名稱不能空白')`, 'the blank notice');
		expect(await tab.eval(`!!document.querySelector(${JSON.stringify(RENAME)})`)).toBe(true);
		await key('Escape');
		await tab.until(`!document.querySelector(${JSON.stringify(RENAME)})`, 'the box gone');
		expect(await tab.eval(`document.querySelector('${CARD('s-plain')} .card-name').innerText`)).toBe('分頁-s-plain');
		// Leaving the box cancels too.
		await openMenu(touch, 's-plain');
		await click('.menu button');
		await tab.until(`document.activeElement?.matches(${JSON.stringify(RENAME)})`, 'the name box again');
		await tab.eval(`document.querySelector(${JSON.stringify(RENAME)}).blur()`);
		await tab.until(`!document.querySelector(${JSON.stringify(RENAME)})`, 'the box gone after blur');
		expect(herdrCalls()).toEqual([]);

		await openMenu(touch, 's-plain');
		await click('.menu button');
		await tab.until(`document.activeElement?.matches(${JSON.stringify(RENAME)})`, 'the name box once more');
		await tab.eval(`document.querySelector(${JSON.stringify(RENAME)}).value = ' 審查 '`);
		await key('Enter');
		await tab.until(`document.querySelector('${CARD('s-plain')} .card-name')?.innerText === '審查'`, 'the new name');
		expect(herdrCalls()).toEqual([['tab', 'rename', 'wA:t-s-plain', '審查']]);

		// Herdr refuses: its reason shows, and the name stays.
		setHerdr(AGENTS, { fail: { 'tab rename': { exit: 1, stderr: JSON.stringify({ error: { code: 'x', message: 'label refused' } }) } } });
		await fixture.refresh(cookie);
		await tab.until(`document.querySelector('${CARD('s-plain')} .card-name')?.innerText === '分頁-s-plain'`, 'the name Herdr has');
		await openMenu(touch, 's-plain');
		await click('.menu button');
		await tab.until(`document.activeElement?.matches(${JSON.stringify(RENAME)})`, 'the name box for the failure');
		await tab.eval(`document.querySelector(${JSON.stringify(RENAME)}).value = '不行'`);
		await key('Enter');
		await tab.until(`document.querySelector('.dock .toasts')?.innerText.includes('改名失敗：Herdr 沒有改名：label refused')`, 'the failure');
		expect(await tab.eval(`document.querySelector('${CARD('s-plain')} .card-name').innerText`)).toBe('分頁-s-plain');

		// Both are in the agent's record.
		await openAgent('s-plain');
		await click('.detail [data-tab="log"]');
		await tab.until(`document.querySelectorAll('.detail #agent-panel-log li[data-action="rename"]').length === 2`, 'the record');
		const log = await tab.eval<string>(`document.querySelector('.detail #agent-panel-log').innerText`);
		expect(log).toContain('「分頁-s-plain」改為「審查」');
		expect(log).toContain('label refused');
	}, 30_000);
}
