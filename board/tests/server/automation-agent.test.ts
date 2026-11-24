// Agent tasks' runs on the built board, against the fake hcom, Herdr, helper and input command:
// the agent opens through the new-agent launch flow with the fixed first message and the run's tag,
// shows in the board's agent list, and is judged by the last line of its last reply alone (DONE,
// FAILED: <reason>, anything else); every outcome closes it the board's way. 停止這次 and the limit
// close it too. A restart watches on while hcom lists the agent, with the limit from the original
// start, and fails the run when it is gone. Codex (CPA, #710): no account is checked or switched; a
// usage limit on the screen gets one continue message to the same agent (no kill), and only a new
// usage-limit stop after that message was read ends the run as 額度用完, worded by the run's own
// provider (`cpa` or not). A Claude usage limit is 額度用完 as before. A task whose run ran out of
// quota tries again the next day. Nothing here starts a real agent or touches a real account.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { jsonLines, sleep, startFixture, until, type Fixture } from '../harness.ts';
import { CONTINUE_MESSAGE, CONTROLLER_CONTINUE } from '../../src/lib/server/automation-agent.ts';
import type { AutomationRun, AutomationSnapshot, AutomationTask } from '../../src/lib/board/automation.ts';

/** A wall-clock time in Asia/Taipei. */
const tpe = (year: number, month: number, day: number, hour = 12, minute = 0) => Date.UTC(year, month - 1, day, hour - 8, minute);
const START = tpe(2026, 11, 18, 12);

// The fake input command's log lives outside the fixture directory: its command line is set before the fixture exists.
const injectDir = mkdtempSync(join(tmpdir(), 'lat-board-agent-inject-'));

let fixture: Fixture;
let cookie: string;
let work: string;
let dir: string;

beforeAll(async () => {
	fixture = await startFixture({ env: { TZ: 'UTC', LAT_BOARD_AUTOMATION_TICK_SECONDS: '0.1', LAT_BOARD_AUTOMATION_AGENT_POLL_SECONDS: '0.1', LAT_BOARD_LAUNCH_WAIT_SECONDS: '3', LAT_BOARD_HCOM_TIMEOUT_SECONDS: '3', LAT_BOARD_INJECT_COMMAND: JSON.stringify([process.execPath, join(import.meta.dir, '../fake-inject.mjs'), injectDir]), LAT_BOARD_INJECT_TIMEOUT_SECONDS: '2' } });
	dir = fixture.dir;
	fixture.setClock(START);
	work = join(dir, 'work');
	mkdirSync(join(work, 'docs'), { recursive: true });
	writeFileSync(join(work, 'docs/brief.md'), '# 任務\n');
	cookie = await fixture.login();
});
afterAll(async () => {
	rmSync(injectDir, { recursive: true, force: true });
	await fixture.cleanup();
});
beforeEach(() => {
	fixture.setClock(START);
	for (const name of ['hcom-calls.jsonl', 'hcom.json', 'hcom-added.json']) rmSync(join(dir, name), { force: true });
	for (const name of ['inject-typed.jsonl', 'inject-calls.jsonl']) rmSync(join(injectDir, name), { force: true });
	rmSync(join(dir, 'transcripts'), { recursive: true, force: true });
	herdrPlan();
});

async function authed(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
	const response = await fixture.fetch(path, { ...init, cookie });
	if (response.status !== 401) return response;
	cookie = await fixture.login();
	return fixture.fetch(path, { ...init, cookie });
}
const send = (path: string, method: string, body?: unknown) =>
	authed(path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const snapshot = async (): Promise<AutomationSnapshot> => (await authed('/api/automation')).json();
const runsOf = async (id: string): Promise<AutomationRun[]> => (await snapshot()).tasks.find((view) => view.task.id === id)!.runs;

/** One workspace with a pane in the work folder, so a launch there opens its agent in it. */
function herdrPlan(withAutomation = true, extra: object = {}) {
	writeFileSync(
		join(dir, 'herdr.json'),
		JSON.stringify({
			workspaces: [{ workspace_id: 'wW', number: 1, label: 'Work' }, ...(withAutomation ? [{ workspace_id: 'wA', number: 2, label: 'AUTOMATION' }] : [])],
			tabs: [{ tab_id: 'wW:t0', label: 'shell', workspace_id: 'wW' }],
			panes: [{ pane_id: 'wW:p0', workspace_id: 'wW', cwd: work, tab_id: 'wW:t0' }],
			agents: [],
			...extra
		})
	);
}

/** What the fake hcom does for each launch in turn: the name, and the agent it then lists (busy) and Herdr runs. */
function hcomPlan(launches: { name: string; client?: 'claude' | 'codex' }[], extra: object = {}) {
	writeFileSync(
		join(dir, 'hcom.json'),
		JSON.stringify({
			names: launches.map((launch) => launch.name),
			agents: [],
			launched: launches.map((launch) => ({ name: launch.name, session_id: `s-${launch.name}`, status: 'active', tool: launch.client ?? 'claude', launch_context: { pane_id: `wW:p-${launch.name}` } })),
			launchedHerdr: launches.map((launch) => ({
				agent: launch.client ?? 'claude',
				agent_status: 'working',
				cwd: work,
				pane_id: `wW:p-${launch.name}`,
				tab_id: `wW:t-${launch.name}`,
				tab_label: launch.name,
				workspace_id: 'wA',
				agent_session: { value: `s-${launch.name}` }
			})),
			...extra
		})
	);
}

/** The agent's turn as hcom lists it now. */
function setStatus(name: string, status: string) {
	const file = join(dir, 'hcom-added.json');
	const added = JSON.parse(readFileSync(file, 'utf8'));
	writeFileSync(file, JSON.stringify(added.map((agent: { name: string; base_name?: string }) => (agent.name === name || agent.base_name === name ? { ...agent, status } : agent))));
}

/** Add to the conversation of `s-<name>`, and end the turn. */
function reply(name: string, ...texts: string[]) {
	mkdirSync(join(dir, 'transcripts'), { recursive: true });
	for (const text of texts) appendFileSync(join(dir, 'transcripts', `s-${name}.jsonl`), JSON.stringify({ kind: 'assistant', time: null, text }) + '\n');
}
function userSaid(name: string, text: string) {
	mkdirSync(join(dir, 'transcripts'), { recursive: true });
	appendFileSync(join(dir, 'transcripts', `s-${name}.jsonl`), JSON.stringify({ kind: 'user', time: null, text }) + '\n');
}

/** Wait for an asynchronous read to give a value. */
async function eventually<T>(read: () => Promise<T | undefined | false>, timeoutMs: number, what: string): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(50);
	}
}

