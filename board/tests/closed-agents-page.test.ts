// The Herdr tab's 已關閉 section in a real browser: headless Chrome driven over its DevTools
// protocol, on the built board with fake hcom, Herdr and helper, wide and at a phone's width. The
// board runs in Taipei time, so its calendar days are not the test host's. Skipped when the host
// has no Chrome.
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { DAY, PORT_BASE, sleep, startFixture, until, type Fixture } from './harness.ts';

const CHROME = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(
	(path) => path && existsSync(path)
);
const DEBUG_PORT = PORT_BASE + 62;
const TIME_ZONE = 'Asia/Taipei';

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
const socketDir = mkdtempSync(join(tmpdir(), 'lat-board-closed-page-'));
const socketPath = join(socketDir, 'herdr.sock');
let socket: Server;
let chrome: ChildProcess | undefined;
let profile: string;
let tab: Tab;

const WORKSPACES = [
	{ workspace_id: 'wA', number: 1, label: 'Alpha' },
	{ workspace_id: 'wB', number: 2, label: 'Beta' }
];
function herdrAgent(session: string, workspace = 'wA', client = 'claude') {
	return {
		agent: client,
		agent_session: { kind: 'id', value: session },
		agent_status: 'idle',
		cwd: `/home/someone/projects/${session}`,
		pane_id: `${workspace}:p-${session}`,
		tab_id: `${workspace}:t-${session}`,
		workspace_id: workspace
	};
}
function setHerdr(agents: ReturnType<typeof herdrAgent>[]) {
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents,
			workspaces: WORKSPACES,
			panes: agents.map((agent) => ({ pane_id: agent.pane_id, workspace_id: agent.workspace_id, cwd: agent.cwd, tab_id: agent.tab_id })),
			tabs: agents.map((agent) => ({ tab_id: agent.tab_id, workspace_id: agent.workspace_id, label: `分頁-${agent.agent_session.value}` }))
		})
	);
}
/** A conversation of a user message and `answers` answers, the last one the newest. */
function record(session: string, answers = 1) {
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	const items = [{ kind: 'user', text: '幫我看一下' }, ...Array.from({ length: answers }, (_, index) => ({ kind: 'assistant', text: `回覆 ${index + 1}` }))];
	const lines = items.map((line) => JSON.stringify({ ...line, time: '2026-10-19T09:00:00.000Z' }) + '\n');
	writeFileSync(join(fixture.dir, 'transcripts', `${session}.jsonl`), lines.join(''));
}
let eventId = 1;
function stopEvent(session: string, by: string, time: number, name = `n-${session}`) {
	const event = {
		data: { action: 'stopped', by, reason: 'killed', snapshot: { name, session_id: session, tool: 'claude', directory: `/home/someone/projects/${session}` } },
		id: ++eventId,
		instance: name,
		ts: new Date(time).toISOString(),
		type: 'life'
	};
	appendFileSync(join(fixture.dir, 'hcom-events.jsonl'), JSON.stringify(event) + '\n');
}
/** Midnight starting today in Taipei, as a time; and noon some days before. */
function taipeiMidnight(daysBack = 0): number {
	const [year, month, day] = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(Date.now()).split('-').map(Number);
	// Taipei is UTC+8 all year.
	return Date.UTC(year, month - 1, day) - 8 * 60 * 60 * 1000 - daysBack * DAY;
}
const sentLog = () => {
	const file = join(fixture.dir, 'board-state', 'sent-log.jsonl');
	return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
};

/** In Herdr now, besides the closed ones: one agent per workspace. */
const LIVE = [herdrAgent('s-live'), herdrAgent('s-live-b', 'wB')];
const CLOSED = ['s-today', 's-yesterday', 's-week', 's-lead', 's-fail', 's-switch'];

