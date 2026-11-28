// The check before a rerun (#751) on the built board, against the fake hcom, Herdr and helper: when the
// schedule comes to a period whose run failed, a task with a checklist first opens the checking agent on
// that failed run, and its PASS settles the period with no task agent; a FAIL, or a checker that ends
// without a verdict, lets the rerun start. A task with no checklist reads the failed run's conversation:
// a DONE written after the failure settles the period, anything else (no new reply, not DONE, nothing
// readable) reruns. A period's first try opens no checker.
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { jsonLines, sleep, startFixture, type Fixture } from '../harness.ts';
import type { AutomationRun, AutomationSnapshot, AutomationTask } from '../../src/lib/board/automation.ts';
import type { AlertsSnapshot } from '../../src/lib/board/alerts.ts';

const tpe = (year: number, month: number, day: number, hour = 12, minute = 0) => Date.UTC(year, month - 1, day, hour - 8, minute);
const START = tpe(2026, 11, 18, 12);
/** The set time: half an hour after the run started by hand fails. */
const DUE = (day: number) => tpe(2026, 11, day, 12, 30);

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
	for (const name of ['hcom-calls.jsonl', 'hcom.json', 'hcom-added.json']) rmSync(join(dir, name), { force: true });
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
const snapshot = async (): Promise<AutomationSnapshot> => (await authed('/api/automation')).json();
const viewOf = async (id: string) => (await snapshot()).tasks.find((view) => view.task.id === id)!;
const runsOf = async (id: string): Promise<AutomationRun[]> => (await viewOf(id)).runs;
const alerts = async () => ((await (await authed('/api/alerts')).json()) as AlertsSnapshot).alerts;

/** Each hcom call in turn that launches: the name hcom reports, the agent it lists (busy) and the one
 *  Herdr runs; null for the call that closes an agent. */
function hcomPlan(launches: ({ name: string; client?: 'claude' | 'codex' } | null)[]) {
	writeFileSync(
		join(dir, 'hcom.json'),
		JSON.stringify({
			names: launches.map((launch) => launch?.name ?? null),
			agents: [],
			launched: launches.map((launch) => launch && { name: launch.name, session_id: `s-${launch.name}`, status: 'active', tool: launch.client ?? 'claude', launch_context: { pane_id: `wW:p-${launch.name}` } }),
			launchedHerdr: launches.map(
				(launch) =>
					launch && {
						agent: launch.client ?? 'claude',
						agent_status: 'working',
						cwd: work,
						pane_id: `wW:p-${launch.name}`,
						tab_id: `wW:t-${launch.name}`,
						tab_label: launch.name,
						workspace_id: 'wW',
						agent_session: { value: `s-${launch.name}` }
					}
			)
		})
	);
}
function setStatus(name: string, status: string) {
	const file = join(dir, 'hcom-added.json');
	const added = JSON.parse(readFileSync(file, 'utf8'));
	writeFileSync(file, JSON.stringify(added.map((agent: { name: string; base_name?: string }) => (agent.name === name || agent.base_name === name ? { ...agent, status } : agent))));
}
/** A line of `name`'s conversation. */
function say(name: string, kind: 'user' | 'assistant', text: string, time: number | null = null) {
	mkdirSync(join(dir, 'transcripts'), { recursive: true });
	appendFileSync(join(dir, 'transcripts', `s-${name}.jsonl`), JSON.stringify({ kind, time: time === null ? null : new Date(time).toISOString(), text }) + '\n');
}
/** End the turn of `name` with this reply. */
function replyAndWait(name: string, text: string) {
	say(name, 'user', '讀取並照做');
	say(name, 'assistant', text);
	setStatus(name, 'listening');
}
const hcomCalls = () => jsonLines(join(dir, 'hcom-calls.jsonl')) as { args: string[]; workspace: string | null }[];
const launches = (client: 'claude' | 'codex') => hcomCalls().filter((call) => call.args[0] === client);

async function eventually<T>(read: () => Promise<T | undefined | false>, timeoutMs: number, what: string): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(50);
	}
}
/** The task's run once `test` holds for one. */
const runWhere = (id: string, test: (run: AutomationRun) => boolean, what: string) =>
	eventually(async () => (await runsOf(id)).find(test), 8_000, what).catch(async (error) => {
		throw new Error(`${error.message}: ${JSON.stringify(await runsOf(id))}`);
	});

