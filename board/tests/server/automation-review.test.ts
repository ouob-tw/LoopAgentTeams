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
/** The run once nothing of it is open: its check, the round sent back to its agent and a second check all over. */
const settled = (id: string, runId: string) => runWhen(id, runId, (run) => run.review !== undefined && run.review.status !== 'checking' && run.fix?.status !== 'fixing', 'the run to settle');
/** The task's agent comes back under its own name and session when the board resumes it (#690). */
function resumesAs(run: AutomationRun, name: string) {
	const plan = JSON.parse(readFileSync(join(dir, 'hcom.json'), 'utf8'));
	plan.resumed = { name: run.agentName, base_name: name, session_id: `s-${name}`, status: 'active', tool: 'claude', launch_context: { pane_id: `wW:p-${name}-2` } };
	writeFileSync(join(dir, 'hcom.json'), JSON.stringify(plan));
}
/** Every hcom call from now on fails, as a resume that cannot bring the agent back. */
function hcomFails() {
	const plan = JSON.parse(readFileSync(join(dir, 'hcom.json'), 'utf8'));
	writeFileSync(join(dir, 'hcom.json'), JSON.stringify({ ...plan, exit: 1, stderr: 'no such session' }));
}
const resumes = () => hcomCalls().filter((call) => call.args[0] === 'r');

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