beforeAll(async () => {
	socket = createServer((connection) =>
		connection.on('data', (chunk) => {
			const request = JSON.parse(chunk.toString().trim());
			appendFileSync(join(fixture.dir, 'herdr-calls.jsonl'), JSON.stringify(['socket', request.method, request.params]) + '\n');
			connection.write(JSON.stringify({ id: request.id, result: { type: 'tab_moved' } }) + '\n');
		})
	);
	await new Promise<void>((resolve) => socket.listen(socketPath, resolve));
	fixture = await startFixture(61, { env: { TZ: TIME_ZONE, HERDR_SOCKET_PATH: socketPath, LAT_BOARD_LAUNCH_WAIT_SECONDS: '5' } });
	cookie = await fixture.login();
	const lead = fixture.bound('lat', 'lead', { session_id: 's-lead' });
	fixture.list([lead]);
	fixture.report('s-lead', { tag: 'DONE', hcom_name: 'lead', summary: '完成了' });
	for (const session of CLOSED) record(session, session === 's-yesterday' ? 59 : 1);
	// The board sees them all in Herdr, then only the live ones are left.
	setHerdr([...LIVE, ...CLOSED.map((session) => herdrAgent(session, session === 's-week' ? 'wB' : 'wA', session === 's-week' ? 'codex' : 'claude'))]);
	fixture.setHcom({ agents: [{ name: 'lead', session_id: 's-lead', status: 'listening' }] });
	await fixture.refresh(cookie);
	setHerdr(LIVE);
	fixture.setHcom({ agents: [] });
	const now = Date.now();
	stopEvent('s-today', 'pty', Math.max(taipeiMidnight() + 1000, now - 60_000));
	stopEvent('s-lead', 'cli', Math.max(taipeiMidnight() + 500, now - 120_000), 'lead');
	stopEvent('s-fail', 'session', Math.max(taipeiMidnight(), now - 180_000));
	stopEvent('s-yesterday', 'cli', taipeiMidnight(1) + 12 * 60 * 60 * 1000);
	stopEvent('s-week', 'system', taipeiMidnight(3) + 12 * 60 * 60 * 1000);
	// Stopped by its model switch, which is open: listed in the tab's main list instead.
	stopEvent('s-switch', 'cli', now - 30_000);
	mkdirSync(join(fixture.dir, 'board-state'), { recursive: true });
	const place = { name: 'n-s-switch', folder: '/home/someone/projects/s-switch', workspace: 'wA', workspaceLabel: 'Alpha', workspaceNumber: 1 };
	appendFileSync(
		join(fixture.dir, 'board-state', 'sent-log.jsonl'),
		JSON.stringify({
			id: 'switch-1',
			kind: 'switch',
			time: new Date(now).toISOString(),
			controllerId: 's-switch',
			hcomName: 'n-s-switch',
			client: 'claude',
			from: null,
			to: { model: 'claude-sonnet-5-5', effort: null },
			route: 'restart',
			state: 'resume-failed',
			error: '接回失敗',
			pane: null,
			agent: place
		}) + '\n'
	);
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
	rmSync(socketDir, { recursive: true, force: true });
});

/** A new Chrome on the board's Herdr tab in a window `width` wide. */
async function visit(width: number, search = '?tab=agents') {
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
	await tab.until(`JSON.stringify(history.state).includes('depth')`, 'the board to start');
	await tab.until(`!!document.querySelector('.inbox [data-agent="s-live"]')`, 'the Herdr tab');
}
const TRIGGER = `.inbox .closed .trigger`;
const unfold = () => tab.eval(`document.querySelector(${JSON.stringify(TRIGGER)}).click()`);
const rowText = (session: string) => tab.eval<string>(`document.querySelector('[data-closed="${session}"]')?.innerText ?? ''`);
/** The 接回 on a closed agent's page, under its information card. */
const RESUME = `.detail [data-closed-agent] + .controls [data-action="resume"]`;
/** Open a closed agent's page from its row, the section unfolded. */
async function openClosed(session: string) {
	await tab.until(`!!document.querySelector('[data-closed="${session}"]')`, 'the row');
	await tab.eval(`document.querySelector('[data-closed="${session}"]').click()`);
	await tab.until(`!!document.querySelector('.detail [data-closed-agent="${session}"]')`, "the agent's page");
}
/** The groups as shown: each label with the sessions under it, in order. */
const GROUPS = `(() => { const out = []; for (const node of document.querySelectorAll('.inbox .closed .age, .inbox .closed [data-closed]')) {
	if (node.classList.contains('age')) out.push([node.innerText, []]); else out.at(-1)[1].push(node.dataset.closed); } return out; })()`;

