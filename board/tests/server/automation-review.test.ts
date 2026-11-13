// The checking agent (跑完後請 Agent 檢查) on the built board, against the fake hcom, Herdr, helper and
// codex-multi-auth: a run that succeeded with the switch on opens a read-only checker (by default the
// other client than the task's agent), whose brief carries the limits, the checklist and where the run's
// conversation or output is; its reply is judged item by item (PASS／FAIL with reasons), a FAIL makes
// the run 檢查未過 with a red card and leaves the period not done. While it checks the task counts as
// running: neither the schedule nor 立即執行 starts it again. A failed run opens no checker. The
// checker has the task's limit, 停止這次, the restart and the Codex quota handled as a task's agent's.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { jsonLines, sleep, startFixture, type Fixture } from '../harness.ts';
import type { AutomationRun, AutomationSnapshot, AutomationTask } from '../../src/lib/board/automation.ts';
import type { AlertsSnapshot } from '../../src/lib/board/alerts.ts';

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
 *  Herdr runs. The fake counts every call, so a task's agent and its checker sit either side of the
 *  call that closes the agent (null). */
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
/** End the turn of `name` with this reply. */
function replyAndWait(name: string, text: string) {
	mkdirSync(join(dir, 'transcripts'), { recursive: true });
	appendFileSync(join(dir, 'transcripts', `s-${name}.jsonl`), JSON.stringify({ kind: 'user', time: null, text: '讀取並照做' }) + '\n');
	appendFileSync(join(dir, 'transcripts', `s-${name}.jsonl`), JSON.stringify({ kind: 'assistant', time: null, text }) + '\n');
	setStatus(name, 'listening');
}
const hcomCalls = () => jsonLines(join(dir, 'hcom-calls.jsonl')) as { args: string[]; workspace: string | null }[];
const listed = (name: string) =>
	existsSync(join(dir, 'hcom-added.json')) && JSON.parse(readFileSync(join(dir, 'hcom-added.json'), 'utf8')).some((agent: { name: string; base_name?: string }) => agent.name === name || agent.base_name === name);

async function eventually<T>(read: () => Promise<T | undefined | false>, timeoutMs: number, what: string): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(50);
	}
}
/** The run once `test` holds for it. */
const runWhen = (id: string, runId: string, test: (run: AutomationRun) => boolean, what: string) =>
	eventually(async () => (await runsOf(id)).find((run) => run.id === runId && test(run)), 8_000, what).catch(async (error) => {
		throw new Error(`${error.message}: ${JSON.stringify((await runsOf(id)).find((run) => run.id === runId))}`);
	});
const checkerListed = (id: string, runId: string, name: string) => runWhen(id, runId, (run) => run.review?.sessionId === `s-${name}`, `the checker ${name} to be listed`);
const checked = (id: string, runId: string) => runWhen(id, runId, (run) => run.review !== undefined && run.review.status !== 'checking', 'the check to end');

const CHECKLIST = ['報告 PDF 已產生', '發票已開立', '通知信已寄出'];