const CHECKLIST = ['ZAP 報告已產生', '報告 PDF 已產生', '通知信已寄出'];

async function create(overrides: Record<string, unknown> = {}): Promise<AutomationTask> {
	const response = await send('/api/automation', 'POST', {
		name: '月度資安檢測',
		schedule: { type: 'monthly', fromDay: 18, toDay: 20 },
		time: '12:30',
		limitMinutes: 60,
		kind: 'agent',
		agent: { client: 'claude', model: 'claude-haiku-5-5', effort: 'low', folder: work, brief: 'docs/brief.md' },
		review: { enabled: true, checklist: CHECKLIST },
		...overrides
	});
	if (response.status !== 201) throw new Error(`create: ${response.status} ${await response.text()}`);
	return response.json();
}
/** A run started by hand whose agent ends its turn on something else than DONE, as the incident's
 *  did (ZAP still running): the run the board judged failed. */
async function failedRun(task: AutomationTask, agent: string): Promise<AutomationRun> {
	const response = await send(`/api/automation/${task.id}/run`, 'POST');
	expect(response.status).toBe(202);
	const started: AutomationRun = await response.json();
	await runWhere(task.id, (run) => run.id === started.id && run.sessionId === `s-${agent}`, `${agent} to be listed`);
	replyAndWait(agent, 'ZAP 和 ClamAV 都還在跑，我等它們跑完再繼續');
	return runWhere(task.id, (run) => run.id === started.id && run.status === 'failed', 'the run to fail');
}
const precheckOf = (id: string, failed: AutomationRun, test: (run: AutomationRun) => boolean, what: string) =>
	runWhere(id, (run) => run.precheck?.of === failed.id && test(run), what);
/** Stop the task's open run and wait until its agent is closed, so no close of it lands in the next test's hcom calls. */
async function stopAndSettle(id: string) {
	await send(`/api/automation/${id}/pause`, 'POST', { paused: true });
	await send(`/api/automation/${id}/stop`, 'POST');
	await eventually(async () => !(await runsOf(id)).some((run) => run.status === 'running' || run.review?.status === 'checking'), 8_000, 'the stop');
	await sleep(300);
}
const PASS = ['1. PASS: output/26.11/26.11full_report.html 在', '2. PASS: PDF 在同一個資料夾', '3. PASS: 對話裡有「寄出 → ...」', 'PASS'].join('\n');

test('a failed period whose results are there: the checker opens on the failed run before the rerun, and its PASS settles the period with no task agent and no card', async () => {
	const task = await create();
	hcomPlan([{ name: 'auto-a' }, null, { name: 'chk-a', client: 'codex' }, null, { name: 'auto-never' }]);
	const failed = await failedRun(task, 'auto-a');
	// The user took the agent back and it finished: no business of the board's until the rerun is due.
	say('auto-a', 'user', '繼續做完');
	say('auto-a', 'assistant', '寄出 → client@example.com\nDONE', START + 20 * 60_000);
	await sleep(400);
	expect(launches('codex')).toHaveLength(0);

	fixture.setClock(DUE(18));
	const checking = await precheckOf(task.id, failed, (run) => run.review?.sessionId === 's-chk-a', 'the checker before the rerun');
	expect(checking).toMatchObject({ trigger: 'auto', precheck: { of: failed.id, by: 'review' }, review: { status: 'checking', client: 'codex' } });
	expect(launches('claude')).toHaveLength(1);
	// Its brief says it is the check before a rerun, of the failed run and its conversation since.
	const brief = readFileSync(join(dir, 'board-state/automation', checking.review!.brief!), 'utf8');
	for (const part of ['這是重跑前的核對，不是檢查剛跑完的一次', '核對「這期的成果是否已經存在」', '## 這期判失敗的那次執行', '看板判它失敗：回合結束，但最後一行不是', `執行任務的 Agent 對話紀錄：${join(dir, 'transcripts/s-auto-a.jsonl')}`, '## 驗收清單', '1. ZAP 報告已產生'])
		expect(brief).toContain(part);
	expect(brief).not.toContain('剛跑完一次，回報成功');
	// It is no day's try: nothing is skipped while it checks.
	expect((await viewOf(task.id)).state).toBe('running');
	await sleep(300);
	expect((await runsOf(task.id)).some((run) => run.status === 'skipped')).toBe(false);

	replyAndWait('chk-a', PASS);
	const passed = await precheckOf(task.id, failed, (run) => run.review?.status === 'pass', 'the PASS');
	expect(passed.status).toBe('success');
	expect(passed.endedAt).toBeNumber();
	const view = await viewOf(task.id);
	expect(view.state).toBe('done');
	// Done this period: the next try is the next period's first day.
	expect(view.nextAt).toBe(tpe(2026, 12, 18, 12, 30));
	await sleep(500);
	expect(launches('claude')).toHaveLength(1);
	expect((await alerts()).some((alert) => alert.runId === passed.id)).toBe(false);
	await send(`/api/automation/${task.id}/pause`, 'POST', { paused: true });
});