for (const width of [1280, 390]) {
	test.skipIf(!CHROME)(`${width}px: one folded row after every workspace unfolds the closed agents by day, newest first`, async () => {
		await visit(width);
		await tab.until(`!!document.querySelector(${JSON.stringify(TRIGGER)})`, 'the closed row');
		expect(await tab.eval(`document.querySelector(${JSON.stringify(TRIGGER)}).innerText`)).toBe('已關閉 5');
		expect(await tab.eval(`document.querySelector(${JSON.stringify(TRIGGER)}).getAttribute('aria-expanded')`)).toBe('false');
		// Below the last workspace, and folded: no row shows.
		const list = (await screen()).middle;
		expect(list.indexOf('Beta')).toBeLessThan(list.indexOf('已關閉 5'));
		expect(await tab.eval(`document.querySelectorAll('[data-closed]').length`)).toBe(0);

		await unfold();
		await tab.until(`document.querySelectorAll('[data-closed]').length === 5`, 'the rows');
		expect(await tab.eval(GROUPS)).toEqual([
			['今天', ['s-today', 's-lead', 's-fail']],
			['昨天', ['s-yesterday']],
			['近 7 天', ['s-week']]
		]);
		// Each row: the tab's and HCOM names, client, folder, old workspace and when it stopped.
		const week = await rowText('s-week');
		for (const part of ['分頁-s-week', '@n-s-week', 'codex', 's-week', 'Beta']) expect(week).toContain(part);
		// 接回 is on the agent's page, not its row.
		expect(week).not.toContain('接回');
		expect(await tab.eval(`document.querySelectorAll('.inbox .closed [data-action="resume"]').length`)).toBe(0);
		expect(week).toMatch(/\d+\/\d+ 12:00/);
		expect(await rowText('s-today')).toMatch(/分頁-s-today[\s\S]*Alpha[\s\S]*\d\d:\d\d/);
		expect(await rowText('s-lead')).toContain('主控');
		expect(await rowText('s-today')).not.toContain('主控');
		// The agent whose model switch is open stays in the main list, to continue or give up.
		expect(await tab.eval(`!!document.querySelector('[data-closed="s-switch"]')`)).toBe(false);
		expect(await tab.eval(`document.querySelector('.inbox [data-agent="s-switch"]')?.innerText ?? ''`)).toContain('切換未完成');
		expect(await tab.eval(FITS)).toBe(true);

		await unfold();
		await tab.until(`document.querySelectorAll('[data-closed]').length === 0`, 'the rows to fold');
	}, 30_000);
}

