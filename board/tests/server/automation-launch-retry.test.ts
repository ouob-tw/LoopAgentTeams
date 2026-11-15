// A checker (or task agent) launch that hcom fails on `database is locked` (#657), on the built board
// against the fake hcom: the half-opened agent is cleaned, the launch is retried (waits shortened to
// 0.2 s here), the retried checker is tracked and judged as usual, exactly one agent of its tag is
// listed afterwards, and four locks in a row fail the check naming the three retries and the last error.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { jsonLines, sleep, startFixture, type Fixture } from '../harness.ts';
import type { AutomationRun, AutomationSnapshot, AutomationTask } from '../../src/lib/board/automation.ts';

const tpe = (year: number, month: number, day: number, hour = 12, minute = 0) => Date.UTC(year, month - 1, day, hour - 8, minute);
const START = tpe(2026, 11, 18, 12);
const CHECKLIST = ['報告 PDF 已產生', '發票已開立'];

let fixture: Fixture;
let cookie: string;
let work: string;
let dir: string;

beforeAll(async () => {
	fixture = await startFixture({
		env: {
			TZ: 'UTC',
			LAT_BOARD_AUTOMATION_TICK_SECONDS: '0.1',
			LAT_BOARD_AUTOMATION_AGENT_POLL_SECONDS: '0.1',
			LAT_BOARD_AUTOMATION_LAUNCH_RETRY_WAITS_SECONDS: '0.2,0.2,0.2',
			LAT_BOARD_LAUNCH_WAIT_SECONDS: '3',
			LAT_BOARD_HCOM_TIMEOUT_SECONDS: '3'
		}
	});
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
	for (const name of ['hcom-calls.jsonl', 'hcom.json', 'hcom-added.json', 'hcom-locked-count.txt']) rmSync(join(dir, name), { force: true });
	writeFileSync(
		join(dir, 'herdr.json'),
		JSON.stringify({
			workspaces: [
				{ workspace_id: 'wW', number: 1, label: 'Work' },
				{ workspace_id: 'wA', number: 2, label: 'AUTOMATION' }
			],
			tabs: [{ tab_id: 'wW:t0', label: 'shell', workspace_id: 'wW' }],
			panes: [{ pane_id: 'wW:p0', workspace_id: 'wW', cwd: work, tab_id: 'wW:t0' }],
			agents: []
		})
	);
});

async function authed(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
	const response = await fixture.fetch(path, { ...init, cookie });
	if (response.status !== 401) return response;
	cookie = await fixture.login();
	return fixture.fetch(path, { ...init, cookie });
}
const send = (path: string, method: string, body?: unknown) =>
	authed(path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const runsOf = async (id: string): Promise<AutomationRun[]> => (((await (await authed('/api/automation')).json()) as AutomationSnapshot).tasks.find((view) => view.task.id === id)!).runs;

/** Launch plan by hcom call number (the fake counts every call, kills included): `slots[n]` is what call n+1 lists, null for none. */
function hcomPlan(slots: ({ name: string; client?: 'claude' | 'codex' } | null)[], launchLocked: { tagPrefix: string; times: number }) {
	writeFileSync(
		join(dir, 'hcom.json'),
		JSON.stringify({
			names: slots.map((slot) => slot?.name ?? null),
			agents: [],
			launchLocked,
			launched: slots.map((slot) => slot && { name: slot.name, session_id: `s-${slot.name}`, status: 'active', tool: slot.client ?? 'claude', launch_context: { pane_id: `wW:p-${slot.name}` } }),
			launchedHerdr: slots.map(
				(slot) =>
					slot && {
						agent: slot.client ?? 'claude',
						agent_status: 'working',
						cwd: work,
						pane_id: `wW:p-${slot.name}`,
						tab_id: `wW:t-${slot.name}`,
						tab_label: slot.name,
						workspace_id: 'wW',
						agent_session: { value: `s-${slot.name}` }
					}
			)
		})
	);
}
function replyAndWait(name: string, text: string) {
	mkdirSync(join(dir, 'transcripts'), { recursive: true });
	appendFileSync(join(dir, 'transcripts', `s-${name}.jsonl`), JSON.stringify({ kind: 'user', time: null, text: '讀取並照做' }) + '\n');
	appendFileSync(join(dir, 'transcripts', `s-${name}.jsonl`), JSON.stringify({ kind: 'assistant', time: null, text }) + '\n');
	const file = join(dir, 'hcom-added.json');
	const added = JSON.parse(readFileSync(file, 'utf8'));
	writeFileSync(file, JSON.stringify(added.map((agent: { name: string; base_name?: string }) => (agent.name === name || agent.base_name === name ? { ...agent, status: 'listening' } : agent))));
}
const hcomCalls = () => jsonLines(join(dir, 'hcom-calls.jsonl')) as { args: string[] }[];
const tagOf = (call: { args: string[] }) => call.args[call.args.indexOf('--tag') + 1];
const addedAgents = () => (existsSync(join(dir, 'hcom-added.json')) ? (JSON.parse(readFileSync(join(dir, 'hcom-added.json'), 'utf8')) as { name: string; tag?: string }[]) : []);

async function eventually<T>(read: () => Promise<T | undefined | false>, timeoutMs: number, what: string): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(50);
	}
}
const runWhen = (id: string, runId: string, test: (run: AutomationRun) => boolean, what: string) =>
	eventually(async () => (await runsOf(id)).find((run) => run.id === runId && test(run)), 8_000, what).catch(async (error) => {
		throw new Error(`${error.message}: ${JSON.stringify((await runsOf(id)).find((run) => run.id === runId))}`);
	});