test('a run that succeeded opens a read-only checker of the other client; a FAIL sends it back to its agent once, a second check reads the reply and its FAIL is final, with a red card, and the period stays open', async () => {
	// Daily at 12:30 and started by hand at 12:00: the try due at 12:30 comes while the checker checks.
	const task = await create({ schedule: { type: 'daily' }, time: '12:30', limitMinutes: 60 });
	expect(task.review).toMatchObject({ enabled: true, client: 'codex', checklist: CHECKLIST });
	// Launch, close, checker, close, resume, close, second checker, close.
	hcomPlan([{ name: 'auto-a' }, null, { name: 'chk-a', client: 'codex' }, null, null, null, { name: 'chk-a2', client: 'codex' }]);
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

	resumesAs(run, 'auto-a');
	replyAndWait('chk-a', ['1. PASS: out/report.pdf 存在，12 頁', '2. FAIL: 報告裡沒有發票號碼，也找不到開立紀錄', '3. PASS: 寄信紀錄有 250 OK', 'FAIL'].join('\n'));
	const first = await checked(task.id, run.id);
	expect(first.review).toMatchObject({
		status: 'fail',
		items: [
			{ label: '報告 PDF 已產生', ok: true, reason: 'out/report.pdf 存在，12 頁' },
			{ label: '發票已開立', ok: false, reason: '報告裡沒有發票號碼，也找不到開立紀錄' },
			{ label: '通知信已寄出', ok: true, reason: '寄信紀錄有 250 OK' }
		]
	});
	expect(listed('chk-a')).toBe(false);

	// Sent back to the task's own agent, in its own conversation and workspace, with the failed item and why.
	const resume = await eventually(async () => resumes()[0], 8_000, 'the resume');
	expect(resume.args.slice(0, 2)).toEqual(['r', 's-auto-a']);
	expect(resume.workspace).toBe('wA');
	const message = resume.args[resume.args.indexOf('--hcom-prompt') + 1];
	expect(message).toContain('沒過的條目：2. 發票已開立（檢查理由：報告裡沒有發票號碼，也找不到開立紀錄）。');
	expect(message).not.toContain('報告 PDF 已產生');
	for (const rule of ['「N. 已補做：<做了什麼>」或「N. 反駁：<理由與證據>」', '補做只限原任務授權內、不需要新授權的事', '不要發新的待決題', '最後一行只回覆 DONE，失敗回覆 FAILED: <原因>']) expect(message).toContain(rule);
	expect(message).not.toContain('\n');
	const fixing = await runWhen(task.id, run.id, (each) => each.fix?.status === 'fixing' && each.fix.agentName !== undefined, 'the round to be watched');
	expect(fixing.fix).toMatchObject({ limitMinutes: 30, agentName: run.agentName });
	// Still open: no card yet, the task counts as running, and the label says it went back.
	expect((await viewOf(task.id)).state).toBe('running');
	expect((await alerts()).some((alert) => alert.runId === run.id)).toBe(false);

	const answer = ['2. 已補做：補開發票 AB-123，存在 out/invoice.pdf', 'DONE'].join('\n');
	replyAndWait('auto-a', answer);
	const second = await runWhen(task.id, run.id, (each) => each.review?.status === 'checking' && each.review.sessionId === 's-chk-a2', 'the second checker');
	expect(second.fix).toMatchObject({ status: 'replied', reply: answer });
	expect(second.firstReview).toMatchObject({ status: 'fail' });
	expect(listed('auto-a')).toBe(false);
	const secondLaunch = hcomCalls().filter((call) => call.args[0] === 'codex')[1];
	expect(secondLaunch.args[secondLaunch.args.indexOf('--tag') + 1]).toBe(`autochk-${task.id}-${run.id.split('-').at(-1)!.slice(0, 6)}-2`);
	const secondBrief = readFileSync(join(dir, 'board-state/automation', second.review!.brief!), 'utf8');
	expect(second.review!.brief).not.toBe(first.review!.brief);
	for (const part of ['這是第二次檢查，也是最後一次', '## 第一次檢查結果', '2. FAIL: 報告裡沒有發票號碼，也找不到開立紀錄', '## 任務 Agent 的回應', '2. 已補做：補開發票 AB-123', '## 驗收清單']) expect(secondBrief).toContain(part);

	replyAndWait('chk-a2', ['1. PASS: 有', '2. FAIL: out/invoice.pdf 是空檔', '3. PASS: 有', 'FAIL'].join('\n'));
	const done = await settled(task.id, run.id);
	expect(done.review).toMatchObject({ status: 'fail', items: [{ ok: true }, { ok: false, reason: 'out/invoice.pdf 是空檔' }, { ok: true }] });
	// The second verdict is final: no third check, no second resume.
	await sleep(500);
	expect(resumes()).toHaveLength(1);
	expect(hcomCalls().filter((call) => call.args[0] === 'codex')).toHaveLength(2);
	expect((await runsOf(task.id)).find((each) => each.id === run.id)!.review?.status).toBe('fail');
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
	// A PASS sends nothing back.
	await sleep(300);
	expect(resumes()).toEqual([]);
	expect((await runsOf(task.id)).find((run) => run.id === first.id)!.fix).toBeUndefined();

	// A FAIL whose agent cannot be resumed keeps the first FAIL, saying why, with its card.
	rmSync(join(dir, 'hcom-calls.jsonl'), { force: true });
	rmSync(join(dir, 'hcom-added.json'), { force: true });
	hcomPlan([{ name: 'auto-q' }, null, { name: 'chk-q', client: 'codex' }]);
	const second = await doneThenChecking(task, 'auto-q', 'chk-q');
	hcomFails();
	replyAndWait('chk-q', ['1. PASS: 有', '3. PASS: 已寄', 'PASS'].join('\n'));
	const left = await settled(task.id, second.id);
	expect(left.review).toMatchObject({ status: 'fail', reason: '總結寫 PASS，但有條目沒過或沒判定' });
	expect(left.review!.items![1]).toEqual({ label: '發票已開立', ok: false, reason: '檢查 Agent 沒有判定這一條' });
	expect(resumes()).toHaveLength(1);
	expect(left.fix).toMatchObject({ status: 'failed' });
	expect(left.fix!.reason).toStartWith('接不回任務 Agent 原本的對話：');
	expect(left.firstReview).toBeUndefined();
	expect((await alerts()).find((alert) => alert.runId === second.id)?.kind).toBe('check-failed');
	expect(hcomCalls().filter((call) => call.args[0] === 'codex')).toHaveLength(1);

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

test('a dispute the second check accepts settles the period with no card; a round with no reply past its own 30 minutes keeps the first FAIL', async () => {
	const task = await create({ limitMinutes: 120 });
	hcomPlan([{ name: 'auto-d' }, null, { name: 'chk-d', client: 'codex' }, null, null, null, { name: 'chk-d2', client: 'codex' }]);
	const first = await doneThenChecking(task, 'auto-d', 'chk-d');
	resumesAs(first, 'auto-d');
	replyAndWait('chk-d', '1. PASS: a\n2. FAIL: 找不到發票\n3. PASS: c\nFAIL');
	await eventually(async () => resumes()[0], 8_000, 'the resume');
	await runWhen(task.id, first.id, (run) => run.fix?.agentName !== undefined, 'the round to be watched');
	replyAndWait('auto-d', '2. 反駁：這個月沒有成交，不用開發票，見 out/sales.csv 是空的\nDONE');
	await runWhen(task.id, first.id, (run) => run.review?.sessionId === 's-chk-d2', 'the second checker');
	replyAndWait('chk-d2', '1. PASS: a\n2. PASS: 接受反駁，sales.csv 沒有資料列\n3. PASS: c\nPASS');
	const passed = await settled(task.id, first.id);
	expect(passed.review?.status).toBe('pass');
	expect(passed.firstReview?.status).toBe('fail');
	expect((await viewOf(task.id)).state).toBe('done');
	expect((await alerts()).some((alert) => alert.runId === first.id)).toBe(false);
	await send(`/api/automation/${task.id}/pause`, 'POST', { paused: true });

	// Run again by hand: the agent never replies; the round has 30 minutes of its own.
	rmSync(join(dir, 'hcom-calls.jsonl'), { force: true });
	rmSync(join(dir, 'hcom-added.json'), { force: true });
	hcomPlan([{ name: 'auto-e' }, null, { name: 'chk-e', client: 'codex' }]);
	const second = await doneThenChecking(task, 'auto-e', 'chk-e');
	resumesAs(second, 'auto-e');
	replyAndWait('chk-e', '1. PASS: a\n2. FAIL: 找不到發票\n3. PASS: c\nFAIL');
	const fixing = await runWhen(task.id, second.id, (run) => run.fix?.agentName !== undefined, 'the round to be watched');
	fixture.setClock(fixing.fix!.startedAt + 29 * 60_000);
	await sleep(500);
	expect((await runsOf(task.id)).find((run) => run.id === second.id)!.fix?.status).toBe('fixing');
	fixture.setClock(fixing.fix!.startedAt + 30 * 60_000);
	const late = await settled(task.id, second.id);
	expect(late.fix).toMatchObject({ status: 'failed', ended: 'timeout', reason: '超過上限 30 分鐘，已停止' });
	expect(late.review?.status).toBe('fail');
	expect(listed('auto-e')).toBe(false);
	expect((await alerts()).find((alert) => alert.runId === second.id)?.kind).toBe('check-failed');
}, 30_000);

test('a restart before the resume was recorded ends the round with the first FAIL: the old DONE never passes for a reply', async () => {
	const task = await create({ name: '重啟中的修正' });
	await send(`/api/automation/${task.id}/pause`, 'POST', { paused: true });
	const items = CHECKLIST.map((label, index) => ({ label, ok: index !== 1, reason: index === 1 ? '找不到發票' : '有' }));
	const review = { client: 'codex', model: 'gpt-6.1-sol', effort: 'medium' };
	const runId = `${(START - 60 * 60_000).toString(36)}-0123456789`;
	const run = {
		id: runId,
		taskId: task.id,
		trigger: 'manual',
		period: '2026-11',
		startedAt: START - 60 * 60_000,
		endedAt: START - 40 * 60_000,
		status: 'success',
		agentName: 'auto-old',
		sessionId: 's-auto-old',
		agentWorkspace: 'wA',
		review: { ...review, status: 'fail', startedAt: START - 40 * 60_000, endedAt: START - 30 * 60_000, items },
		fix: { status: 'fixing', startedAt: START - 30 * 60_000, limitMinutes: 30 }
	};
	rmSync(join(dir, 'hcom-calls.jsonl'), { force: true });
	writeFileSync(join(dir, 'hcom-added.json'), '[]');
	mkdirSync(join(dir, 'transcripts'), { recursive: true });
	writeFileSync(join(dir, 'transcripts/s-auto-old.jsonl'), JSON.stringify({ kind: 'assistant', time: null, text: '報告做好了\nDONE' }) + '\n');
	await fixture.stop();
	appendFileSync(join(dir, 'board-state/automation/runs', `${task.id}.jsonl`), JSON.stringify(run) + '\n');
	await fixture.start();
	cookie = await fixture.login();
	const done = await settled(task.id, runId);
	expect(done.fix).toMatchObject({ status: 'failed', reason: '看板重啟時還沒確定接回任務 Agent，交回修正中斷' });
	expect(done.fix!.reply).toBeUndefined();
	expect(done.firstReview).toBeUndefined();
	expect(done.review?.status).toBe('fail');
	await sleep(300);
	expect(hcomCalls().filter((call) => call.args[0] === 'codex' || call.args[0] === 'r')).toEqual([]);
	expect((await alerts()).find((alert) => alert.runId === runId)?.kind).toBe('check-failed');
});

test('停止這次 and the limit end the checker and close it; after a restart a checker still listed is watched on, one gone ends the check', async () => {
	const task = await create({ limitMinutes: 10 });
	hcomPlan([{ name: 'auto-s' }, null, { name: 'chk-s', client: 'codex' }]);
	const first = await doneThenChecking(task, 'auto-s', 'chk-s');
	expect((await send(`/api/automation/${task.id}/stop`, 'POST')).status).toBe(202);
	const stopped = await checked(task.id, first.id);
	expect(stopped.review).toMatchObject({ status: 'error', ended: 'stopped', reason: '檢查沒有做完：使用者按了停止這次' });
	expect(listed('chk-s')).toBe(false);
	// Stopped by the user: no card, and nothing sent back to the task's agent.
	expect((await alerts()).some((alert) => alert.runId === first.id)).toBe(false);
	expect(resumes()).toEqual([]);

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
	expect(late.fix).toBeUndefined();
	expect(resumes()).toEqual([]);
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

test('a check that ends past midnight, a week’s end or a month’s end settles the period the run started in, and the new period is untouched', async () => {
	const cases = [
		{ name: '跨夜', schedule: { type: 'daily' }, start: tpe(2026, 11, 18, 23, 30), end: tpe(2026, 11, 19, 0, 30), period: '2026-11-18', next: tpe(2026, 11, 19, 23, 45) },
		// 2026-11-15 is a Sunday: the check ends on the Monday, the next week's first day.
		{ name: '跨週', schedule: { type: 'weekly', fromWeekday: 1, toWeekday: 7 }, start: tpe(2026, 11, 15, 23, 30), end: tpe(2026, 11, 16, 0, 30), period: '2026-W11-09', next: tpe(2026, 11, 16, 23, 45) },
		{ name: '跨月', schedule: { type: 'monthly', fromDay: 1, toDay: 31 }, start: tpe(2026, 11, 30, 23, 30), end: tpe(2026, 12, 1, 0, 30), period: '2026-11', next: tpe(2026, 12, 1, 23, 45) }
	];
	for (const [index, each] of cases.entries()) {
		rmSync(join(dir, 'hcom-calls.jsonl'), { force: true });
		rmSync(join(dir, 'hcom-added.json'), { force: true });
		fixture.setClock(each.start);
		const task = await create({ name: each.name, schedule: each.schedule, time: '23:45', limitMinutes: 120 });
		hcomPlan([{ name: `auto-b${index}` }, null, { name: `chk-b${index}`, client: 'codex' }]);
		const started = await doneThenChecking(task, `auto-b${index}`, `chk-b${index}`);
		expect(started.period).toBe(each.period);
		// The check is still going when the period turns over.
		fixture.setClock(each.end);
		await sleep(500);
		expect((await runsOf(task.id)).find((run) => run.id === started.id)!.review?.status).toBe('checking');
		replyAndWait(`chk-b${index}`, '1. PASS: a\n2. PASS: b\n3. PASS: c\nPASS');
		const done = await checked(task.id, started.id);
		expect(done).toMatchObject({ period: each.period, status: 'success', review: { status: 'pass' } });
		// The new period has no run of its own and still waits for its set time.
		const view = await viewOf(task.id);
		expect(view.runs).toHaveLength(1);
		expect(view.state).toBe('waiting');
		expect(view.nextAt).toBe(each.next);
		expect((await alerts()).some((alert) => alert.runId === started.id)).toBe(false);
		await send(`/api/automation/${task.id}/pause`, 'POST', { paused: true });
	}
}, 60_000);

test('a check that fails past the boundary leaves the period it started in not done, and that period is not missed either', async () => {
	const task = await create({ name: '跨月檢查未過', schedule: { type: 'monthly', fromDay: 28, toDay: 30 }, time: '23:45', limitMinutes: 120 });
	hcomPlan([{ name: 'auto-bf' }, null, { name: 'chk-bf', client: 'codex' }]);
	fixture.setClock(tpe(2026, 11, 30, 23, 30));
	const started = await doneThenChecking(task, 'auto-bf', 'chk-bf');
	// Past the window's last day: the run still holds the period, so it is not missed.
	fixture.setClock(tpe(2026, 12, 1, 0, 30));
	await sleep(500);
	hcomFails();
	replyAndWait('chk-bf', '1. PASS: a\n2. FAIL: b\n3. PASS: c\nFAIL');
	const done = await settled(task.id, started.id);
	expect(done).toMatchObject({ period: '2026-11', review: { status: 'fail' } });
	const view = await viewOf(task.id);
	expect(view.missed).toEqual([]);
	expect(view.state).toBe('waiting');
	expect((await alerts()).some((alert) => alert.runId === started.id && alert.kind === 'check-failed')).toBe(true);
	await send(`/api/automation/${task.id}/pause`, 'POST', { paused: true });
}, 30_000);