for (const width of [1280, 390]) {
	test.skipIf(!CHROME)(`${width}px: a row opens the closed agent's page, its conversation paged back like a running one's, and back returns to the list`, async () => {
		await visit(width);
		await unfold();
		await openClosed('s-yesterday');
		expect((await screen()).search).toBe('?agent=s-yesterday');
		expect(await tab.eval(`document.querySelector('[data-closed="s-yesterday"]').classList.contains('current')`)).toBe(true);
		// Its card: closed, the tab's and HCOM names, folder, old workspace and when it stopped; then 接回.
		const card = await tab.eval<string>(`document.querySelector('.detail [data-closed-agent]').innerText`);
		for (const part of ['已關閉', '分頁-s-yesterday', '@n-s-yesterday', '/home/someone/projects/s-yesterday', 'Alpha', 's-yesterday']) expect(card).toContain(part);
		expect(card).toMatch(/\d+\/\d+ 12:00/);
		expect(await tab.eval(`document.querySelector(${JSON.stringify(RESUME)})?.innerText`)).toBe('接回');
		// The translation button sits at the right end of the 對話紀錄 heading row.
		expect(await tab.eval(`(() => { const row = document.querySelector('.detail .records'); const b = row.querySelector('button.translate'); return !!b && b.getAttribute('aria-label') === '翻譯成中文' && b.getAttribute('aria-pressed') === 'false' && row.getBoundingClientRect().right - b.getBoundingClientRect().right < 24; })()`)).toBe(true);
		// The newest page of its conversation, and the one before on asking.
		await tab.until(`(document.querySelector('.detail .history')?.innerText ?? '').includes('回覆 59')`, 'the latest page');
		const shown = () => tab.eval<number>(`document.querySelectorAll('.detail .history .said').length`);
		expect(await shown()).toBe(50);
		expect(fixture.helperArgs('transcript').at(-1)).toEqual(['board', 'transcript', '--client=claude', '--session-id=s-yesterday']);
		await tab.eval(`document.querySelector('.detail .history .earlier')?.click()`);
		await tab.until(`document.querySelectorAll('.detail .history .said').length === 60`, 'the earlier page');
		expect(await tab.eval(`document.querySelector('.detail .history').innerText.includes('幫我看一下')`)).toBe(true);
		// Nothing is sent to it from the command line, which says why.
		const box = `.dock textarea`;
		expect(await tab.eval(`document.querySelector('${box}').disabled`)).toBe(true);
		expect(await tab.eval(`document.querySelector('${box}').placeholder`)).toBe('已關閉，先接回才能傳訊息。');
		expect(await tab.eval(`document.querySelector('.dock .to').innerText`)).toBe('→ @n-s-yesterday');
		expect(await tab.eval(FITS)).toBe(true);

		await tab.eval(`document.querySelector('.detail .topbar button[aria-label="返回"]').click()`);
		await tab.until(`location.search === '?tab=agents'`, 'the list again');
		await tab.until(`!!document.querySelector('[data-closed="s-yesterday"]')`, 'the row again');
		if (width <= 760) expect(await tab.eval(`getComputedStyle(document.querySelector('.detail')).display`)).toBe('none');
	}, 30_000);
}

test.skipIf(!CHROME)("390px: a closed agent's address opens its page, with the list behind it", async () => {
	await visit(390, '?agent=s-week');
	await tab.until(`(document.querySelector('.detail .history')?.innerText ?? '').includes('回覆 1')`, 'its conversation');
	expect(await tab.eval(`document.querySelector('.detail [data-closed-agent]').innerText`)).toContain('分頁-s-week');
	expect(fixture.helperArgs('transcript').at(-1)).toEqual(['board', 'transcript', '--client=codex', '--session-id=s-week']);
	await tab.eval(`document.querySelector('.detail .topbar button[aria-label="返回"]').click()`);
	await tab.until(`location.search === '?tab=agents' || location.search === ''`, 'the list');
	expect(await tab.eval(`getComputedStyle(document.querySelector('.detail')).display`)).toBe('none');
}, 30_000);

test.skipIf(!CHROME)("a draft kept from before is not sent to the closed agent, named or not, and the reason still shows", async () => {
	await visit(1280);
	await tab.eval(`localStorage.setItem('lat-board-agent-drafts', JSON.stringify({ 's-lead': '@lead 繼續', 's-yesterday': '還沒送出' }))`);
	await tab.send('Page.reload');
	await tab.until(`JSON.stringify(history.state).includes('depth') && !!document.querySelector('.inbox [data-agent="s-live"]')`, 'the board again');
	// Unfolded once the reloaded page answers clicks.
	await tab.until(
		`(() => { const trigger = document.querySelector(${JSON.stringify(TRIGGER)}); if (trigger?.getAttribute('aria-expanded') === 'false') trigger.click(); return !!document.querySelector('[data-closed]'); })()`,
		'the rows'
	);
	const wakes = () => sentLog().filter((line) => line.kind === 'wake').length;
	const before = wakes();
	for (const [session, draft, to] of [['s-yesterday', '還沒送出', '@n-s-yesterday'], ['s-lead', '@lead 繼續', '@lead']]) {
		await openClosed(session);
		await tab.until(`document.querySelector('.dock textarea').value === ${JSON.stringify(draft)}`, 'the kept draft');
		expect(await tab.eval(`document.querySelector('.dock textarea').disabled`)).toBe(true);
		expect(await tab.eval(`document.querySelector('.dock .to').innerText`)).toBe(`→ ${to}`);
		expect(await tab.eval(`document.querySelector('.dock .closed-note')?.innerText`)).toBe('已關閉，先接回才能傳訊息。');
		expect(await tab.eval(`document.querySelector('.dock button[type="submit"], .dock .send')?.disabled`)).toBe(true);
		await tab.eval(`document.querySelector('.dock form').requestSubmit()`);
		await sleep(300);
		expect(wakes()).toBe(before);
		expect(await tab.eval(`document.querySelector('.dock textarea').value`)).toBe(draft);
	}
}, 30_000);