async function create(overrides: Record<string, unknown> = {}): Promise<AutomationTask> {
	const response = await send('/api/automation', 'POST', {
		name: '展覽維護報告',
		schedule: { type: 'monthly', fromDay: 1, toDay: 2 },
		time: '02:00',
		limitMinutes: 30,
		kind: 'agent',
		agent: { client: 'claude', model: 'claude-haiku-5-5', effort: 'low', folder: work, brief: 'docs/brief.md' },
		review: { enabled: true, checklist: CHECKLIST },
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
/** Run the task's agent to DONE; the run once its checker is listed. */
async function doneThenChecking(task: AutomationTask, agent: string, checker: string): Promise<AutomationRun> {
	const started = await runNow(task.id);
	await runWhen(task.id, started.id, (run) => run.sessionId === `s-${agent}`, `${agent} to be listed`);
	replyAndWait(agent, '報告做好了\nDONE');
	return checkerListed(task.id, started.id, checker);
}

test('a run that succeeded opens a read-only checker of the other client; FAIL is 檢查未過 item by item, with a red card, and the period stays open', async () => {
	// Daily at 12:30 and started by hand at 12:00: the try due at 12:30 comes while the checker checks.
	const task = await create({ schedule: { type: 'daily' }, time: '12:30', limitMinutes: 60 });
	expect(task.review).toMatchObject({ enabled: true, client: 'codex', checklist: CHECKLIST });
	hcomPlan([{ name: 'auto-a' }, null, { name: 'chk-a', client: 'codex' }]);
	const run = await doneThenChecking(task, 'auto-a', 'chk-a');
	expect(run.status).toBe('success');
	expect(run.review).toMatchObject({ status: 'checking', client: 'codex', model: 'gpt-6.1-sol', effort: 'medium' });
	// The task's own agent is closed before the checker starts.
	expect(listed('auto-a')).toBe(false);

	const launch = hcomCalls().find((call) => call.args[0] === 'codex')!;
	const brief = join(dir, 'board-state/automation', run.review!.brief!);
	expect(launch.args[launch.args.indexOf('--hcom-prompt') + 1]).toBe(`讀取並照做 ${brief}：你是只讀的檢查 Agent，不得修改檔案、不得寄送或開票。照說明檔的格式逐條判定，最後一行只回覆 PASS 或 FAIL`);
	expect(launch.args[launch.args.indexOf('--tag') + 1]).toBe(`autochk-${task.id}-${run.id.split('-').at(-1)!.slice(0, 6)}`);
	expect(launch.args.slice(launch.args.indexOf('--dir'), launch.args.indexOf('--dir') + 2)).toEqual(['--dir', work]);
	// In the AUTOMATION workspace, as the task's own agent.
	expect(launch.workspace).toBe('wA');
	expect(run.review!.agentWorkspace).toBe('wA');
	expect(launch.args).toEqual(expect.arrayContaining(['-c', 'model="gpt-6.1-sol"', '-c', 'model_reasoning_effort="medium"']));
	const text = readFileSync(brief, 'utf8');
	for (const rule of ['只讀：不得修改、新增、刪除或搬移任何檔案', '不得寄送任何東西', '不得開票']) expect(text).toContain(rule);
	for (const [index, item] of CHECKLIST.entries()) expect(text).toContain(`${index + 1}. ${item}`);
	expect(text).toContain(`任務說明檔：${join(work, 'docs/brief.md')}`);
	expect(text).toContain(`執行任務的 Agent 對話紀錄：${join(dir, 'transcripts/s-auto-a.jsonl')}`);

	// Checking is still running: the list says so, 立即執行 is refused and the try due now is skipped.
	expect((await viewOf(task.id)).state).toBe('running');
	expect((await send(`/api/automation/${task.id}/run`, 'POST')).status).toBe(409);
	fixture.setClock(tpe(2026, 11, 18, 12, 30));
	const skip = await eventually(async () => (await runsOf(task.id)).find((each) => each.status === 'skipped'), 5_000, 'the skipped try');
	expect([skip.trigger, skip.reason]).toEqual(['auto', '上一次還在跑']);
	expect(hcomCalls().filter((call) => call.args[0] === 'claude')).toHaveLength(1);

	replyAndWait('chk-a', ['1. PASS: out/report.pdf 存在，12 頁', '2. FAIL: 報告裡沒有發票號碼，也找不到開立紀錄', '3. PASS: 寄信紀錄有 250 OK', 'FAIL'].join('\n'));
	const done = await checked(task.id, run.id);
	expect(done.review).toMatchObject({
		status: 'fail',
		items: [
			{ label: '報告 PDF 已產生', ok: true, reason: 'out/report.pdf 存在，12 頁' },
			{ label: '發票已開立', ok: false, reason: '報告裡沒有發票號碼，也找不到開立紀錄' },
			{ label: '通知信已寄出', ok: true, reason: '寄信紀錄有 250 OK' }
		]
	});
	expect(listed('chk-a')).toBe(false);
	const view = await viewOf(task.id);
	expect(view.state).toBe('check-failed');
	// Not done: tomorrow's try is still due.
	expect(view.nextAt).toBe(tpe(2026, 11, 19, 12, 30));
	const card = (await alerts()).find((alert) => alert.runId === run.id);
	expect(card).toMatchObject({ kind: 'check-failed', summary: '跑完了，但檢查沒過' });
	await send(`/api/automation/${task.id}/pause`, 'POST', { paused: true });
});

test('PASS settles the period with no card; a PASS over an item judged FAIL or left out does not; a failed run opens no checker; a command task is checked on its output', async () => {
	const task = await create();
	hcomPlan([{ name: 'auto-p', client: 'claude' }, null, { name: 'chk-p', client: 'codex' }]);
	const first = await doneThenChecking(task, 'auto-p', 'chk-p');
	replyAndWait('chk-p', ['1. PASS: 有', '2. PASS: 發票 AB-123', '3. PASS: 已寄', 'PASS'].join('\n'));
	expect((await checked(task.id, first.id)).review?.status).toBe('pass');
	expect((await viewOf(task.id)).state).toBe('done');
	expect((await alerts()).some((alert) => alert.runId === first.id)).toBe(false);

	rmSync(join(dir, 'hcom-calls.jsonl'), { force: true });
	rmSync(join(dir, 'hcom-added.json'), { force: true });
	hcomPlan([{ name: 'auto-q' }, null, { name: 'chk-q', client: 'codex' }]);
	const second = await doneThenChecking(task, 'auto-q', 'chk-q');
	replyAndWait('chk-q', ['1. PASS: 有', '3. PASS: 已寄', 'PASS'].join('\n'));
	const left = await checked(task.id, second.id);
	expect(left.review).toMatchObject({ status: 'fail', reason: '總結寫 PASS，但有條目沒過或沒判定' });
	expect(left.review!.items![1]).toEqual({ label: '發票已開立', ok: false, reason: '檢查 Agent 沒有判定這一條' });

	// A run that failed is not checked.
	rmSync(join(dir, 'hcom-calls.jsonl'), { force: true });
	rmSync(join(dir, 'hcom-added.json'), { force: true });
	hcomPlan([{ name: 'auto-f' }, null, { name: 'chk-f', client: 'codex' }]);
	const third = await runNow(task.id);
	await runWhen(task.id, third.id, (run) => run.sessionId === 's-auto-f', 'auto-f to be listed');
	replyAndWait('auto-f', 'FAILED: 網站打不開');
	const failed = await runWhen(task.id, third.id, (run) => run.status !== 'running', 'the run to fail');
	await sleep(500);
	expect(failed.review).toBeUndefined();
	expect(hcomCalls().some((call) => call.args[0] === 'codex')).toBe(false);

	// A command task with the switch on, its checker set to Claude: checked on the output it left.
	rmSync(join(dir, 'hcom-calls.jsonl'), { force: true });
	rmSync(join(dir, 'hcom-added.json'), { force: true });
	hcomPlan([{ name: 'chk-c' }]);
	const command = await create({
		name: '備份',
		kind: 'command',
		agent: undefined,
		command: { command: 'echo 備份完成', folder: work, checks: [{ type: 'output', text: '備份完成' }] },
		review: { enabled: true, checklist: ['輸出說備份完成'], client: 'claude', model: 'claude-sonnet-5-5', effort: 'low' }
	});
	const ran = await runNow(command.id);
	const checking = await checkerListed(command.id, ran.id, 'chk-c');
	const launch = hcomCalls().find((call) => call.args[0] === 'claude')!;
	expect(launch.args).toEqual(expect.arrayContaining(['--model', 'claude-sonnet-5-5', '--effort', 'low']));
	const text = readFileSync(join(dir, 'board-state/automation', checking.review!.brief!), 'utf8');
	expect(text).toContain(`指令輸出存檔：${join(dir, 'board-state/automation', checking.output!)}`);
	expect(text).toContain('結束碼：0');
	replyAndWait('chk-c', '1. PASS: 輸出第一行是「備份完成」\nPASS');
	expect((await checked(command.id, ran.id)).review?.status).toBe('pass');
	expect((await viewOf(command.id)).state).toBe('done');
	await send(`/api/automation/${task.id}/pause`, 'POST', { paused: true });
	await send(`/api/automation/${command.id}/pause`, 'POST', { paused: true });
});

test('停止這次 and the limit end the checker and close it; after a restart a checker still listed is watched on, one gone ends the check', async () => {
	const task = await create({ limitMinutes: 10 });
	hcomPlan([{ name: 'auto-s' }, null, { name: 'chk-s', client: 'codex' }]);
	const first = await doneThenChecking(task, 'auto-s', 'chk-s');
	expect((await send(`/api/automation/${task.id}/stop`, 'POST')).status).toBe(202);
	const stopped = await checked(task.id, first.id);
	expect(stopped.review).toMatchObject({ status: 'error', ended: 'stopped', reason: '檢查沒有做完：使用者按了停止這次' });
	expect(listed('chk-s')).toBe(false);
	// Stopped by the user: no card.
	expect((await alerts()).some((alert) => alert.runId === first.id)).toBe(false);

	// The checker's limit counts from its own start, and its run is carded.
	rmSync(join(dir, 'hcom-calls.jsonl'), { force: true });
	rmSync(join(dir, 'hcom-added.json'), { force: true });
	hcomPlan([{ name: 'auto-t' }, null, { name: 'chk-t', client: 'codex' }]);
	fixture.setClock(START + 5 * 60_000);
	const second = await doneThenChecking(task, 'auto-t', 'chk-t');
	fixture.setClock(START + 14 * 60_000);
	await sleep(500);
	expect((await runsOf(task.id)).find((run) => run.id === second.id)!.review?.status).toBe('checking');
	fixture.setClock(START + 15 * 60_000);
	const late = await checked(task.id, second.id);
	expect(late.review).toMatchObject({ status: 'error', ended: 'timeout', reason: '檢查沒有做完：超過上限 10 分鐘，已停止' });
	expect(listed('chk-t')).toBe(false);
	expect((await alerts()).find((alert) => alert.runId === second.id)?.kind).toBe('timeout');
	expect((await viewOf(task.id)).state).toBe('failed');

	// A restart while it checks: watched on, its verdict taken.
	rmSync(join(dir, 'hcom-calls.jsonl'), { force: true });
	rmSync(join(dir, 'hcom-added.json'), { force: true });
	hcomPlan([{ name: 'auto-r' }, null, { name: 'chk-r', client: 'codex' }]);
	fixture.setClock(START + 20 * 60_000);
	const third = await doneThenChecking(task, 'auto-r', 'chk-r');
	await fixture.stop();
	await fixture.start();
	cookie = await fixture.login();
	await sleep(500);
	expect((await runsOf(task.id)).find((run) => run.id === third.id)!.review?.status).toBe('checking');
	expect((await send(`/api/automation/${task.id}/run`, 'POST')).status).toBe(409);
	replyAndWait('chk-r', '1. PASS: a\n2. PASS: b\n3. PASS: c\nPASS');
	expect((await checked(task.id, third.id)).review?.status).toBe('pass');
	expect(listed('chk-r')).toBe(false);

	// Gone while the board was down.
	rmSync(join(dir, 'hcom-calls.jsonl'), { force: true });
	rmSync(join(dir, 'hcom-added.json'), { force: true });
	hcomPlan([{ name: 'auto-g' }, null, { name: 'chk-g', client: 'codex' }]);
	const fourth = await doneThenChecking(task, 'auto-g', 'chk-g');
	await fixture.stop();
	writeFileSync(join(dir, 'hcom-added.json'), '[]');
	await fixture.start();
	cookie = await fixture.login();
	const gone = await checked(task.id, fourth.id);
	expect(gone.review).toMatchObject({ status: 'error', reason: '檢查沒有做完：看板重啟時 Agent 已不在' });
	await send(`/api/automation/${task.id}/pause`, 'POST', { paused: true });
});

test('a Codex checker on a pinned account at 0 switches to one with quota; none left ends the check as 額度用完 with no checker opened', async () => {
	const task = await create();
	writeFileSync(join(dir, 'codex-auth.json'), JSON.stringify({ pinned: 0, accounts: [{ index: 0, used: 100 }, { index: 1, used: 30 }] }));
	hcomPlan([{ name: 'auto-k' }, null, { name: 'chk-k', client: 'codex' }]);
	const first = await doneThenChecking(task, 'auto-k', 'chk-k');
	expect(first.review?.accountSwitches).toEqual(['帳號 1 額度用完，換到 帳號 2']);
	expect(first.review?.codexAccount).toBe(1);
	replyAndWait('chk-k', '1. PASS: a\n2. PASS: b\n3. PASS: c\nPASS');
	expect((await checked(task.id, first.id)).review?.status).toBe('pass');

	rmSync(join(dir, 'hcom-calls.jsonl'), { force: true });
	rmSync(join(dir, 'hcom-added.json'), { force: true });
	rmSync(join(dir, 'codex-auth-pinned.txt'), { force: true });
	writeFileSync(join(dir, 'codex-auth.json'), JSON.stringify({ pinned: 0, accounts: [{ index: 0, used: 100 }, { index: 1, used: 100 }] }));
	hcomPlan([{ name: 'auto-n' }, null, { name: 'chk-n', client: 'codex' }]);
	const second = await runNow(task.id);
	await runWhen(task.id, second.id, (run) => run.sessionId === 's-auto-n', 'auto-n to be listed');
	replyAndWait('auto-n', 'DONE');
	const out = await checked(task.id, second.id);
	expect(out.review).toMatchObject({ status: 'error', ended: 'quota', reason: '檢查沒有做完：額度用完：沒有其他還有額度的訂閱帳號' });
	expect((await alerts()).find((alert) => alert.runId === second.id)?.kind).toBe('quota');
	expect(hcomCalls().some((call) => call.args[0] === 'codex')).toBe(false);
	await send(`/api/automation/${task.id}/pause`, 'POST', { paused: true });
});