const hcomCalls = () => jsonLines(join(dir, 'hcom-calls.jsonl')) as { args: string[]; workspace: string | null }[];
/** What the board typed into agents' input boxes. */
const injected = () => jsonLines(join(injectDir, 'inject-typed.jsonl')) as { text: string; enter: boolean }[];
/** Whether hcom lists the agent launched as `name` (listed as `<tag>-<name>`). */
const listed = (name: string) =>
	existsSync(join(dir, 'hcom-added.json')) && JSON.parse(readFileSync(join(dir, 'hcom-added.json'), 'utf8')).some((agent: { name: string; base_name?: string }) => agent.name === name || agent.base_name === name);

async function create(overrides: Record<string, unknown> = {}, agent: Record<string, unknown> = {}): Promise<AutomationTask> {
	const response = await send('/api/automation', 'POST', {
		name: 'Agent 任務',
		// Its window is a week away: only 立即執行 runs it, unless a test says otherwise.
		schedule: { type: 'monthly', fromDay: 1, toDay: 2 },
		time: '02:00',
		limitMinutes: 30,
		kind: 'agent',
		agent: { client: 'claude', model: 'claude-haiku-5-5', effort: 'low', folder: work, brief: 'docs/brief.md', ...agent },
		review: { enabled: false, checklist: [] },
		...overrides
	});
	if (response.status !== 201) throw new Error(`create: ${response.status} ${await response.text()}`);
	return response.json();
}

async function runNow(id: string): Promise<AutomationRun> {
	const response = await send(`/api/automation/${id}/run`, 'POST');
	expect(response.status).toBe(202);
	return response.json();
}

/** The run once its record says it has an agent and hcom lists it with its session. */
async function launchedRun(id: string, name: string): Promise<AutomationRun> {
	return eventually(
		async () => {
			const run = (await runsOf(id))[0];
			return run?.sessionId === `s-${name}` ? run : undefined;
		},
		5_000,
		`${name} to be launched and listed`
	).catch(async (error) => {
		throw new Error(`${error.message}: ${JSON.stringify((await runsOf(id))[0])}`);
	});
}
async function ended(id: string, runId: string): Promise<AutomationRun> {
	return eventually(
		async () => {
			const run = (await runsOf(id)).find((entry) => entry.id === runId);
			return run && run.status !== 'running' ? run : undefined;
		},
		8_000,
		`the run ${runId} to end`
	);
}

test('a run opens a plain agent with the fixed first message and its tag, shows in the agent list, and DONE closes it as a success', async () => {
	const task = await create();
	hcomPlan([{ name: 'auto-one' }]);
	const started = await runNow(task.id);
	const run = await launchedRun(task.id, 'auto-one');

	const launch = hcomCalls().find((call) => call.args[0] === 'claude')!;
	const brief = join(work, 'docs/brief.md');
	const prompt = launch.args[launch.args.indexOf('--hcom-prompt') + 1];
	expect(prompt).toBe(`讀取並照做 ${brief}，完成後最後一行只回覆 DONE，失敗回覆 FAILED: <原因>；需要使用者決定或補資料時，最後一行回覆 ASK: <問題> 並等待回覆，收到後接著做`);
	const tag = launch.args[launch.args.indexOf('--tag') + 1];
	expect(tag).toBe(`auto-${task.id}-${started.id.split('-').at(-1)!.slice(0, 6)}`);
	// hcom prints the agent's own name and lists it under its tag: the run follows the listed one.
	expect(run.agentName).toBe(`${tag}-auto-one`);
	expect(launch.args.slice(launch.args.indexOf('--dir'), launch.args.indexOf('--dir') + 2)).toEqual(['--dir', work]);
	expect(launch.args).toEqual(expect.arrayContaining(['--model', 'claude-haiku-5-5', '--effort', 'low', '--dangerously-skip-permissions']));
	expect(launch.workspace).toBe('wA');
	// The board's own agent list has it, under the session its link opens.
	const board = await fixture.refresh(cookie);
	expect(board.agents.map((agent) => agent.id)).toContain('s-auto-one');

	// Still working: an earlier text is not the verdict.
	reply('auto-one', 'DONE');
	await sleep(500);
	expect((await runsOf(task.id))[0].status).toBe('running');
	reply('auto-one', '掃描完成，報告在 out/。\nDONE');
	setStatus('auto-one', 'listening');
	const done = await ended(task.id, started.id);
	expect(done.status).toBe('success');
	expect(hcomCalls().some((call) => call.args[0] === 'kill' && call.args[1] === run.agentName)).toBe(true);
	expect(listed('auto-one')).toBe(false);
	expect((await snapshot()).tasks.find((view) => view.task.id === task.id)!.state).toBe('done');
});