test.skipIf(!CHROME)("a closed controller's 接回 stopped by an earlier resume offers to give that one up on its page", async () => {
	const earlier = {
		id: 'wake-earlier', kind: 'wake', time: new Date().toISOString(), controllerId: 's-lead', hcomName: 'lead', text: '早先', newRound: false,
		route: 'resume', herdrWorkspace: null, herdrWorkspaceLabel: null, workspaceCreated: false, resumedName: null, pane: null, extraArgs: [],
		outcome: 'pending', error: null
	};
	appendFileSync(join(fixture.dir, 'board-state', 'sent-log.jsonl'), JSON.stringify(earlier) + '\n');
	await visit(1280);
	await unfold();
	await openClosed('s-lead');
	await tab.eval(`document.querySelector(${JSON.stringify(RESUME)}).click()`);
	const WAKE = '.detail [data-wake="s-lead"]';
	await tab.until(`!!document.querySelector('${WAKE} [data-action="wake"]')`, "the wake's options");
	await tab.eval(`document.querySelector('${WAKE} [data-action="wake"]').click()`);
	await tab.until(`!!document.querySelector('${WAKE} [data-action="abandon"]')`, 'the offer to give the earlier one up');
	await tab.until(`document.querySelector('.detail .controls').innerText.includes('接回失敗')`, 'the failure on the page');
	await tab.eval(`document.querySelector('${WAKE} [data-action="abandon"]').click()`);
	await tab.until(`document.querySelector('.dock .toasts')?.innerText.includes('已放棄前一次接回')`, 'the notice');
	await tab.until(`!document.querySelector('${WAKE} [data-action="abandon"]')`, 'the offer to go');
}, 30_000);

test.skipIf(!CHROME)('a 接回 that fails stays on the page and the row with why, logged', async () => {
	fixture.setHcom({ agents: [], exit: 1, stderr: 'no such session' });
	await visit(1280);
	await unfold();
	await openClosed('s-fail');
	await tab.eval(`document.querySelector(${JSON.stringify(RESUME)}).click()`);
	await tab.until(`(document.querySelector('.detail .controls')?.innerText ?? '').includes('接回失敗')`, 'the failure on the page');
	expect(await tab.eval(`document.querySelector('.detail .controls').innerText`)).toContain('hcom 接回失敗');
	expect(await rowText('s-fail')).toContain('hcom 接回失敗');
	await tab.until(`document.querySelector('.dock .toasts')?.innerText.includes('沒有接回 @n-s-fail')`, 'the failure notice');
	expect(sentLog().filter((line) => line.action === 'resume' && line.agentId === 's-fail')).toMatchObject([{ agentId: 's-fail', ok: false }]);
	expect(await tab.eval(`document.querySelector(${JSON.stringify(RESUME)}).disabled`)).toBe(false);
}, 30_000);

