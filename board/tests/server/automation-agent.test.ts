// Agent tasks' runs on the built board, against the fake hcom, Herdr, helper and codex-multi-auth:
// the agent opens through the new-agent launch flow with the fixed first message and the run's tag,
// shows in the board's agent list, and is judged by the last line of its last reply alone (DONE,
// FAILED: <reason>, anything else); every outcome closes it the board's way. 停止這次 and the limit
// close it too. A restart watches on while hcom lists the agent, with the limit from the original
// start, and fails the run when it is gone. Codex: an account at 0 before launch is swapped for a
// subscription account with quota (probed), never an API one, never a reset; a usage limit mid-run
// is checked live, the agent killed, the account switched and probed and the same conversation
// resumed; no account left is 額度用完. A Claude usage limit is 額度用完 with no switch. A task whose
// run ran out of quota tries again the next day. Nothing here starts a real agent or touches a real account.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { jsonLines, sleep, startFixture, until, type Fixture } from '../harness.ts';
import type { AutomationRun, AutomationSnapshot, AutomationTask } from '../../src/lib/board/automation.ts';

/** A wall-clock time in Asia/Taipei. */
const tpe = (year: number, month: number, day: number, hour = 12, minute = 0) => Date.UTC(year, month - 1, day, hour - 8, minute);
const START = tpe(2026, 11, 18, 12);

let fixture: Fixture;
let cookie: string;
let work: string;
let dir: string;

