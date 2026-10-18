// The 所有 Agent tab in a real browser: headless Chrome driven over its DevTools protocol, on the
// built board with fake data, wide and at a phone's width. Skipped when the host has no Chrome.
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const SCREEN = `({ search: location.search, middle: document.querySelector('.inbox')?.innerText ?? '', detail: document.querySelector('.detail')?.innerText ?? '', notices: document.querySelector('.dock')?.innerText ?? '' })`;
const screen = () => tab.eval<{ search: string; middle: string; detail: string; notices: string }>(SCREEN);
/** Nothing on the page reaches past the window's width, so nothing scrolls sideways. */
const FITS = `document.documentElement.scrollWidth <= window.innerWidth`;

let fixture: Fixture;
let cookie: string;
const injectDir = mkdtempSync(join(tmpdir(), 'lat-board-inject-'));
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
	// The linked controller would be typed into through hcom's input command: a fake one.
	fixture = await startFixture(32, { env: { LAT_BOARD_INJECT_COMMAND: JSON.stringify([NODE, join(import.meta.dir, 'fake-inject.mjs'), injectDir]) } });
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
		// Listed, but nothing to open without a session ID.
		expect(await tab.eval(`document.querySelector('[data-pane="wB:p-s-unknown"]')?.tagName`)).toBe('DIV');
		expect(list).toContain('Herdr 還沒回報它的 session ID，暫時無法開啟');
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
	// Its conversation cannot be read: the reason shows in a notice.
	await tab.until(`document.querySelector('.dock')?.innerText.includes('對話紀錄讀不到')`, 'the notice');

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
/** Type into the agent page's box the way a person would, so the page's own binding sees it. */
const type = (text: string) =>
	tab.eval(`(() => {
		const box = document.querySelector('.detail .compose textarea');
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(text)});
		box.dispatchEvent(new Event('input', { bubbles: true }));
	})()`);
const boxText = () => tab.eval<string>(`document.querySelector('.detail .compose textarea').value`);
const click = (selector: string) => tab.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);