test.skipIf(!CHROME)("390px: 接回 from the page brings the agent back to its workspace at the front, and the page becomes the running agent's", async () => {
	fixture.setHcom({ agents: [], resumed: { name: 'n-s-today', session_id: 's-today', status: 'listening', launch_context: { pane_id: 'wA:p-back' } } });
	await visit(390);
	await unfold();
	await openClosed('s-today');
	expect(await tab.eval(FITS)).toBe(true);
	await tab.eval(`document.querySelector(${JSON.stringify(RESUME)}).click()`);
	await tab.until(`!!document.querySelector('.detail [data-agent="s-today"]')`, "the running agent's page");
	expect(await tab.eval(`!!document.querySelector('.detail [data-closed-agent]')`)).toBe(false);
	expect((await screen()).search).toBe('?agent=s-today');
	await tab.until(`!document.querySelector('[data-closed="s-today"]')`, 'the row to leave');
	await tab.until(`document.querySelector('.dock .toasts')?.innerText.includes('已開始接回 @n-s-today')`, 'the notice');
	const resumed = readFileSync(join(fixture.dir, 'hcom-calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((call) => call.args[0] === 'r');
	expect(resumed.at(-1)).toMatchObject({ args: ['r', 's-today', '--terminal', 'herdr', '--no-run-here', '--go'], workspace: 'wA' });
	await until(() => sentLog().find((line) => line.action === 'resume' && line.ok), 10_000, 'the resume logged');
	const moves = readFileSync(join(fixture.dir, 'herdr-calls.jsonl'), 'utf8');
	expect(moves).toContain('"tab.move",{"tab_id":"wA:t-s-today","insert_index":0}');
	expect(await tab.eval(`document.querySelector(${JSON.stringify(TRIGGER)}).textContent.trim()`)).toBe('已關閉 4');
	// Written to like any agent now.
	expect(await tab.eval(`document.querySelector('.dock textarea').disabled`)).toBe(false);
}, 30_000);

test.skipIf(!CHROME)("390px: a closed controller's page shows its conversation, and its 接回 opens the wake's options and wakes it with them", async () => {
	fixture.setHcom({ agents: [], resumed: { name: 'lead', session_id: 's-lead', status: 'listening', launch_context: { pane_id: 'ws-lat:p-back' } } });
	await visit(390);
	await unfold();
	await openClosed('s-lead');
	expect(await tab.eval(`document.querySelector('.detail [data-closed-agent]').innerText`)).toContain('LAT 主控');
	await tab.until(`(document.querySelector('.detail .history')?.innerText ?? '').includes('回覆 1')`, 'its conversation');
	expect(await tab.eval(`document.querySelector('.dock textarea').disabled`)).toBe(true);
	await tab.eval(`document.querySelector(${JSON.stringify(RESUME)}).click()`);
	const WAKE = '.detail [data-wake="s-lead"]';
	await tab.until(`!!document.querySelector('${WAKE}')`, "the wake's options");
	// The controller's model and effort parts, a new round, and a first message that may stay empty.
	await tab.until(`(document.querySelector('${WAKE}')?.innerText ?? '').includes('開新一輪 LAT')`, 'the new-round box');
	expect(await tab.eval(`document.querySelectorAll('${WAKE} .pills button').length`)).toBeGreaterThan(0);
	expect(await tab.eval(FITS)).toBe(true);
	await tab.eval(`document.querySelector('${WAKE} input[type="checkbox"]').click()`);
	await tab.eval(`(() => { const box = document.querySelector('${WAKE} textarea'); box.value = '繼續'; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
	await tab.eval(`document.querySelector('${WAKE} [data-action="wake"]').click()`);
	await tab.until(`!document.querySelector('.detail [data-closed-agent]')`, 'the page to change');
	await tab.until(`!document.querySelector('[data-closed="s-lead"]')`, 'the row to leave');
	await tab.until(`document.querySelector('.dock .toasts')?.innerText.includes('已開始接回 @lead')`, 'the notice');
	const resumed = readFileSync(join(fixture.dir, 'hcom-calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((call) => call.args[0] === 'r');
	expect(resumed.at(-1).args).toEqual(['r', 's-lead', '--terminal', 'herdr', '--no-run-here', '--go', '--hcom-prompt', '/lat 繼續']);
	expect(sentLog().find((line) => line.kind === 'wake' && line.newRound)).toMatchObject({ controllerId: 's-lead', newRound: true, route: 'resume' });
}, 30_000);

test.skipIf(!CHROME)('once its model switch is given up, the agent moves to the section', async () => {
	await visit(1280);
	await unfold();
	await tab.until(`!!document.querySelector('.inbox [data-agent="s-switch"]')`, 'the switch in the main list');
	const given = await fixture.fetch('/api/agents/model/abandon', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ session: 's-switch' }),
		cookie
	});
	expect(given.status).toBe(200);
	await tab.until(`!!document.querySelector('[data-closed="s-switch"]')`, 'the row');
	expect(await tab.eval(`!!document.querySelector('.inbox [data-agent="s-switch"]')`)).toBe(false);
}, 30_000);