test('回報方式 DEMO 網頁 adds the publish instruction to the first message, 口頭 adds nothing; the choice is saved and a wrong one is refused (#708)', async () => {
	const oral = await create({}, { report: 'oral' });
	expect(oral.agent!.report).toBeUndefined();
	const demo = await create({ name: 'Agent 報告任務' }, { report: 'demo' });
	expect(demo.agent!.report).toBe('demo');
	expect((await snapshot()).tasks.find((view) => view.task.id === demo.id)!.task.agent!.report).toBe('demo');
	const bad = await send('/api/automation', 'POST', {
		name: 'x', schedule: { type: 'monthly', fromDay: 1, toDay: 2 }, time: '02:00', limitMinutes: 30, kind: 'agent',
		agent: { client: 'claude', model: 'm', effort: 'low', folder: work, brief: 'docs/brief.md', report: 'email' }, review: { enabled: false, checklist: [] }
	});
	expect(bad.status).toBe(400);
	expect(((await bad.json()) as { errors: Record<string, string> }).errors.report).toBeTruthy();

	hcomPlan([{ name: 'auto-demo' }]);
	const started = await runNow(demo.id);
	await launchedRun(demo.id, 'auto-demo');
	const launch = hcomCalls().find((call) => call.args[0] === 'claude')!;
	const prompt = launch.args[launch.args.indexOf('--hcom-prompt') + 1];
	const brief = join(work, 'docs/brief.md');
	expect(prompt.startsWith(`讀取並照做 ${brief}；報告寫好後，用 ui-choice-demo 技能的 publish-md 指令（`)).toBe(true);
	expect(prompt).toMatch(new RegExp(`--name ${demo.id}-\\d{4}-\\d{2}-\\d{2}`))
	expect(prompt).toContain('看板網址');
	expect(prompt.endsWith('最後一行回覆 ASK: <問題> 並等待回覆，收到後接著做')).toBe(true);
	reply('auto-demo', '報告網址：https://board.example/demo/x/\nDONE');
	setStatus('auto-demo', 'listening');
	expect((await ended(demo.id, started.id)).status).toBe('success');

	rmSync(join(dir, 'hcom-calls.jsonl'), { force: true });
	hcomPlan([{ name: 'auto-oral' }]);
	const second = await runNow(oral.id);
	await launchedRun(oral.id, 'auto-oral');
	const plain = hcomCalls().find((call) => call.args[0] === 'claude')!;
	expect(plain.args[plain.args.indexOf('--hcom-prompt') + 1]).toBe(`讀取並照做 ${brief}，完成後最後一行只回覆 DONE，失敗回覆 FAILED: <原因>；需要使用者決定或補資料時，最後一行回覆 ASK: <問題> 並等待回覆，收到後接著做`);
	reply('auto-oral', 'DONE');
	setStatus('auto-oral', 'listening');
	await ended(oral.id, second.id);
});

test('FAILED records its reason; a turn that ends on neither fails; only the last line of the last reply counts; each closes the agent', async () => {
	const task = await create();
	const cases: [string, string[], string, string][] = [
		['auto-fail', ['FAILED: 找不到 ZAP 報告'], 'failed', 'Agent 回覆失敗：找不到 ZAP 報告'],
		['auto-none', ['我做完了，但有點問題'], 'failed', '回合結束，但最後一行不是 DONE、FAILED 或 ASK：我做完了，但有點問題'],
		['auto-mid', ['DONE\n其實還差一步'], 'failed', '回合結束，但最後一行不是 DONE、FAILED 或 ASK：其實還差一步'],
		['auto-old', ['DONE', '等一下，還沒好'], 'failed', '回合結束，但最後一行不是 DONE、FAILED 或 ASK：等一下，還沒好'],
		// A reply that only mentions a usage limit is no quota error.
		['auto-usage', ['網站的 usage limit 是每分鐘 60 次'], 'failed', '回合結束，但最後一行不是 DONE、FAILED 或 ASK：網站的 usage limit 是每分鐘 60 次']
	];
	for (const [name, replies, status, reason] of cases) {
		rmSync(join(dir, 'hcom-calls.jsonl'), { force: true });
		rmSync(join(dir, 'hcom-added.json'), { force: true });
		hcomPlan([{ name }]);
		const started = await runNow(task.id);
		await launchedRun(task.id, name);
		userSaid(name, '讀取並照做');
		reply(name, ...replies);
		setStatus(name, 'listening');
		const run = await ended(task.id, started.id);
		expect([name, run.status, run.reason]).toEqual([name, status, reason]);
		expect(listed(name)).toBe(false);
	}
});

test('停止這次 and the limit close the agent, recorded as stopped and as a timeout', async () => {
	const task = await create({ limitMinutes: 5 });
	hcomPlan([{ name: 'auto-stop' }]);
	const first = await runNow(task.id);
	await launchedRun(task.id, 'auto-stop');
	expect((await send(`/api/automation/${task.id}/stop`, 'POST')).status).toBe(202);
	const stopped = await ended(task.id, first.id);
	expect([stopped.status, stopped.reason]).toEqual(['stopped', '使用者按了停止這次']);
	expect(listed('auto-stop')).toBe(false);
	expect((await send(`/api/automation/${task.id}/stop`, 'POST')).status).toBe(409);

	rmSync(join(dir, 'hcom-calls.jsonl'), { force: true });
	hcomPlan([{ name: 'auto-late' }]);
	const second = await runNow(task.id);
	await launchedRun(task.id, 'auto-late');
	fixture.setClock(START + 5 * 60_000);
	const late = await ended(task.id, second.id);
	expect([late.status, late.reason]).toEqual(['timeout', '超過上限 5 分鐘，已停止']);
	expect(listed('auto-late')).toBe(false);
});