for (const width of [1280, 390]) {
	test.skipIf(!CHROME)(`${width}px: text is sent to an agent and an interrupt asks first; both show in its record`, async () => {
		for (const file of ['herdr-calls.jsonl', 'board-state/sent-log.jsonl']) rmSync(join(fixture.dir, file), { force: true });
		await visit(width, '?agent=s-plain');
		await tab.until(`!!document.querySelector('.detail .compose textarea')`, 'the agent page');
		await type('請先停下來');
		await click('.detail .compose button.primary');
		await tab.until(`document.querySelector('.detail .compose textarea').value === ''`, 'the box emptied');
		expect(herdrCalls()).toEqual([['agent', 'prompt', 'wA:p-s-plain', '請先停下來']]);

		await click('.detail [data-action="interrupt"]');
		await tab.until(`!!document.querySelector('.detail [data-action="confirm-interrupt"]')`, 'the confirmation');
		expect(await tab.eval(`document.querySelector('.detail .confirm').innerText`)).toContain('Esc');
		// Nothing is pressed before it is confirmed.
		expect(herdrCalls()).toHaveLength(1);
		expect(await tab.eval(FITS)).toBe(true);
		await click('.detail [data-action="confirm-interrupt"]');
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
		await tab.until(`!!document.querySelector('.detail .compose textarea')`, 'the agent page');
		await type('核准了嗎');
		await click('.detail .compose button.primary');
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
		await tab.until(`!!document.querySelector('.detail .compose textarea')`, 'the agent page');
		expect(await tab.eval(`document.querySelector('.detail .compose textarea').disabled`)).toBe(true);
		expect((await screen()).detail).toContain('HCOM 連線無法確認');
		expect(await tab.eval(`document.querySelector('.detail [data-action="interrupt"]').disabled`)).toBe(false);
		// Nor can it be closed: which of hcom and Herdr would close it is not known.
		expect(await tab.eval(`document.querySelector('.detail [data-action="close"]').disabled`)).toBe(true);
		await click('.detail [data-action="interrupt"]');
		await tab.until(`!!document.querySelector('.detail [data-action="confirm-interrupt"]')`, 'the confirmation');
		await click('.detail [data-action="confirm-interrupt"]');
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
		await tab.until(`!!document.querySelector('.detail [data-action="interrupt"]')`, 'the agent page');
		await click('.detail [data-action="interrupt"]');
		await tab.until(`!!document.querySelector('.detail [data-action="confirm-interrupt"]')`, 'the confirmation');
		await click('.detail [data-action="confirm-interrupt"]');
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
const pickSetting = (kind: 'model' | 'effort', value: string) =>
	tab.eval(`(() => { const select = document.querySelector('.detail [data-pick="${kind}"]'); select.value = ${JSON.stringify(value)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);

for (const width of [1280, 390]) {
	test.skipIf(!CHROME)(`${width}px: a switch asks first; one left unfinished stays listed, and giving it up asks first and runs nothing`, async () => {
		for (const file of ['hcom-calls.jsonl', 'hcom-added.json', 'board-state/sent-log.jsonl']) rmSync(join(fixture.dir, file), { force: true });
		// The stop goes through; the resume fails.
		setLinked({ exit: 1, stderr: 'resume refused' });
		await fixture.refresh(cookie);
		try {
			await visit(width, '?agent=s-link');
			await tab.until(`!!document.querySelector('.detail [data-pick="effort"] option[value="high"]')`, 'the switch form');
			// Nothing picked: nothing to send.
			expect(await tab.eval(`document.querySelector('.detail [data-action="switch"]').disabled`)).toBe(true);
			await pickSetting('effort', 'high');
			await click('.detail [data-action="switch"]');
			await tab.until(`!!document.querySelector('.detail [data-action="confirm-switch"]')`, 'the confirmation');
			expect(await tab.eval(`document.querySelector('.detail .model .confirm').innerText`)).toContain('思考強度 high');
			expect(await tab.eval(FITS)).toBe(true);
			expect(hcomCalls()).toEqual([]);
			await click('.detail [data-action="confirm-switch"]');
			await tab.until(`document.querySelector('.dock')?.innerText.includes('resume refused')`, 'the resume failure');
			expect(hcomCalls().map((args) => args[0])).toEqual(['kill', 'r']);

			// No longer in Herdr, still on its page and in the list, marked; only continue and give up.
			await tab.until(`!!document.querySelector('.detail [data-action="abandon"]')`, 'the unfinished switch');
			const detail = (await screen()).detail;
			expect(detail).toContain('切換未完成');
			expect(detail).toContain('已不在 Herdr 的清單上');
			expect(await tab.eval(`!!document.querySelector('.detail [data-action="close"], .detail [data-action="switch"], .detail .compose')`)).toBe(false);
			await openTab();
			await tab.until(`document.querySelector('.inbox [data-agent="s-link"]')?.innerText.includes('切換未完成')`, 'the marked row');
			await openAgent('s-link');
			await tab.until(`!!document.querySelector('.detail [data-action="abandon"]')`, 'its page again');
			// Its record shows the switch.
			await click('.detail [data-tab="log"]');
			await tab.until(`document.querySelector('.detail [data-action="model-switch"][data-state="resume-failed"]')`, 'the switch in the record');

			await click('.detail [data-action="abandon"]');
			await tab.until(`!!document.querySelector('.detail [data-action="confirm-abandon"]')`, 'the give-up confirmation');
			expect(await tab.eval(FITS)).toBe(true);
			await click('.detail [data-action="confirm-abandon"]');
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
		await tab.until(`!!document.querySelector('.detail [data-pick="model"] option[value="claude-sonnet-5-5"]')`, 'the switch form');
		await pickSetting('model', 'claude-sonnet-5-5');
		await click('.detail [data-action="switch"]');
		await click('.detail [data-action="confirm-switch"]');
		await tab.until(`!!document.querySelector('.detail [data-action="continue"]')`, 'the unfinished switch');

		// The resume goes through this time and puts it back in Herdr.
		fixture.setHcom({ agents: [{ name: 'lead', session_id: 's-lead', status: 'active' }], resumed: { name: 'lino', session_id: 's-link', status: 'listening' }, resumedHerdr: LINKED });
		await click('.detail [data-action="continue"]');
		await tab.until(`!!document.querySelector('.detail [data-action="confirm-continue"]')`, 'the continue confirmation');
		expect(hcomCalls().map((args) => args[0])).toEqual(['kill', 'r']);
		await click('.detail [data-action="confirm-continue"]');
		await tab.until(`document.querySelector('.dock')?.innerText.includes('已繼續切換 lino')`, 'the continue notice');
		expect(hcomCalls().map((args) => args[0])).toEqual(['kill', 'r', 'r']);
		expect(hcomCalls()[2]).toContain('claude-sonnet-5-5');
		await fixture.refresh(cookie);
		await tab.until(`!!document.querySelector('.detail [data-action="switch"]') && !!document.querySelector('.detail .compose')`, 'the page as usual');

		// At work: the form says to wait for the turn to end.
		fixture.setHcom({ agents: [{ name: 'lino', session_id: 's-link', status: 'active', launch_context: { pane_id: LINKED.pane_id } }] });
		await fixture.refresh(cookie);
		await tab.until(`document.querySelector('.detail .model')?.innerText.includes('這一回合做完')`, 'the busy reason');
		expect(await tab.eval(`document.querySelector('.detail [data-action="switch"]').disabled`)).toBe(true);

		// Not linked to hcom: no form, only why.
		await openTab();
		await openAgent('s-plain');
		await tab.until(`document.querySelector('.detail .model')?.innerText.includes('沒有接 HCOM')`, 'the not-linked reason');
		expect(await tab.eval(`!!document.querySelector('.detail [data-action="switch"], .detail [data-pick]')`)).toBe(false);
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
		await tab.until(`!!document.querySelector('.detail [data-pick="effort"] option[value="low"]')`, 'the switch form');
		await pickSetting('effort', 'low');
		await click('.detail [data-action="switch"]');
		await click('.detail [data-action="confirm-switch"]');
		await tab.until(`!!document.querySelector('.detail [data-action="abandon"]')`, 'the unfinished switch');
		expect((await screen()).detail).toContain('停止失敗');
		expect(await tab.eval(`!!document.querySelector('.detail [data-action="close"], .detail [data-action="interrupt"], .detail [data-action="switch"], .detail .compose')`)).toBe(false);
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
		expect((await screen()).notices).toContain('Herdr 的 Agent 清單讀不到：herdr server not running，所有 Agent 分頁沿用上次讀到的清單');
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

test.skipIf(!CHROME)('a conversation that cannot be read says why, and shows once it can be', async () => {
	try {
		await visit(1280, '?agent=s-lead');
		await tab.until(`!!document.querySelector('.detail [data-agent="s-lead"]')`, 'the agent page');
		await tab.until(`document.querySelector('.dock')?.innerText.includes('找不到 session s-lead 的對話紀錄檔')`, 'the reason');
		expect((await screen()).notices).toContain('對話紀錄讀不到：找不到 session s-lead 的對話紀錄檔');
		expect(await tab.eval(`document.querySelector('.detail #agent-panel-transcript').innerText`)).toContain('對話紀錄讀不到');

		record('s-lead', ['主控在嗎', '在。']);
		await tab.until(`document.querySelector('.detail #agent-panel-transcript')?.innerText.includes('主控在嗎')`, 'the conversation');
		expect(await tab.eval(`document.querySelector('.detail #agent-panel-transcript').innerText`)).not.toContain('對話紀錄讀不到');
	} finally {
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
		expect(detail).toContain(AGENT_HCOM_UNKNOWN_SWITCH_REASON);
		expect(await tab.eval(`document.querySelector('.detail .compose textarea').disabled`)).toBe(true);
		expect(await tab.eval(`document.querySelector('.detail [data-action="close"]').disabled`)).toBe(true);
		expect(await tab.eval(`document.querySelector('.detail [data-action="interrupt"]').disabled`)).toBe(false);

		fixture.setHcom({ agents: [{ name: 'lead', session_id: 's-lead', status: 'active' }] });
		await fixture.refresh(cookie);
		await tab.until(`document.querySelector('.detail .compose textarea')?.disabled === false`, 'the box on again');
		expect(await tab.eval(`document.querySelector('.detail [data-action="close"]').disabled`)).toBe(false);
		const after = (await screen()).detail;
		expect(after).not.toContain('HCOM 連線無法確認');
		// Now known not to be linked: the switch says that instead.
		expect(after).toContain(AGENT_NOT_LINKED_SWITCH_REASON);
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
		await tab.until(`!!document.querySelector('.detail [data-action="interrupt"]')`, 'the agent page');
		await click('.detail [data-action="interrupt"]');
		await tab.until(`!!document.querySelector('.detail [data-action="confirm-interrupt"]')`, 'the confirmation');
		await click('.detail [data-action="confirm-interrupt"]');
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
		expect(await tab.eval(`document.querySelector('.detail [data-action="interrupt"]').disabled`)).toBe(false);
		await type('還在嗎');
		await click('.detail .compose button.primary');
		await tab.until(`document.querySelector('.detail .compose textarea').value === ''`, 'the box emptied');
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
	const shown = (id: string) => `location.search === '?agent=${id}' && !!document.querySelector('.detail [data-agent="${id}"]') && !!document.querySelector('.detail .compose textarea')`;
	setHerdr(AGENTS, { slowMs: { 'agent prompt': 1_500 } });
	try {
		await visit(1280, '?agent=s-plain');
		await tab.until(shown('s-plain'), 'the agent page');
		await type('只給 plain 的話');
		await openTab();
		await openAgent('s-other');
		await tab.until(shown('s-other'), 'the other agent');
		expect(await boxText()).toBe('');
		expect(await tab.eval(`document.querySelector('.detail .compose button.primary').disabled`)).toBe(true);

		// Sent to the other one, which is left before Herdr answers.
		await type('給 other 的話');
		await click('.detail .compose button.primary');
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

test.skipIf(!CHROME)('a record that cannot be read, a request that gets no answer and a record that cannot be written are each said so', async () => {
	rmSync(join(fixture.dir, 'herdr-calls.jsonl'), { force: true });
	const sentLog = join(fixture.dir, 'board-state', 'sent-log.jsonl');
	try {
		await visit(1280, '?agent=s-plain');
		await tab.until(`!!document.querySelector('.detail .compose textarea')`, 'the agent page');
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
		await tab.until(`location.search === '?agent=s-plain' && !!document.querySelector('.detail .compose textarea')`, 'the agent page again');
		await tab.until(`document.querySelector('.dock')?.innerText.includes('分頁-s-plain 的操作紀錄讀取失敗。')`, 'the record failure');

		await type('有人在嗎');
		await click('.detail .compose button.primary');
		await tab.until(`document.querySelector('.dock')?.innerText.includes('沒有收到看板伺服器的回應')`, 'the unknown outcome');
		expect((await screen()).notices).toContain('不確定有沒有執行；再試之前請先看操作紀錄。（文字還在輸入框裡）');
		expect(await boxText()).toBe('有人在嗎');
		expect(herdrCalls()).toEqual([]);

		// Answering again, a send whose record cannot be written says so; its record reads again after.
		await tab.eval(`window.fetch = window.realFetch`);
		appendFileSync(sentLog, '');
		chmodSync(sentLog, 0o400);
		await click('.detail .compose button.primary');
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
	const formOf = (id: string) => `!!document.querySelector('.detail [data-agent="${id}"]') && !!document.querySelector('.detail [data-pick="effort"] option[value="high"]')`;
	const disabled = (kind: 'model' | 'effort') => tab.eval<boolean>(`document.querySelector('.detail [data-pick="${kind}"]').disabled`);
	const modelText = () => tab.eval<string>(`document.querySelector('.detail .model').innerText`);
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
			expect((await modelText()).includes(AGENT_FIXED_MODEL_REASON)).toBe(fixed);
			if (session === 's-unk') expect(await modelText()).toContain(`${LOCK_UNKNOWN_TEXT}：讀不到 s-unk 的啟動參數`);
			else expect(await modelText()).not.toContain(LOCK_UNKNOWN_TEXT);
			// The effort alone can still be picked and sent.
			await pickSetting('effort', 'high');
			expect(await tab.eval(`document.querySelector('.detail [data-action="switch"]').disabled`)).toBe(false);
			expect(await tab.eval(FITS)).toBe(true);
		}

		// One not linked to hcom has no form, only why.
		await openTab();
		await openAgent('s-plain');
		await tab.until(`document.querySelector('.detail [data-agent="s-plain"]') && document.querySelector('.detail .model')?.innerText.includes(${JSON.stringify(AGENT_NOT_LINKED_SWITCH_REASON)})`, 'the not-linked reason');
		expect(await tab.eval(`!!document.querySelector('.detail [data-action="switch"], .detail [data-pick]')`)).toBe(false);
		expect(hcomCalls()).toEqual([]);
	} finally {
		rmSync(join(fixture.dir, 'launch-args.json'), { force: true });
		setHerdr(AGENTS);
		fixture.setHcom({ agents: [{ name: 'lead', session_id: 's-lead', status: 'active' }] });
		await fixture.refresh(cookie);
	}
}, 60_000);