test('a checker that judges FAIL, or ends without a verdict, lets the rerun start as usual', async () => {
	const task = await create({ name: '判沒過' });
	hcomPlan([{ name: 'auto-b' }, null, { name: 'chk-b', client: 'codex' }, null, { name: 'auto-b2' }]);
	const failed = await failedRun(task, 'auto-b');
	fixture.setClock(DUE(18));
	await precheckOf(task.id, failed, (run) => run.review?.sessionId === 's-chk-b', 'the checker');
	replyAndWait('chk-b', ['1. PASS: 報告在', '2. FAIL: 找不到 PDF', '3. FAIL: 對話裡沒有寄出那一行', 'FAIL'].join('\n'));
	const skipped = await precheckOf(task.id, failed, (run) => run.review?.status === 'fail', 'the FAIL');
	expect(skipped.status).toBe('skipped');
	const rerun = await runWhere(task.id, (run) => run.sessionId === 's-auto-b2', 'the rerun');
	expect(rerun).toMatchObject({ trigger: 'auto', status: 'running' });
	expect(rerun.precheck).toBeUndefined();
	expect(launches('claude')).toHaveLength(2);
	// A failed check before the rerun makes no card of its own.
	expect((await alerts()).some((alert) => alert.runId === skipped.id)).toBe(false);
	await stopAndSettle(task.id);

	// A checker whose turn ends on neither PASS nor FAIL.
	rmSync(join(dir, 'hcom-calls.jsonl'), { force: true });
	rmSync(join(dir, 'hcom-added.json'), { force: true });
	fixture.setClock(START);
	const other = await create({ name: '檢查沒做完' });
	hcomPlan([{ name: 'auto-c' }, null, { name: 'chk-c', client: 'codex' }, null, { name: 'auto-c2' }]);
	const failedToo = await failedRun(other, 'auto-c');
	fixture.setClock(DUE(18));
	await precheckOf(other.id, failedToo, (run) => run.review?.sessionId === 's-chk-c', 'the checker');
	replyAndWait('chk-c', '我還在看報告');
	const unjudged = await precheckOf(other.id, failedToo, (run) => run.review?.status === 'error', 'the check to end with no verdict');
	expect(unjudged.status).toBe('skipped');
	await runWhere(other.id, (run) => run.sessionId === 's-auto-c2' && !run.precheck, 'the rerun');
	expect(launches('claude')).toHaveLength(2);
	await stopAndSettle(other.id);
});