test('after a restart a run whose agent hcom still lists is watched on, with the limit from its start; one whose agent is gone fails', async () => {
	const task = await create({ limitMinutes: 10 });
	hcomPlan([{ name: 'auto-stay' }]);
	const first = await runNow(task.id);
	await launchedRun(task.id, 'auto-stay');
	await fixture.stop();
	fixture.setClock(START + 3 * 60_000);
	await fixture.start();
	cookie = await fixture.login();
	await sleep(500);
	expect((await runsOf(task.id))[0]).toMatchObject({ id: first.id, status: 'running' });
	reply('auto-stay', 'DONE');
	setStatus('auto-stay', 'listening');
	expect((await ended(task.id, first.id)).status).toBe('success');
	expect(listed('auto-stay')).toBe(false);

	// The limit counts from the start, not from the restart.
	rmSync(join(dir, 'hcom-calls.jsonl'), { force: true });
	hcomPlan([{ name: 'auto-long' }]);
	const second = await runNow(task.id);
	await launchedRun(task.id, 'auto-long');
	// Started at 12:03, with a limit of 10 minutes: over at 12:13 however long the board was down.
	await fixture.stop();
	fixture.setClock(START + 13 * 60_000);
	await fixture.start();
	cookie = await fixture.login();
	expect((await ended(task.id, second.id)).status).toBe('timeout');
	expect(listed('auto-long')).toBe(false);

	// Gone while the board was down, with no DONE or FAILED.
	rmSync(join(dir, 'hcom-calls.jsonl'), { force: true });
	hcomPlan([{ name: 'auto-gone' }]);
	const third = await runNow(task.id);
	await launchedRun(task.id, 'auto-gone');
	await fixture.stop();
	writeFileSync(join(dir, 'hcom-added.json'), '[]');
	await fixture.start();
	cookie = await fixture.login();
	const gone = await ended(task.id, third.id);
	expect([gone.status, gone.reason]).toEqual(['failed', '看板重啟時 Agent 已不在']);

	// The board stopped after hcom started the agent but before its name was recorded: the run's tag finds it.
	await fixture.stop();
	const runId = `${(START + 20 * 60_000).toString(36)}-abcdef0123`;
	const tag = `auto-${task.id}-abcdef`;
	appendFileSync(join(dir, 'board-state/automation/runs', `${task.id}.jsonl`), JSON.stringify({ id: runId, taskId: task.id, trigger: 'manual', period: '2026-11', startedAt: START + 20 * 60_000, status: 'running' }) + '\n');
	writeFileSync(join(dir, 'hcom-added.json'), JSON.stringify([{ name: `${tag}-kiro`, tag, session_id: 's-tagged', status: 'listening', tool: 'claude', launch_context: { pane_id: 'wW:p-tagged' } }]));
	mkdirSync(join(dir, 'transcripts'), { recursive: true });
	writeFileSync(join(dir, 'transcripts/s-tagged.jsonl'), JSON.stringify({ kind: 'assistant', time: null, text: 'DONE' }) + '\n');
	fixture.setClock(START + 21 * 60_000);
	await fixture.start();
	cookie = await fixture.login();
	const tagged = await ended(task.id, runId);
	expect([tagged.status, tagged.agentName]).toEqual(['success', `${tag}-kiro`]);
});

test('a Codex run starts at once: no account check or switch before launch, the board changes no provider, and its record writes no codexAccount or accountSwitches (#710)', async () => {
	const task = await create({}, { client: 'codex', model: 'gpt-6.1-terra', effort: 'low' });
	hcomPlan([{ name: 'auto-codex', client: 'codex' }]);
	const started = await runNow(task.id);
	const run = await launchedRun(task.id, 'auto-codex');
	expect([run.codexAccount, run.accountSwitches, run.quotaNotes]).toEqual([undefined, undefined, undefined]);
	const launch = hcomCalls().find((call) => call.args[0] === 'codex')!;
	expect(launch.args).toEqual(expect.arrayContaining(['-c', 'model="gpt-6.1-terra"', '-c', 'model_reasoning_effort="low"']));
	// The provider is the host's own setting: the board passes none.
	expect(launch.args.join(' ')).not.toContain('model_provider');
	reply('auto-codex', 'DONE');
	setStatus('auto-codex', 'listening');
	const done = await ended(task.id, started.id);
	expect([done.status, done.codexAccount, done.accountSwitches]).toEqual(['success', undefined, undefined]);
	expect(RESUMES()).toEqual([]);
	expect(injected()).toEqual([]);
});

const herdrCalls = () => jsonLines(join(dir, 'herdr-calls.jsonl')) as string[][];
const workspaceCreates = () => herdrCalls().filter((call) => call[0] === 'workspace' && call[1] === 'create');

test('AUTOMATION is created when Herdr has none and never twice: the agent opens there in the task folder, and the run records the workspace', async () => {
	rmSync(join(dir, 'herdr-calls.jsonl'), { force: true });
	herdrPlan(false, { created: 'wA', createListed: true });
	const task = await create();
	hcomPlan([{ name: 'auto-ws1' }]);
	const first = await runNow(task.id);
	const run = await launchedRun(task.id, 'auto-ws1');
	expect(workspaceCreates()).toEqual([['workspace', 'create', '--cwd', work, '--label', 'AUTOMATION', '--no-focus']]);
	expect(hcomCalls().find((call) => call.args[0] === 'claude')!.workspace).toBe('wA');
	expect(run.agentWorkspace).toBe('wA');
	// The folder the agent works in is the task's, not the workspace's.
	const launch = hcomCalls().find((call) => call.args[0] === 'claude')!;
	expect(launch.args.slice(launch.args.indexOf('--dir'), launch.args.indexOf('--dir') + 2)).toEqual(['--dir', work]);
	reply('auto-ws1', 'DONE');
	setStatus('auto-ws1', 'listening');
	await ended(task.id, first.id);

	// A second run finds it listed: no second workspace.
	for (const name of ['hcom-calls.jsonl', 'hcom-added.json']) rmSync(join(dir, name), { force: true });
	hcomPlan([{ name: 'auto-ws2' }]);
	const second = await runNow(task.id);
	await launchedRun(task.id, 'auto-ws2');
	expect(workspaceCreates().length).toBe(1);
	expect(hcomCalls().find((call) => call.args[0] === 'claude')!.workspace).toBe('wA');
	reply('auto-ws2', 'DONE');
	setStatus('auto-ws2', 'listening');
	await ended(task.id, second.id);
});

test('an AUTOMATION workspace Herdr already lists is used as it is: nothing created, even when the task folder has a project workspace', async () => {
	rmSync(join(dir, 'herdr-calls.jsonl'), { force: true });
	const task = await create();
	hcomPlan([{ name: 'auto-ws3' }]);
	const started = await runNow(task.id);
	await launchedRun(task.id, 'auto-ws3');
	expect(workspaceCreates()).toEqual([]);
	expect(hcomCalls().find((call) => call.args[0] === 'claude')!.workspace).toBe('wA');
	reply('auto-ws3', 'DONE');
	setStatus('auto-ws3', 'listening');
	await ended(task.id, started.id);
});