async function create(): Promise<AutomationTask> {
	const response = await send('/api/automation', 'POST', {
		name: '展覽維護報告',
		schedule: { type: 'monthly', fromDay: 1, toDay: 2 },
		time: '02:00',
		limitMinutes: 30,
		kind: 'agent',
		agent: { client: 'claude', model: 'claude-haiku-5-5', effort: 'low', folder: work, brief: 'docs/brief.md' },
		review: { enabled: true, checklist: CHECKLIST }
	});
	if (response.status !== 201) throw new Error(`create: ${response.status} ${await response.text()}`);
	return response.json();
}
/** Start the task and end its agent with DONE: its checker is then launched. */
async function doneAndChecking(task: AutomationTask): Promise<AutomationRun> {
	const response = await send(`/api/automation/${task.id}/run`, 'POST');
	expect(response.status).toBe(202);
	const started = (await response.json()) as AutomationRun;
	await runWhen(task.id, started.id, (run) => run.sessionId === 's-auto-a', 'auto-a to be listed');
	replyAndWait('auto-a', '報告做好了\nDONE');
	return started;
}

test('a checker launch that hcom fails once on the database lock is cleaned, retried, tracked and judged; one agent of its tag is left', async () => {
	const task = await create();
	// Calls: 1 task agent, 2 its close, 3 checker (locked, leaves a half-opened agent), 4 that agent's cleanup, 5 the retry.
	hcomPlan([{ name: 'auto-a' }, null, null, null, { name: 'chk-a', client: 'codex' }], { tagPrefix: 'autochk-', times: 1 });
	const started = await doneAndChecking(task);
	await runWhen(task.id, started.id, (run) => run.review?.sessionId === 's-chk-a', 'the retried checker to be tracked');
	replyAndWait('chk-a', ['1. PASS: out/report.pdf 存在', '2. PASS: 發票號碼 A-1', 'PASS'].join('\n'));
	const done = await runWhen(task.id, started.id, (run) => run.review !== undefined && run.review.status !== 'checking', 'the verdict');
	expect(done.review).toMatchObject({ status: 'pass', agentName: expect.stringContaining('chk-a') });
	const launches = hcomCalls().filter((call) => call.args[0] === 'codex');
	expect(launches).toHaveLength(2);
	expect(hcomCalls().filter((call) => call.args[0] === 'kill').map((call) => call.args[1])).toContain(`${tagOf(launches[0]!)}-half1`);
	expect(addedAgents().filter((agent) => agent.tag === tagOf(launches[0]!))).toHaveLength(0);
});

test('four locks in a row launch the checker four times and fail the check naming three retries and the last error', async () => {
	const task = await create();
	hcomPlan([{ name: 'auto-a' }, null], { tagPrefix: 'autochk-', times: 4 });
	const started = await doneAndChecking(task);
	const done = await runWhen(task.id, started.id, (run) => run.review?.status === 'error', 'the check to fail');
	expect(done.review!.reason).toContain('已重試 3 次');
	expect(done.review!.reason).toContain('attempt 4');
	expect(done.review!.reason).not.toContain('attempt 3');
	const launches = hcomCalls().filter((call) => call.args[0] === 'codex');
	expect(launches).toHaveLength(4);
	expect(addedAgents().filter((agent) => agent.tag === tagOf(launches[0]!))).toHaveLength(0);
});