test('with no checklist, a DONE the failed run’s agent wrote after the failure settles the period with no agent; no new reply, one not DONE, or a record that cannot be read reruns', async () => {
	const task = await create({ name: '沒有清單', review: { enabled: false, checklist: [] } });
	hcomPlan([{ name: 'auto-d' }, null, { name: 'auto-never' }]);
	const failed = await failedRun(task, 'auto-d');
	say('auto-d', 'user', '繼續做完');
	say('auto-d', 'assistant', '報告寄出了\nDONE', START + 20 * 60_000);
	fixture.setClock(DUE(18));
	const passed = await precheckOf(task.id, failed, (run) => run.status === 'success', 'the period to settle');
	expect(passed).toMatchObject({ trigger: 'auto', sessionId: 's-auto-d', precheck: { of: failed.id, by: 'reply', repliedAt: START + 20 * 60_000 } });
	expect(passed.review).toBeUndefined();
	expect((await viewOf(task.id)).state).toBe('done');
	await sleep(500);
	expect(launches('claude')).toHaveLength(1);
	expect(launches('codex')).toHaveLength(0);
	await send(`/api/automation/${task.id}/pause`, 'POST', { paused: true });

	// No reply since the failure (day 18), a new one not DONE (day 19), a record that cannot be read
	// (day 20): each day the rerun starts, and fails again the same way.
	rmSync(join(dir, 'hcom-calls.jsonl'), { force: true });
	rmSync(join(dir, 'hcom-added.json'), { force: true });
	fixture.setClock(START);
	const other = await create({ name: '沒有清單，重跑', review: { enabled: false, checklist: [] } });
	hcomPlan([{ name: 'auto-e' }, null, { name: 'auto-e2' }, null, { name: 'auto-e3' }, null, { name: 'auto-e4' }]);
	const first = await failedRun(other, 'auto-e');
	fixture.setClock(DUE(18));
	const second = await runWhere(other.id, (run) => run.sessionId === 's-auto-e2', 'the rerun after no new reply');
	expect(second.precheck).toBeUndefined();
	replyAndWait('auto-e2', '還沒好');
	await runWhere(other.id, (run) => run.id === second.id && run.status === 'failed', 'the rerun to fail');

	say('auto-e2', 'user', '繼續');
	say('auto-e2', 'assistant', '還在等掃描', DUE(18) + 60 * 60_000);
	fixture.setClock(DUE(19));
	const third = await runWhere(other.id, (run) => run.sessionId === 's-auto-e3', 'the rerun after a reply not DONE');
	replyAndWait('auto-e3', '還沒好');
	await runWhere(other.id, (run) => run.id === third.id && run.status === 'failed', 'the rerun to fail');

	say('auto-e3', 'user', '繼續');
	say('auto-e3', 'assistant', 'DONE', DUE(19) + 60 * 60_000);
	writeFileSync(join(dir, 'transcripts/s-auto-e3.fail'), '紀錄檔讀不到');
	fixture.setClock(DUE(20));
	await runWhere(other.id, (run) => run.sessionId === 's-auto-e4', 'the rerun after a record that cannot be read');
	expect((await runsOf(other.id)).filter((run) => run.precheck)).toEqual([]);
	expect(first.status).toBe('failed');
	await stopAndSettle(other.id);
});

test('a period’s first try opens no checker', async () => {
	const task = await create({ name: '第一次' });
	hcomPlan([{ name: 'auto-f' }]);
	fixture.setClock(DUE(18));
	const run = await runWhere(task.id, (each) => each.sessionId === 's-auto-f', 'the first try');
	expect(run).toMatchObject({ trigger: 'auto', status: 'running' });
	expect(run.precheck).toBeUndefined();
	expect(launches('codex')).toHaveLength(0);
	expect(launches('claude')).toHaveLength(1);
	await stopAndSettle(task.id);
});

test('a run that finished but whose check ended without a pass is checked again before its rerun', async () => {
	const task = await create({ name: '檢查沒過的那次' });
	hcomPlan([{ name: 'auto-g' }, null, { name: 'chk-g', client: 'codex' }, null, { name: 'chk-g2', client: 'codex' }, null, { name: 'auto-never' }]);
	const response = await send(`/api/automation/${task.id}/run`, 'POST');
	const started: AutomationRun = await response.json();
	await runWhere(task.id, (run) => run.id === started.id && run.sessionId === 's-auto-g', 'auto-g to be listed');
	replyAndWait('auto-g', '掃描開始了\nDONE');
	await runWhere(task.id, (run) => run.id === started.id && run.review?.sessionId === 's-chk-g', 'the first checker');
	replyAndWait('chk-g', '報告還沒產生，我等一下再看');
	const unchecked = await runWhere(task.id, (run) => run.id === started.id && run.review?.status === 'error', 'the check to end with no verdict');
	expect(unchecked.status).toBe('success');

	fixture.setClock(DUE(18));
	const checking = await precheckOf(task.id, unchecked, (run) => run.review?.sessionId === 's-chk-g2', 'the checker before the rerun');
	const brief = readFileSync(join(dir, 'board-state/automation', checking.review!.brief!), 'utf8');
	expect(brief).toContain('看板判它跑完，但檢查沒有做完');
	replyAndWait('chk-g2', PASS);
	await precheckOf(task.id, unchecked, (run) => run.status === 'success' && run.review?.status === 'pass', 'the PASS');
	expect((await viewOf(task.id)).state).toBe('done');
	await sleep(500);
	expect(launches('claude')).toHaveLength(1);
	await send(`/api/automation/${task.id}/pause`, 'POST', { paused: true });
});