test('two runs starting together create AUTOMATION once', async () => {
	rmSync(join(dir, 'herdr-calls.jsonl'), { force: true });
	herdrPlan(false, { created: 'wA', createListed: true });
	const [one, two] = [await create({ name: '並行一' }), await create({ name: '並行二' })];
	hcomPlan([{ name: 'auto-par1' }, { name: 'auto-par2' }]);
	const [first, second] = await Promise.all([runNow(one.id), runNow(two.id)]);
	await Promise.all([launchedRun(one.id, 'auto-par1'), launchedRun(two.id, 'auto-par2')]);
	expect(workspaceCreates().length).toBe(1);
	expect(hcomCalls().filter((call) => call.args[0] === 'claude').map((call) => call.workspace)).toEqual(['wA', 'wA']);
	for (const [name, task, run] of [['auto-par1', one, first], ['auto-par2', two, second]] as const) {
		reply(name, 'DONE');
		setStatus(name, 'listening');
		await ended(task.id, run.id);
	}
});

test('a Herdr that cannot list workspaces fails the run with the reason and starts nothing', async () => {
	herdrPlan(true, { fail: { 'workspace list': { exit: 1, stderr: 'herdr down' } } });
	const task = await create();
	hcomPlan([{ name: 'auto-ws4' }]);
	const started = await runNow(task.id);
	const failed = await ended(task.id, started.id);
	expect(failed.status).toBe('failed');
	expect(failed.reason).toContain('herdr down');
	expect(hcomCalls().filter((call) => call.args[0] === 'claude')).toEqual([]);
});

test('a board restart keeps the workspace the run recorded, for a resume there later', async () => {
	const task = await create();
	hcomPlan([{ name: 'auto-ws5' }]);
	const started = await runNow(task.id);
	await launchedRun(task.id, 'auto-ws5');
	await fixture.stop();
	await fixture.start();
	cookie = await fixture.login();
	const kept = (await runsOf(task.id)).find((entry) => entry.id === started.id)!;
	expect([kept.status, kept.agentWorkspace]).toEqual(['running', 'wA']);
	reply('auto-ws5', 'DONE');
	setStatus('auto-ws5', 'listening');
	expect((await ended(task.id, started.id)).status).toBe('success');
});

/** Codex shows its usage limit on the agent's screen. */
function limitOnScreen(name: string) {
	const plan = JSON.parse(readFileSync(join(dir, 'herdr.json'), 'utf8'));
	writeFileSync(join(dir, 'herdr.json'), JSON.stringify({ ...plan, screens: { ...plan.screens, [`wW:p-${name}`]: ["■ You've hit your usage limit. Upgrade to Pro or try again at 3:00 PM.\n› "] } }));
}
function codexPlan(name: string) {
	hcomPlan([{ name, client: 'codex' }]);
}
/** The launched agent's resume comes back under its listed name, in a new pane. */
function resumesAs(run: AutomationRun, name: string) {
	const plan = JSON.parse(readFileSync(join(dir, 'hcom.json'), 'utf8'));
	plan.resumed = { name: run.agentName, base_name: name, session_id: `s-${name}`, status: 'active', tool: 'codex', launch_context: { pane_id: `wW:p-${name}-2` } };
	plan.resumedHerdr = { agent: 'codex', agent_status: 'working', cwd: work, pane_id: `wW:p-${name}-2`, tab_id: `wW:t-${name}-2`, workspace_id: 'wA', agent_session: { value: `s-${name}` } };
	writeFileSync(join(dir, 'hcom.json'), JSON.stringify(plan));
}
function freshRun() {
	for (const name of ['hcom-calls.jsonl', 'hcom-added.json']) rmSync(join(dir, name), { force: true });
	herdrPlan();
}

/** The conversation of `s-<name>` as Codex's own session file starts: a `session_meta` line with the
 *  run's `model_provider` (shaped like a real one; its content is made up). */