beforeAll(async () => {
	fixture = await startFixture({ env: { TZ: 'UTC', LAT_BOARD_AUTOMATION_TICK_SECONDS: '0.1', LAT_BOARD_AUTOMATION_AGENT_POLL_SECONDS: '0.1', LAT_BOARD_LAUNCH_WAIT_SECONDS: '3', LAT_BOARD_HCOM_TIMEOUT_SECONDS: '3' } });
	dir = fixture.dir;
	fixture.setClock(START);
	work = join(dir, 'work');
	mkdirSync(join(work, 'docs'), { recursive: true });
	writeFileSync(join(work, 'docs/brief.md'), '# 任務\n');
	cookie = await fixture.login();
});
afterAll(async () => {
	await fixture.cleanup();
});
beforeEach(() => {
	fixture.setClock(START);
	for (const name of ['hcom-calls.jsonl', 'hcom.json', 'hcom-added.json', 'codex-auth.json', 'codex-auth-calls.jsonl', 'codex-auth-pinned.txt']) rmSync(join(dir, name), { force: true });
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
function herdrPlan() {
	writeFileSync(
		join(dir, 'herdr.json'),
		JSON.stringify({
			workspaces: [{ workspace_id: 'wW', number: 1, label: 'Work' }],
			tabs: [{ tab_id: 'wW:t0', label: 'shell', workspace_id: 'wW' }],
			panes: [{ pane_id: 'wW:p0', workspace_id: 'wW', cwd: work, tab_id: 'wW:t0' }],
			agents: []
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
				workspace_id: 'wW',
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
	writeFileSync(file, JSON.stringify(added.map((agent: { name: string }) => (agent.name === name ? { ...agent, status } : agent))));
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
const authCalls = () => jsonLines(join(dir, 'codex-auth-calls.jsonl')) as string[][];
const listed = (name: string) => existsSync(join(dir, 'hcom-added.json')) && JSON.parse(readFileSync(join(dir, 'hcom-added.json'), 'utf8')).some((agent: { name: string }) => agent.name === name);

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
	expect(run.agentName).toBe('auto-one');

	const launch = hcomCalls().find((call) => call.args[0] === 'claude')!;
	const brief = join(work, 'docs/brief.md');
	const prompt = launch.args[launch.args.indexOf('--hcom-prompt') + 1];
	expect(prompt).toBe(`讀取並照做 ${brief}，完成後最後一行只回覆 DONE，失敗回覆 FAILED: <原因>`);
	const tag = launch.args[launch.args.indexOf('--tag') + 1];
	expect(tag).toBe(`auto-${task.id}-${started.id.split('-').at(-1)!.slice(0, 6)}`);
	expect(launch.args.slice(launch.args.indexOf('--dir'), launch.args.indexOf('--dir') + 2)).toEqual(['--dir', work]);
	expect(launch.args).toEqual(expect.arrayContaining(['--model', 'claude-haiku-5-5', '--effort', 'low', '--dangerously-skip-permissions']));
	expect(launch.workspace).toBe('wW');
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
	expect(hcomCalls().some((call) => call.args[0] === 'kill' && call.args[1] === 'auto-one')).toBe(true);
	expect(listed('auto-one')).toBe(false);
	expect((await snapshot()).tasks.find((view) => view.task.id === task.id)!.state).toBe('done');
});

test('FAILED records its reason; a turn that ends on neither fails; only the last line of the last reply counts; each closes the agent', async () => {
	const task = await create();
	const cases: [string, string[], string, string][] = [
		['auto-fail', ['FAILED: 找不到 ZAP 報告'], 'failed', 'Agent 回覆失敗：找不到 ZAP 報告'],
		['auto-none', ['我做完了，但有點問題'], 'failed', '回合結束，但最後一行不是 DONE 或 FAILED：我做完了，但有點問題'],
		['auto-mid', ['DONE\n其實還差一步'], 'failed', '回合結束，但最後一行不是 DONE 或 FAILED：其實還差一步'],
		['auto-old', ['DONE', '等一下，還沒好'], 'failed', '回合結束，但最後一行不是 DONE 或 FAILED：等一下，還沒好'],
		// A reply that only mentions a usage limit is no quota error.
		['auto-usage', ['網站的 usage limit 是每分鐘 60 次'], 'failed', '回合結束，但最後一行不是 DONE 或 FAILED：網站的 usage limit 是每分鐘 60 次']
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

test('a Codex run on a pinned account at 0 switches to a subscription account with quota and probes it first; none left is 額度用完 with no agent', async () => {
	const task = await create({}, { client: 'codex', model: 'gpt-6.1-terra', effort: 'low' });
	// Account 1 (pinned) is at 0, 2 is an API account, 3 at 0 too, 4 has quota.
	writeFileSync(join(dir, 'codex-auth.json'), JSON.stringify({ pinned: 0, accounts: [{ index: 0, used: 100 }, { index: 1, used: 0, kind: 'api' }, { index: 2, used: 100 }, { index: 3, used: 40 }] }));
	hcomPlan([{ name: 'auto-codex', client: 'codex' }]);
	const started = await runNow(task.id);
	const run = await launchedRun(task.id, 'auto-codex');
	expect(authCalls()).toEqual([
		['limits', '--json', '--refresh'],
		['switch', '3'],
		['limits', '--json', '--refresh'],
		['exec', '-m', 'gpt-6.1-terra', '-c', 'model_reasoning_effort="low"', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', 'Reply with OK only.']
	]);
	expect(run.accountSwitches).toEqual(['帳號 1 額度用完，換到 帳號 4']);
	const launch = hcomCalls().find((call) => call.args[0] === 'codex')!;
	expect(launch.args).toEqual(expect.arrayContaining(['-c', 'model="gpt-6.1-terra"', '-c', 'model_reasoning_effort="low"']));
	reply('auto-codex', 'DONE');
	setStatus('auto-codex', 'listening');
	expect((await ended(task.id, started.id)).status).toBe('success');

	// Every subscription account at 0, or failing its probe: nothing starts.
	rmSync(join(dir, 'hcom-calls.jsonl'), { force: true });
	rmSync(join(dir, 'codex-auth-pinned.txt'), { force: true });
	writeFileSync(join(dir, 'codex-auth-calls.jsonl'), '');
	writeFileSync(
		join(dir, 'codex-auth.json'),
		JSON.stringify({ pinned: 0, accounts: [{ index: 0, used: 100 }, { index: 1, used: 10 }, { index: 2, used: 0, kind: 'api' }], probe: { '1': { exit: 1, stdout: 'error: model is not supported' } } })
	);
	const second = await runNow(task.id);
	const quota = await ended(task.id, second.id);
	expect(quota.status).toBe('quota');
	expect(quota.reason).toContain('額度用完');
	expect(hcomCalls().filter((call) => call.args[0] === 'codex')).toEqual([]);
	expect(authCalls().map((call) => call[0])).toEqual(['limits', 'switch', 'limits', 'exec']);
	expect(authCalls().flat().join(' ')).not.toContain('reset');
});

/** Codex shows its usage limit on the agent's screen. */
function limitOnScreen(name: string) {
	const plan = JSON.parse(readFileSync(join(dir, 'herdr.json'), 'utf8'));
	writeFileSync(join(dir, 'herdr.json'), JSON.stringify({ ...plan, screens: { ...plan.screens, [`wW:p-${name}`]: ["■ You've hit your usage limit. Upgrade to Pro or try again at 3:00 PM.\n› "] } }));
}
const accounts = (pinned: number, ...used: number[]) =>
	writeFileSync(join(dir, 'codex-auth.json'), JSON.stringify({ pinned, accounts: used.map((value, index) => ({ index, used: value })) }));
/** A Codex launch whose resume comes back as the same agent in a new pane. */
function codexPlan(name: string) {
	hcomPlan([{ name, client: 'codex' }], {
		resumed: { name, session_id: `s-${name}`, status: 'active', tool: 'codex', launch_context: { pane_id: `wW:p-${name}-2` } },
		resumedHerdr: { agent: 'codex', agent_status: 'working', cwd: work, pane_id: `wW:p-${name}-2`, tab_id: `wW:t-${name}-2`, workspace_id: 'wW', agent_session: { value: `s-${name}` } }
	});
}
function freshRun() {
	for (const name of ['hcom-calls.jsonl', 'hcom-added.json', 'codex-auth-pinned.txt', 'codex-auth-calls.jsonl']) rmSync(join(dir, name), { force: true });
	herdrPlan();
}

test('a Codex usage limit mid-run is checked live on the agent\'s own account: quota back there resumes it, another pin does nothing', async () => {
	const task = await create({ limitMinutes: 30 }, { client: 'codex', model: 'gpt-6.1-terra', effort: 'low' });
	accounts(0, 20, 30);
	codexPlan('auto-back');
	const started = await runNow(task.id);
	expect((await launchedRun(task.id, 'auto-back')).codexAccount).toBe(0);
	userSaid('auto-back', '讀取並照做');
	reply('auto-back', '正在掃描');
	limitOnScreen('auto-back');
	// Someone pinned account 2 meanwhile; the agent's own account 1 is not at 0: nothing confirmed, nothing done.
	writeFileSync(join(dir, 'codex-auth-pinned.txt'), '1');
	setStatus('auto-back', 'listening');
	await eventually(async () => authCalls().length >= 2, 5_000, 'the live check');
	await sleep(500);
	expect(authCalls()).toEqual([['limits', '--json', '--refresh'], ['limits', '--json', '--refresh']]);
	expect(hcomCalls().filter((call) => call.args[0] !== 'codex')).toEqual([]);
	expect((await runsOf(task.id))[0].status).toBe('running');

	// Five minutes on, account 1 is pinned again with quota: resumed on it, no switch.
	rmSync(join(dir, 'codex-auth-pinned.txt'));
	fixture.setClock(START + 5 * 60_000);
	const resumed = await eventually(async () => hcomCalls().find((call) => call.args[0] === 'r'), 8_000, 'the resume');
	expect(resumed.args.slice(0, 2)).toEqual(['r', 's-auto-back']);
	expect(authCalls().map((call) => call[0])).toEqual(['limits', 'limits', 'limits']);
	await sleep(300);
	expect((await runsOf(task.id))[0].accountSwitches).toEqual(['帳號 1 額度已恢復，接回續作']);
	reply('auto-back', '續作完成\nDONE');
	setStatus('auto-back', 'listening');
	expect((await ended(task.id, started.id)).status).toBe('success');
});

test('a Codex usage limit mid-run at 0: the agent killed, another account probed, the same conversation resumed, the limit still from the start; none left is 額度用完', async () => {
	const task = await create({ limitMinutes: 30 }, { client: 'codex', model: 'gpt-6.1-terra', effort: 'low' });
	freshRun();
	accounts(0, 20, 30);
	codexPlan('auto-limit');
	const started = await runNow(task.id);
	await launchedRun(task.id, 'auto-limit');
	userSaid('auto-limit', '讀取並照做');
	reply('auto-limit', '正在掃描，已掃 38 / 64 頁');
	accounts(0, 100, 30);
	limitOnScreen('auto-limit');
	setStatus('auto-limit', 'listening');

	const resumed = await eventually(async () => hcomCalls().find((call) => call.args[0] === 'r'), 8_000, 'the resume');
	expect(resumed.args.slice(0, 2)).toEqual(['r', 's-auto-limit']);
	expect(resumed.args[resumed.args.indexOf('--hcom-prompt') + 1]).toContain('已換帳號接回');
	expect(resumed.workspace).toBe('wW');
	const kill = hcomCalls().findIndex((call) => call.args[0] === 'kill');
	expect(kill).toBeGreaterThan(-1);
	expect(kill).toBeLessThan(hcomCalls().findIndex((call) => call.args[0] === 'r'));
	expect(authCalls().map((call) => call[0])).toEqual(['limits', 'limits', 'switch', 'limits', 'exec']);
	expect(authCalls()[2]).toEqual(['switch', '1']);
	// The old reply is not the verdict while the resumed turn runs.
	await sleep(500);
	const going = (await runsOf(task.id))[0];
	expect(going.status).toBe('running');
	expect(going.accountSwitches).toEqual(['帳號 1 額度用完，換到 帳號 2']);
	expect(going.codexAccount).toBe(1);
	// The switch does not give it more time: 30 minutes from its start, it is over.
	fixture.setClock(START + 30 * 60_000);
	const late = await ended(task.id, started.id);
	expect([late.status, late.reason]).toEqual(['timeout', '超過上限 30 分鐘，已停止']);
	expect(listed('auto-limit')).toBe(false);

	// No other account left: stopped, closed, 額度用完.
	fixture.setClock(START + 31 * 60_000);
	freshRun();
	accounts(0, 20, 100);
	hcomPlan([{ name: 'auto-out', client: 'codex' }]);
	const second = await runNow(task.id);
	await launchedRun(task.id, 'auto-out');
	accounts(0, 100, 100);
	limitOnScreen('auto-out');
	setStatus('auto-out', 'listening');
	const out = await ended(task.id, second.id);
	expect([out.status, out.reason]).toEqual(['quota', '額度用完：沒有其他還有額度的訂閱帳號']);
	expect(listed('auto-out')).toBe(false);
	expect(hcomCalls().some((call) => call.args[0] === 'r')).toBe(false);
	expect(authCalls().flat().join(' ')).not.toContain('reset');
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
	expect(authCalls()).toEqual([]);
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
	fixture.setClock(tpe(2026, 11, 21, 9));
	await fixture.start();
	cookie = await fixture.login();
	const view = await eventually(async () => (await snapshot()).tasks.find((each) => each.task.id === task.id && each.missed.length), 5_000, 'the missed day');
	expect(view.missed.map((entry) => entry.period)).toEqual(['2026-11-20']);
	// And on the first check after the restart, today's try starts at once.
	const today = await eventually(async () => (await runsOf(task.id)).find((run) => run.period === '2026-11-21'), 5_000, 'the try at once');
	await send(`/api/automation/${task.id}/stop`, 'POST');
	await ended(task.id, today.id);
	await send(`/api/automation/${task.id}/pause`, 'POST', { paused: true });
});