function sessionMeta(name: string, provider: string | null, applied?: string) {
	mkdirSync(join(dir, 'transcripts'), { recursive: true });
	if (provider === null) return;
	const meta = {
		timestamp: '2026-11-18T04:00:00.000Z',
		ordinal: 0,
		type: 'session_meta',
		payload: {
			session_id: `s-${name}`,
			id: `s-${name}`,
			timestamp: '2026-11-18T04:00:00.000Z',
			cwd: work,
			originator: 'codex_cli_rs',
			cli_version: '0.0.0',
			source: 'cli',
			thread_source: 'user',
			model_provider: provider,
			base_instructions: { text: 'x'.repeat(40_000), provenance: { type: 'model', model: 'gpt-6.1-terra' } },
			history_mode: 'full',
			context_window: { window_id: 'w-1' }
		}
	};
	appendFileSync(join(dir, 'transcripts', `s-${name}.jsonl`), JSON.stringify(meta) + '\n');
	// A resume with another provider: Codex keeps session_meta and records the new one as applied settings.
	if (applied) appendFileSync(join(dir, 'transcripts', `s-${name}.jsonl`), JSON.stringify({ timestamp: '2026-11-18T05:00:00.000Z', ordinal: 3, type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: `s-${name}`, thread_settings: { model: 'gpt-6.1-terra', model_provider_id: applied, cwd: work } } }) + '\n');
}
function clearScreen(name: string) {
	const plan = JSON.parse(readFileSync(join(dir, 'herdr.json'), 'utf8'));
	writeFileSync(join(dir, 'herdr.json'), JSON.stringify({ ...plan, screens: { ...plan.screens, [`wW:p-${name}`]: ['› '] } }));
}
/** A kill before the run ended would be a switch; after it, closing the agent may use one. */
/** Wait until the board has read hcom's list twice more: it has seen the status written just before. */
async function boardPolled(reads = 2) {
	const count = () => (existsSync(join(dir, 'hcom-list-calls.jsonl')) ? readFileSync(join(dir, 'hcom-list-calls.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0);
	const start = count();
	await eventually(async () => count() >= start + reads, 5_000, `${reads} more reads of hcom's list`);
}
const KILLS_OR_RESUMES = () => hcomCalls().filter((call) => ['r', 'kill'].includes(call.args[0]));
const RESUMES = () => hcomCalls().filter((call) => call.args[0] === 'r');
const SECOND_LIMIT_NON_CPA = '額度用完；這次執行沒有走 CPA，未判定池內帳號用完';

test('the first Codex usage limit sends one continue message and notes it: no kill, no switch; the old limit still on screen and a continue not yet read are not a second limit', async () => {
	const task = await create({ limitMinutes: 30 }, { client: 'codex', model: 'gpt-6.1-terra', effort: 'low' });
	codexPlan('auto-back');
	const started = await runNow(task.id);
	sessionMeta('auto-back', 'cpa');
	await launchedRun(task.id, 'auto-back');
	userSaid('auto-back', '讀取並照做');
	reply('auto-back', '正在掃描');
	limitOnScreen('auto-back');
	setStatus('auto-back', 'listening');
	await eventually(async () => injected().length >= 1, 5_000, 'the continue message');
	expect(injected()).toEqual([{ text: CONTINUE_MESSAGE, enter: true }]);
	const noted = await eventually(async () => (await runsOf(task.id))[0].quotaNotes, 5_000, 'the note');
	expect(noted).toEqual(['額度用完，已原地續作']);
	// Not killed, not resumed, no account touched or noted.
	expect(KILLS_OR_RESUMES()).toEqual([]);
	let run = (await runsOf(task.id))[0];
	expect([run.status, run.codexAccount, run.accountSwitches]).toEqual(['running', undefined, undefined]);
	// The message is not read yet and the old error is on screen: watched on for a while, never a second limit, no second message.
	await sleep(800);
	run = (await runsOf(task.id))[0];
	expect(run.status).toBe('running');
	expect(injected().length).toBe(1);
	// Read (the agent's input has it), but no turn came after it: the old error still on screen is not a second limit.
	userSaid('auto-back', CONTINUE_MESSAGE);
	await sleep(800);
	expect((await runsOf(task.id))[0].status).toBe('running');
	expect(injected().length).toBe(1);
	// Busy and back to listening with the old error still on screen is not a second limit either.
	setStatus('auto-back', 'active');
	await boardPolled();
	setStatus('auto-back', 'listening');
	await sleep(800);
	expect((await runsOf(task.id))[0].status).toBe('running');
	expect(injected().length).toBe(1);
	// It works on: busy, the screen clears, and its reply ends the run as usual (old error gone from the screen).
	setStatus('auto-back', 'active');
	await boardPolled();
	clearScreen('auto-back');
	reply('auto-back', '續作完成\nDONE');
	setStatus('auto-back', 'listening');
	const done = await ended(task.id, started.id);
	expect([done.status, done.quotaNotes]).toEqual(['success', ['額度用完，已原地續作']]);
	expect(RESUMES()).toEqual([]);
	expect(listed('auto-back')).toBe(false);
});

test('an agent that works on after the continue is watched as normal: a later question is asked, and its DONE still ends the run', async () => {
	const task = await create({ limitMinutes: 30 }, { client: 'codex', model: 'gpt-6.1-terra', effort: 'low' });
	codexPlan('auto-on');
	const started = await runNow(task.id);
	sessionMeta('auto-on', 'cpa');
	await launchedRun(task.id, 'auto-on');
	userSaid('auto-on', '讀取並照做');
	reply('auto-on', '正在掃描');
	limitOnScreen('auto-on');
	setStatus('auto-on', 'listening');
	await eventually(async () => injected().length >= 1, 5_000, 'the continue message');
	userSaid('auto-on', CONTINUE_MESSAGE);
	setStatus('auto-on', 'active');
	clearScreen('auto-on');
	await sleep(500);
	reply('auto-on', '繼續做了\nASK: 要用哪個資料夾？');
	setStatus('auto-on', 'listening');
	const asking = await eventually(async () => (await runsOf(task.id))[0].asks?.[0], 5_000, 'the question');
	expect(asking.question).toBe('要用哪個資料夾？');
	expect((await runsOf(task.id))[0].status).toBe('running');
	void started;
});

test('a new usage-limit stop after the continue was read ends the run as 額度用完: through CPA the pool is spent; another or an unreadable provider says it did not go through CPA', async () => {
	const task = await create({ limitMinutes: 30 }, { client: 'codex', model: 'gpt-6.1-terra', effort: 'low' });
	const cases: { name: string; provider: string | null; applied?: string; reason: string }[] = [
		{ name: 'auto-res', provider: 'openai', applied: 'cpa', reason: 'CPA 池內帳號都用完' },
		{ name: 'auto-cpa', provider: 'cpa', reason: 'CPA 池內帳號都用完' },
		{ name: 'auto-oai', provider: 'openai', reason: SECOND_LIMIT_NON_CPA },
		{ name: 'auto-unk', provider: null, reason: SECOND_LIMIT_NON_CPA }
	];
	for (const each of cases) {
		freshRun();
		rmSync(join(dir, 'transcripts'), { recursive: true, force: true });
		rmSync(join(injectDir, 'inject-typed.jsonl'), { force: true });
		rmSync(join(injectDir, 'inject-calls.jsonl'), { force: true });
		codexPlan(each.name);
		const started = await runNow(task.id);
		sessionMeta(each.name, each.provider, each.applied);
		await launchedRun(task.id, each.name);
		userSaid(each.name, '讀取並照做');
		reply(each.name, '正在掃描');
		limitOnScreen(each.name);
		setStatus(each.name, 'listening');
		await eventually(async () => injected().length >= 1, 5_000, `${each.name} continue message`);
		// The continue was read, a turn ran, and it stopped on the usage limit again.
		userSaid(each.name, CONTINUE_MESSAGE);
		setStatus(each.name, 'active');
		await boardPolled();
		// The old error is cleared from the screen, the agent says something, then a new limit shows.
		clearScreen(each.name);
		reply(each.name, '先做了一部分');
		await boardPolled();
		limitOnScreen(each.name);
		setStatus(each.name, 'listening');
		const out = await ended(task.id, started.id);
		expect([each.name, out.status, out.reason]).toEqual([each.name, 'quota', each.reason]);
		expect(injected().length).toBe(1);
		expect(RESUMES()).toEqual([]);
		expect(listed(each.name)).toBe(false);
		if (each.provider !== 'cpa' && !each.applied) expect(out.reason).not.toContain('池內帳號都用完');
		// Never an account note or an account on a new record.
		expect([out.codexAccount, out.accountSwitches]).toEqual([undefined, undefined]);
		fixture.setClock(START + 31 * 60_000 * (cases.indexOf(each) + 1));
	}
});

test('a board restart after the continue went out does not send another one, and the old error still on screen is not a second limit', async () => {
	const task = await create({ limitMinutes: 30 }, { client: 'codex', model: 'gpt-6.1-terra', effort: 'low' });
	codexPlan('auto-rs');
	const started = await runNow(task.id);
	sessionMeta('auto-rs', 'cpa');
	await launchedRun(task.id, 'auto-rs');
	userSaid('auto-rs', '讀取並照做');
	reply('auto-rs', '正在掃描');
	limitOnScreen('auto-rs');
	setStatus('auto-rs', 'listening');
	await eventually(async () => injected().length >= 1, 5_000, 'the continue message');
	await eventually(async () => (await runsOf(task.id))[0].quotaContinue, 5_000, 'the record of the continue');
	await fixture.stop();
	await fixture.start();
	cookie = await fixture.login();
	await sleep(1_200);
	const kept = (await runsOf(task.id)).find((entry) => entry.id === started.id)!;
	expect([kept.status, kept.quotaNotes]).toEqual(['running', ['額度用完，已原地續作']]);
	expect(injected().length).toBe(1);
	// Read, then a new stop shows after the screen cleared: ends as the second.
	userSaid('auto-rs', CONTINUE_MESSAGE);
	setStatus('auto-rs', 'active');
	await boardPolled();
	clearScreen('auto-rs');
	await boardPolled();
	limitOnScreen('auto-rs');
	setStatus('auto-rs', 'listening');
	const out = await ended(task.id, started.id);
	expect([out.status, out.reason]).toEqual(['quota', 'CPA 池內帳號都用完']);
	expect(injected().length).toBe(1);
});

test('an old run record with codexAccount and accountSwitches still reads back as it was written', async () => {
	const task = await create();
	await fixture.stop();
	appendFileSync(
		join(dir, 'board-state/automation/runs', `${task.id}.jsonl`),
		JSON.stringify({ id: 'old-1', taskId: task.id, trigger: 'manual', period: '2026-11', startedAt: START - 3_600_000, endedAt: START - 3_000_000, status: 'success', codexAccount: 1, accountSwitches: ['帳號 1 額度用完，換到 帳號 2'] }) + '\n'
	);
	await fixture.start();
	cookie = await fixture.login();
	const old = (await runsOf(task.id)).find((entry) => entry.id === 'old-1')!;
	expect([old.codexAccount, old.accountSwitches]).toEqual([1, ['帳號 1 額度用完，換到 帳號 2']]);
});

test('a Claude usage limit ends the run as 額度用完 with no account switched, and the next day tries again by itself', async () => {
	// Daily at 12:30; the clock is 12:00 on the 18th.
	const task = await create({ schedule: { type: 'daily' }, time: '12:30' });
	hcomPlan([{ name: 'auto-claude' }, { name: 'auto-next' }]);
	fixture.setClock(START + 30 * 60_000);
	const first = await eventually(async () => (await runsOf(task.id)).find((run) => run.trigger === 'auto' && run.sessionId), 5_000, 'the automatic try');
	reply('auto-claude', "You've hit your limit · resets 3pm (Asia/Taipei)");
	setStatus('auto-claude', 'listening');
	const quota = await ended(task.id, first.id);
	expect(quota.status).toBe('quota');
	expect(quota.reason).toContain('Claude 不換帳號');
	expect(injected()).toEqual([]);
	expect(listed('auto-claude')).toBe(false);
	// Not again the same day…
	await sleep(500);
	expect((await runsOf(task.id)).filter((run) => run.trigger === 'auto')).toHaveLength(1);
	// …but the next day at its time.
	fixture.setClock(tpe(2026, 11, 19, 12, 30));
	const next = await eventually(async () => (await runsOf(task.id)).find((run) => run.trigger === 'auto' && run.id !== first.id), 5_000, 'the next day\'s try');
	expect(next.period).toBe('2026-11-19');
	await send(`/api/automation/${task.id}/stop`, 'POST');
	await ended(task.id, next.id);

	// An agent task's missed days are found like a command task's: the board down all of the 20th.
	rmSync(join(dir, 'hcom-calls.jsonl'), { force: true });
	hcomPlan([{ name: 'auto-21st' }]);
	await fixture.stop();
	fixture.setClock(tpe(2026, 11, 21, 13));
	await fixture.start();
	cookie = await fixture.login();
	const view = await eventually(async () => (await snapshot()).tasks.find((each) => each.task.id === task.id && each.missed.length), 5_000, 'the missed day');
	expect(view.missed.map((entry) => entry.period)).toEqual(['2026-11-20']);
	// And on the first check after the restart (13:00, past the task's 12:30), today's try catches up.
	const today = await eventually(async () => (await runsOf(task.id)).find((run) => run.period === '2026-11-21'), 5_000, 'the try at once');
	await send(`/api/automation/${task.id}/stop`, 'POST');
	await ended(task.id, today.id);
	await send(`/api/automation/${task.id}/pause`, 'POST', { paused: true });
});

test('an unattended task opens a LAT controller whose grant comes from the saved settings: NO REPLY turns go on, DONE ends it; settings with no save behind them are a settings error', async () => {
	const grant = { goal: '處理已知問題', done: ['挑出的票已合併到 dev'], scope: { ticket_confirmation: true, assume_defaults: false, prototype_decide: true } };
	const task = await create({ limitMinutes: 90 }, { unattended: grant });
	expect(task.agent!.unattended).toEqual(grant);
	hcomPlan([{ name: 'auto-lat' }]);
	const started = await runNow(task.id);
	const run = await launchedRun(task.id, 'auto-lat');

	const state = join(dir, 'board-state');
	const launch = hcomCalls().find((call) => call.args[0] === 'claude')!;
	const prompt = launch.args[launch.args.indexOf('--hcom-prompt') + 1];
	expect(prompt.startsWith('/lat 這是看板自動化任務「Agent 任務」開的主控')).toBe(true);
	expect(prompt).toContain(`LAT_BOARD_STATE_DIR=${state} uv run --no-project python ${join(dir, 'home', '.agents/skills/lat/scripts/lat-unattended.py')} create --source board-task --evidence board-task:${started.id}`);
	expect(prompt).toContain(`讀取並照做 ${join(work, 'docs/brief.md')}`);
	expect(prompt).not.toContain('ASK: <問題> 並等待');
	// The device's save and this run's grant, as lat-unattended reads them; the hours are the limit's, rounded up.
	const lines = jsonLines(join(state, 'sent-log.jsonl')) as Record<string, any>[];
	const save = lines.findLast((line) => line.kind === 'automation-task-save' && line.taskId === task.id)!;
	expect(save.unattended).toEqual({ ...grant, maxHours: 2 });
	expect(typeof save.deviceId).toBe('string');
	const logged = lines.find((line) => line.kind === 'unattended-task-run' && line.id === started.id)!;
	expect(logged).toMatchObject({ taskId: task.id, save: save.id, tag: launch.args[launch.args.indexOf('--tag') + 1], ...grant, maxHours: 2 });

	// Waiting on its agents is no verdict; an unattended controller's DECIDE:/HELP: waits on the user (tests/server/automation-ask.test.ts).
	reply('auto-lat', '派出 worker，等它回報。\nNO REPLY: 等 worker');
	setStatus('auto-lat', 'listening');
	await sleep(600);
	expect((await runsOf(task.id))[0]).toMatchObject({ status: 'running' });
	expect((await runsOf(task.id))[0].asks).toBeUndefined();
	setStatus('auto-lat', 'active');
	reply('auto-lat', '回顧頁已核對，已 deactivate。\nDONE');
	setStatus('auto-lat', 'listening');
	expect((await ended(task.id, started.id)).status).toBe('success');
	expect(hcomCalls().some((call) => call.args[0] === 'kill' && call.args[1] === run.agentName)).toBe(true);

	// No save by a signed-in device behind the settings (a task file written by hand): nothing opens.
	const log = join(state, 'sent-log.jsonl');
	writeFileSync(log, readFileSync(log, 'utf8').split('\n').filter((line) => !line.includes('"automation-task-save"')).join('\n'));
	rmSync(join(dir, 'hcom-calls.jsonl'), { force: true });
	const refused = await ended(task.id, (await runNow(task.id)).id);
	expect(refused.status).toBe('config-error');
	expect(refused.reason).toBe('無人模式的設定沒有在看板儲存的紀錄，請在看板打開這個任務重新儲存');
	expect(hcomCalls().some((call) => call.args[0] === 'claude')).toBe(false);
});

test('an unattended task needs a goal and at least one done condition', async () => {
	const response = await send('/api/automation', 'POST', {
		name: '無人',
		schedule: { type: 'daily' },
		time: '03:00',
		limitMinutes: 360,
		kind: 'agent',
		agent: { client: 'claude', model: 'claude-opus-5-5', effort: 'medium', folder: work, brief: 'docs/brief.md', unattended: { goal: ' ', done: '\n ', scope: {} } },
		review: { enabled: false, checklist: [] }
	});
	expect(response.status).toBe(400);
	expect((await response.json()).errors).toEqual({ unattendedGoal: '請填這一輪的目標', unattendedDone: '做完條件至少寫一條' });
});

test('an unattended Codex controller gets the same one continue, then a second usage limit ends the run (#710)', async () => {
	const grant = { goal: '處理已知問題', done: ['挑出的票已合併到 dev'], scope: { ticket_confirmation: true, assume_defaults: true, prototype_decide: true } };
	const task = await create({ limitMinutes: 30 }, { client: 'codex', model: 'gpt-6.1-terra', effort: 'low', unattended: grant });
	freshRun();
	codexPlan('auto-lat-cx');
	const started = await runNow(task.id);
	sessionMeta('auto-lat-cx', 'cpa');
	await launchedRun(task.id, 'auto-lat-cx');
	reply('auto-lat-cx', '正在修 #12');
	limitOnScreen('auto-lat-cx');
	setStatus('auto-lat-cx', 'listening');
	await eventually(async () => injected().length >= 1, 5_000, 'the controller continue message');
	expect(injected()).toEqual([{ text: CONTROLLER_CONTINUE, enter: true }]);
	expect((await runsOf(task.id))[0].status).toBe('running');
	userSaid('auto-lat-cx', CONTROLLER_CONTINUE);
	setStatus('auto-lat-cx', 'active');
	await boardPolled();
	clearScreen('auto-lat-cx');
	reply('auto-lat-cx', '先做一些\nNO REPLY: 等其他 Agent');
	await boardPolled();
	// A controller waiting on its agents with the old error cleared goes on; a new limit then ends it.
	expect((await runsOf(task.id))[0].status).toBe('running');
	limitOnScreen('auto-lat-cx');
	setStatus('auto-lat-cx', 'listening');
	const out = await ended(task.id, started.id);
	expect([out.status, out.reason]).toEqual(['quota', 'CPA 池內帳號都用完']);
	expect(injected().length).toBe(1);
	expect(RESUMES()).toEqual([]);
	expect(listed('auto-lat-cx')).toBe(false);
});
