// 等你回覆 (ASK) on the built board, against the fake hcom, Herdr, helper and input command: an agent
// task's agent whose last line is `ASK: <question>` stays open and is no failure; the run records the
// question, the list says 等你回覆 and a yellow card opens in 待辦. The answer written on the board is
// typed into the agent as a message from the user, kept with its time and 看板, and the card goes; an
// answer typed in its terminal, or any new turn, is noticed the same way (終端). A run may ask more than
// once, and the checking agent's brief carries every question and answer. While it waits neither the
// schedule nor 立即執行 starts the task again, also after a restart, which watches on (an agent gone by
// then fails the run); the time it waits does not count toward the limit (#675), so it stops past the
// limit only on its working time, and the yellow card turns into a red one; 停止這次 works while it waits. Nothing here starts a real agent.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { jsonLines, NODE, sleep, startFixture, type Fixture } from '../harness.ts';
import type { AutomationRun, AutomationSnapshot, AutomationTask } from '../../src/lib/board/automation.ts';
import type { AlertsSnapshot } from '../../src/lib/board/alerts.ts';

const tpe = (year: number, month: number, day: number, hour = 12, minute = 0) => Date.UTC(year, month - 1, day, hour - 8, minute);
const START = tpe(2026, 11, 18, 12);

// The fake input command's log lives outside the fixture directory: its command line is set before the fixture exists.
const injectDir = mkdtempSync(join(tmpdir(), 'lat-board-ask-inject-'));

let fixture: Fixture;
let cookie: string;
let work: string;
let dir: string;

beforeAll(async () => {
	fixture = await startFixture({ env: { TZ: 'UTC', LAT_BOARD_AUTOMATION_TICK_SECONDS: '0.1', LAT_BOARD_AUTOMATION_AGENT_POLL_SECONDS: '0.1', LAT_BOARD_LAUNCH_WAIT_SECONDS: '3', LAT_BOARD_HCOM_TIMEOUT_SECONDS: '3', LAT_BOARD_INJECT_COMMAND: JSON.stringify([NODE, join(import.meta.dir, '../fake-inject.mjs'), injectDir]), LAT_BOARD_INJECT_TIMEOUT_SECONDS: '2' } });
	dir = fixture.dir;
	fixture.setClock(START);
	work = join(dir, 'work');
	mkdirSync(join(work, 'docs'), { recursive: true });
	writeFileSync(join(work, 'docs/brief.md'), '# 任務\n');
	cookie = await fixture.login();
});
afterAll(async () => {
	await fixture.cleanup();
	rmSync(injectDir, { recursive: true, force: true });
});
beforeEach(() => {
	fixture.setClock(START);
	for (const name of ['hcom-calls.jsonl', 'hcom.json', 'hcom-added.json', 'codex-auth.json', 'codex-auth-calls.jsonl', 'codex-auth-pinned.txt']) rmSync(join(dir, name), { force: true });
	for (const name of ['inject-typed.jsonl', 'inject-calls.jsonl']) rmSync(join(injectDir, name), { force: true });
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

/** The agent's turn ends with this reply (after the input that began it). */
function turn(name: string, text: string, input = '讀取並照做') {
	mkdirSync(join(dir, 'transcripts'), { recursive: true });
	appendFileSync(join(dir, 'transcripts', `s-${name}.jsonl`), JSON.stringify({ kind: 'user', time: null, text: input }) + '\n');
	appendFileSync(join(dir, 'transcripts', `s-${name}.jsonl`), JSON.stringify({ kind: 'assistant', time: null, text }) + '\n');
	setStatus(name, 'listening');
}
/** Something typed into the agent's terminal, with no reply yet. */
function typed(name: string, text: string) {
	appendFileSync(join(dir, 'transcripts', `s-${name}.jsonl`), JSON.stringify({ kind: 'user', time: null, text }) + '\n');
}
/** An hcom delivery in the agent's conversation: another agent's message (`hcom`), or the question panel's answer (`lat-panel`, #678). */
function delivered(name: string, sender: 'hcom' | 'lat-panel') {
	appendFileSync(join(dir, 'transcripts', `s-${name}.jsonl`), JSON.stringify({ kind: 'tool', time: null, name: sender, label: '收到 hcom 通知', detail: '', error: false }) + '\n');
}
const injected = () => jsonLines(join(injectDir, 'inject-typed.jsonl')) as { text: string; enter: boolean }[];

const QUESTION = '11 月的維護費要開幾張發票？上個月是 1 張 NT$ 30,000，這個月合約備註寫「分兩期」。請回覆：1 張或 2 張（每張金額）。';

async function create(overrides: Record<string, unknown> = {}): Promise<AutomationTask> {
	const response = await send('/api/automation', 'POST', {
		name: '客發展覽維護報告',
		schedule: { type: 'monthly', fromDay: 1, toDay: 2 },
		time: '02:00',
		limitMinutes: 90,
		kind: 'agent',
		agent: { client: 'claude', model: 'claude-haiku-5-5', effort: 'low', folder: work, brief: 'docs/brief.md' },
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
/** Start the task and have its agent ask; the run once it waits. */
async function asking(task: AutomationTask, name: string, question = QUESTION): Promise<AutomationRun> {
	const started = await runNow(task.id);
	await runWhen(task.id, started.id, (run) => run.sessionId === `s-${name}`, `${name} to be listed`);
	turn(name, `我先整理了合約。\nASK: ${question}`);
	return runWhen(task.id, started.id, (run) => run.asks?.length === 1, 'the question to be recorded');
}
const waitingOn = (id: string, runId: string, count: number) => runWhen(id, runId, (run) => run.asks?.length === count && run.asks.at(-1)!.answeredAt === undefined, `question ${count}`);
const answered = (id: string, runId: string, count: number) => runWhen(id, runId, (run) => run.asks?.length === count && run.asks.at(-1)!.answeredAt !== undefined, `answer ${count}`);
const ended = (id: string, runId: string) => runWhen(id, runId, (run) => run.status !== 'running', 'the run to end');
const yellow = async (runId: string) => (await alerts()).filter((alert) => alert.kind === 'ask' && alert.runId === runId);
const reply = (id: string, text: unknown) => send(`/api/automation/${id}/reply`, 'POST', { text });

test('the first message and the resume message carry the DONE, FAILED and ASK rules', async () => {
	const task = await create();
	hcomPlan([{ name: 'ask-rules' }]);
	await asking(task, 'ask-rules');
	const launch = hcomCalls().find((call) => call.args[0] === 'claude')!;
	expect(launch.args[launch.args.indexOf('--hcom-prompt') + 1]).toBe(
		`讀取並照做 ${join(work, 'docs/brief.md')}，完成後最後一行只回覆 DONE，失敗回覆 FAILED: <原因>；需要使用者決定或補資料時，最後一行回覆 ASK: <問題> 並等待回覆，收到後接著做`
	);
	expect((await send(`/api/automation/${task.id}/stop`, 'POST')).status).toBe(202);
	await ended(task.id, (await runsOf(task.id))[0].id);
});

test('ASK leaves the agent open as 等你回覆 with a yellow card; the board\'s reply reaches the agent, is kept as 看板 and the card goes; DONE then ends it', async () => {
	const task = await create();
	hcomPlan([{ name: 'ask-board' }]);
	const run = await asking(task, 'ask-board');
	expect(run.status).toBe('running');
	expect(run.asks).toEqual([{ question: QUESTION, askedAt: START }]);
	await sleep(500);
	// Still open, not judged, not closed.
	expect(listed('ask-board')).toBe(true);
	expect((await runsOf(task.id))[0].status).toBe('running');
	expect((await viewOf(task.id)).state).toBe('asking');
	const [card] = await yellow(run.id);
	expect(card).toMatchObject({ taskName: '客發展覽維護報告', kind: 'ask', question: QUESTION, summary: QUESTION, ask: 0 });
	expect(card.dismissedAt).toBeUndefined();

	// Empty, or for a task that waits on nothing: refused.
	expect((await reply(task.id, '  ')).status).toBe(400);
	const other = await create({ name: '別的任務' });
	expect((await reply(other.id, '2 張')).status).toBe(409);

	fixture.setClock(START + 5 * 60_000);
	const response = await reply(task.id, '2 張，各 NT$ 15,000');
	expect(response.status).toBe(200);
	expect(injected()).toEqual([{ text: '2 張，各 NT$ 15,000', enter: true }]);
	const after = await answered(task.id, run.id, 1);
	expect(after.asks).toEqual([{ question: QUESTION, askedAt: START, answer: '2 張，各 NT$ 15,000', answeredAt: START + 5 * 60_000, source: '看板' }]);
	expect(after.status).toBe('running');
	expect((await viewOf(task.id)).state).toBe('running');
	const [gone] = await yellow(run.id);
	expect(gone).toMatchObject({ resolved: 'answered', dismissedAt: START + 5 * 60_000 });
	// Nothing waits any more.
	expect((await reply(task.id, '再一次')).status).toBe(409);

	// The answer as the agent saw it starts its turn; the reply after it is judged.
	setStatus('ask-board', 'active');
	await sleep(400);
	expect((await runsOf(task.id))[0].asks).toHaveLength(1);
	turn('ask-board', '兩張發票都開好了。\nDONE', '2 張，各 NT$ 15,000');
	const done = await ended(task.id, run.id);
	expect(done.status).toBe('success');
	expect(done.asks).toHaveLength(1);
	expect(listed('ask-board')).toBe(false);
	// No red card for it.
	expect((await alerts()).filter((alert) => alert.runId === run.id && alert.kind !== 'ask')).toEqual([]);
});

test('an answer typed in the terminal is noticed as 終端, while a hcom message from another agent and the turn it starts are not (#678); a run asks more than once; the checker reads every question and answer', async () => {
	const task = await create({ review: { enabled: true, checklist: ['發票已開立'] } });
	hcomPlan([{ name: 'ask-term' }, null, { name: 'chk-term', client: 'codex' }]);
	const run = await asking(task, 'ask-term');

	fixture.setClock(START + 2 * 60_000);
	typed('ask-term', '開 2 張');
	const first = await answered(task.id, run.id, 1);
	expect(first.asks![0]).toEqual({ question: QUESTION, askedAt: START, answer: '開 2 張', answeredAt: START + 2 * 60_000, source: '終端' });
	expect((await yellow(run.id))[0]).toMatchObject({ resolved: 'answered' });
	expect(injected()).toEqual([]);

	// A second question: its own card.
	fixture.setClock(START + 4 * 60_000);
	turn('ask-term', '新抬頭見合約第 2 頁。\nASK: 發票抬頭用舊的還是新的？', '開 2 張');
	await waitingOn(task.id, run.id, 2);
	const cards = await yellow(run.id);
	expect(cards.map((card) => [card.ask, card.dismissedAt === undefined])).toEqual(
		expect.arrayContaining([
			[0, false],
			[1, true]
		])
	);
	expect((await viewOf(task.id)).state).toBe('asking');

	// Other agents' hcom messages, and the turn they start, are not the user's answer (#678).
	fixture.setClock(START + 6 * 60_000);
	delivered('ask-term', 'hcom');
	setStatus('ask-term', 'active');
	await sleep(500);
	expect((await runsOf(task.id))[0].asks![1].answeredAt).toBeUndefined();
	setStatus('ask-term', 'blocked');
	await sleep(300);
	expect((await runsOf(task.id))[0].asks![1].answeredAt).toBeUndefined();
	expect((await viewOf(task.id)).state).toBe('asking');
	// What the user types in the terminal after that is.
	fixture.setClock(START + 7 * 60_000);
	typed('ask-term', '用新的');
	const second = await answered(task.id, run.id, 2);
	expect(second.asks![1]).toMatchObject({ question: '發票抬頭用舊的還是新的？', answer: '用新的', answeredAt: START + 7 * 60_000, source: '終端' });

	turn('ask-term', 'DONE', '用新的');
	await runWhen(task.id, run.id, (each) => each.review?.sessionId === 's-chk-term', 'the checker');
	const checking = (await runsOf(task.id))[0];
	const brief = readFileSync(join(dir, 'board-state/automation', checking.review!.brief!), 'utf8');
	expect(brief).toContain('## 執行中的問答');
	for (const text of [QUESTION, '開 2 張', '發票抬頭用舊的還是新的？', '終端']) expect(brief).toContain(text);
	expect((await send(`/api/automation/${task.id}/stop`, 'POST')).status).toBe(202);
	await runWhen(task.id, run.id, (each) => each.review?.status !== 'checking', 'the check to stop');
});

test('while it waits neither the schedule nor 立即執行 starts the task again', async () => {
	// Daily at 00:00: the try is due the moment the task is saved, and again tomorrow.
	const task = await create({ schedule: { type: 'daily' }, time: '00:00', limitMinutes: 1440 });
	hcomPlan([{ name: 'ask-busy' }]);
	const auto = await eventually(async () => (await runsOf(task.id)).find((run) => run.trigger === 'auto'), 5_000, 'the automatic try');
	await runWhen(task.id, auto.id, (run) => run.sessionId === 's-ask-busy', 'ask-busy listed');
	turn('ask-busy', `ASK: ${QUESTION}`);
	await waitingOn(task.id, auto.id, 1);

	const refused = await send(`/api/automation/${task.id}/run`, 'POST');
	expect(refused.status).toBe(409);
	expect((await refused.json()).message).toBe('這個任務正在等你回覆，回覆或停止這次之後再執行');
	// Tomorrow 00:01, 12 hours on: still waiting, inside its day-long limit; the try due is skipped.
	fixture.setClock(START + 12 * 3_600_000 + 60_000);
	const skip = await eventually(async () => (await runsOf(task.id)).find((run) => run.status === 'skipped'), 5_000, 'the skipped try');
	expect([skip.trigger, skip.reason]).toEqual(['auto', '上一次還在等你回覆']);
	expect(hcomCalls().filter((call) => call.args[0] === 'claude')).toHaveLength(1);
	expect((await send(`/api/automation/${task.id}/stop`, 'POST')).status).toBe(202);
	await ended(task.id, auto.id);
	await send(`/api/automation/${task.id}/pause`, 'POST', { paused: true });
});

test('a restart while it waits: an agent still there waits on with its yellow card and no second run; one gone fails and its card turns red', async () => {
	const task = await create({ schedule: { type: 'daily' }, time: '00:00', limitMinutes: 1440 });
	hcomPlan([{ name: 'ask-stay' }]);
	const run = await eventually(async () => (await runsOf(task.id)).find((each) => each.trigger === 'auto'), 5_000, 'the automatic try');
	await runWhen(task.id, run.id, (each) => each.sessionId === 's-ask-stay', 'ask-stay listed');
	turn('ask-stay', `ASK: ${QUESTION}`);
	await waitingOn(task.id, run.id, 1);
	const [card] = await yellow(run.id);

	await fixture.stop();
	fixture.setClock(START + 10 * 60_000);
	await fixture.start();
	cookie = await fixture.login();
	await sleep(600);
	const after = (await runsOf(task.id)).find((each) => each.id === run.id)!;
	expect(after.status).toBe('running');
	expect((await viewOf(task.id)).state).toBe('asking');
	expect((await yellow(run.id))[0]).toMatchObject({ id: card.id });
	expect((await yellow(run.id))[0].dismissedAt).toBeUndefined();
	// The first check after a restart starts a try whose set time has passed: not beside one that waits.
	expect((await runsOf(task.id)).filter((each) => each.trigger === 'auto' && each.status !== 'skipped')).toHaveLength(1);
	expect((await send(`/api/automation/${task.id}/run`, 'POST')).status).toBe(409);
	expect(listed('ask-stay')).toBe(true);
	expect((await reply(task.id, '2 張')).status).toBe(200);
	await answered(task.id, run.id, 1);

	// Asks again, and is gone when the board comes back.
	turn('ask-stay', 'ASK: 還有一題', '2 張');
	await waitingOn(task.id, run.id, 2);
	await fixture.stop();
	writeFileSync(join(dir, 'hcom-added.json'), '[]');
	await fixture.start();
	cookie = await fixture.login();
	const gone = await ended(task.id, run.id);
	expect([gone.status, gone.reason]).toEqual(['failed', '看板重啟時 Agent 已不在']);
	const cards = await eventually(async () => {
		const own = (await alerts()).filter((alert) => alert.runId === run.id);
		return own.some((alert) => alert.kind === 'failed') && own;
	}, 5_000, 'the red card');
	expect(cards.filter((alert) => alert.kind === 'ask').map((alert) => alert.resolved)).toEqual(expect.arrayContaining(['answered', 'ended']));
	expect(cards.filter((alert) => alert.kind === 'ask').every((alert) => alert.dismissedAt !== undefined)).toBe(true);
	await send(`/api/automation/${task.id}/pause`, 'POST', { paused: true });
});

/** Start the task, let its agent work until `askAt`, then have it ask; the run once it waits. */
async function askingAt(task: AutomationTask, name: string, askAt: number): Promise<AutomationRun> {
	const started = await runNow(task.id);
	await runWhen(task.id, started.id, (run) => run.sessionId === `s-${name}`, `${name} to be listed`);
	fixture.setClock(askAt);
	turn(name, `ASK: ${QUESTION}`);
	return waitingOn(task.id, started.id, 1);
}
const stillRunning = async (id: string, runId: string) => {
	// Several watch polls and scheduler checks pass at this clock.
	await sleep(500);
	const run = (await runsOf(id)).find((each) => each.id === runId)!;
	expect([run.status, run.reason]).toEqual(['running', undefined]);
	return run;
};

test('waiting does not count toward the limit (#675): unanswered past the limit it waits on; answered, it times out only once its working time passes the limit', async () => {
	const task = await create({ limitMinutes: 60 });
	hcomPlan([{ name: 'ask-late' }]);
	// 30 minutes of work, then a question left for 5 hours: far past 60 minutes from the start.
	const run = await askingAt(task, 'ask-late', START + 30 * 60_000);
	fixture.setClock(START + 30 * 60_000 + 5 * 3_600_000);
	await stillRunning(task.id, run.id);
	expect((await viewOf(task.id)).state).toBe('asking');
	expect(listed('ask-late')).toBe(true);
	expect((await yellow(run.id))[0].dismissedAt).toBeUndefined();

	const answeredAt = START + 30 * 60_000 + 5 * 3_600_000;
	expect((await reply(task.id, '2 張')).status).toBe(200);
	await answered(task.id, run.id, 1);
	setStatus('ask-late', 'active');
	// 29 more minutes: 59 worked.
	fixture.setClock(answeredAt + 29 * 60_000);
	await stillRunning(task.id, run.id);
	// 31 more minutes: 61 worked.
	fixture.setClock(answeredAt + 31 * 60_000);
	const late = await ended(task.id, run.id);
	expect([late.status, late.reason]).toEqual(['timeout', '超過上限 60 分鐘，已停止']);
	expect(listed('ask-late')).toBe(false);
	const own = await eventually(async () => {
		const cards = (await alerts()).filter((alert) => alert.runId === run.id);
		return cards.some((alert) => alert.kind === 'timeout') && cards;
	}, 5_000, 'the red card');
	expect(own.find((alert) => alert.kind === 'ask')).toMatchObject({ resolved: 'answered' });
});

test('every wait is taken off, one answered in the terminal too (#675); 停止這次 works while it waits', async () => {
	const task = await create({ limitMinutes: 60 });
	hcomPlan([{ name: 'ask-many' }]);
	const run = await askingAt(task, 'ask-many', START + 20 * 60_000);
	// Answered on the board after 2 hours.
	fixture.setClock(START + 20 * 60_000 + 2 * 3_600_000);
	expect((await reply(task.id, '2 張')).status).toBe(200);
	await answered(task.id, run.id, 1);
	// 20 more minutes of work (40 worked), then a second question answered in the terminal 3 hours later.
	const second = START + 40 * 60_000 + 2 * 3_600_000;
	fixture.setClock(second);
	turn('ask-many', 'ASK: 發票抬頭用舊的還是新的？', '2 張');
	await waitingOn(task.id, run.id, 2);
	fixture.setClock(second + 3 * 3_600_000);
	typed('ask-many', '用新的');
	const both = await answered(task.id, run.id, 2);
	expect(both.asks![1]).toMatchObject({ source: '終端', answeredAt: second + 3 * 3_600_000 });
	// 19 more minutes: 59 worked.
	fixture.setClock(second + 3 * 3_600_000 + 19 * 60_000);
	await stillRunning(task.id, run.id);
	fixture.setClock(second + 3 * 3_600_000 + 21 * 60_000);
	expect((await ended(task.id, run.id)).status).toBe('timeout');

	fixture.setClock(START);
	rmSync(join(dir, 'hcom-calls.jsonl'), { force: true });
	hcomPlan([{ name: 'ask-stop' }]);
	const stop = await asking(task, 'ask-stop');
	expect((await send(`/api/automation/${task.id}/stop`, 'POST')).status).toBe(202);
	const stopped = await ended(task.id, stop.id);
	expect(stopped.status).toBe('stopped');
	expect(listed('ask-stop')).toBe(false);
	const cards = (await alerts()).filter((alert) => alert.runId === stop.id);
	expect(cards.map((alert) => [alert.kind, alert.resolved])).toEqual([['ask', 'ended']]);
});

test('a restart while it waits keeps taking the wait off (#675): the run taken over waits on past its limit, and after the answer has only its working time left', async () => {
	const task = await create({ limitMinutes: 60 });
	hcomPlan([{ name: 'ask-rest' }]);
	const run = await askingAt(task, 'ask-rest', START + 20 * 60_000);
	await fixture.stop();
	// Back 5 hours later, still waiting: the first check and the watch both leave it be.
	const back = START + 20 * 60_000 + 5 * 3_600_000;
	fixture.setClock(back);
	await fixture.start();
	cookie = await fixture.login();
	await stillRunning(task.id, run.id);
	expect((await viewOf(task.id)).state).toBe('asking');
	expect((await reply(task.id, '2 張')).status).toBe(200);
	await answered(task.id, run.id, 1);
	setStatus('ask-rest', 'active');
	fixture.setClock(back + 39 * 60_000);
	await stillRunning(task.id, run.id);
	fixture.setClock(back + 41 * 60_000);
	const late = await ended(task.id, run.id);
	expect([late.status, late.reason]).toEqual(['timeout', '超過上限 60 分鐘，已停止']);
});

test('a run that ends with a question still open does not carry its wait into the checker: the checker keeps its own limit (#675)', async () => {
	const task = await create({ limitMinutes: 10, review: { enabled: true, checklist: ['發票已開立'] } });
	// Gone agents are not closed: no close call sits between the two launches.
	hcomPlan([{ name: 'ask-gone' }, { name: 'chk-gone', client: 'codex' }]);
	const run = await asking(task, 'ask-gone');
	// Answered and done between two looks: gone from hcom with DONE last, the question never marked answered.
	appendFileSync(join(dir, 'transcripts', 's-ask-gone.jsonl'), JSON.stringify({ kind: 'assistant', time: null, text: 'DONE' }) + '\n');
	writeFileSync(join(dir, 'hcom-added.json'), '[]');
	const checking = await runWhen(task.id, run.id, (each) => each.status === 'success' && each.review?.sessionId === 's-chk-gone', 'the checker');
	expect(checking.asks!.at(-1)!.answeredAt).toBeUndefined();
	fixture.setClock(START + 9 * 60_000);
	await sleep(500);
	expect((await runsOf(task.id))[0].review?.status).toBe('checking');
	fixture.setClock(START + 11 * 60_000);
	const late = await runWhen(task.id, run.id, (each) => each.review?.status !== 'checking', 'the check to end');
	expect(late.review).toMatchObject({ status: 'error', ended: 'timeout', reason: '檢查沒有做完：超過上限 10 分鐘，已停止' });
});

const grant = { goal: '處理已知問題', done: ['挑出的票已合併到 dev'], scope: { ticket_confirmation: true, assume_defaults: false, prototype_decide: true } };
const unattendedAgent = () => ({ client: 'claude', model: 'claude-haiku-5-5', effort: 'low', folder: work, brief: 'docs/brief.md', unattended: grant });

test.each(['DECIDE', 'HELP'])('an unattended controller ending %s waits as 等你回覆, not failed; the answer sends it on and DONE ends it (#665)', async (tag) => {
	const task = await create({ agent: unattendedAgent() });
	const name = `un-${tag.toLowerCase()}`;
	hcomPlan([{ name }]);
	const started = await runNow(task.id);
	await runWhen(task.id, started.id, (run) => run.sessionId === `s-${name}`, `${name} to be listed`);
	turn(name, `授權範圍外，需要你決定。\n${tag}: ${QUESTION}`);
	const run = await runWhen(task.id, started.id, (each) => each.asks?.length === 1, 'the question to be recorded');
	expect(run.status).toBe('running');
	expect(run.asks).toEqual([{ question: QUESTION, askedAt: START }]);
	await sleep(500);
	expect(listed(name)).toBe(true);
	expect((await viewOf(task.id)).state).toBe('asking');
	expect(await yellow(run.id)).toHaveLength(1);

	expect((await reply(task.id, '2 張')).status).toBe(200);
	const after = await answered(task.id, run.id, 1);
	expect(after).toMatchObject({ status: 'running' });
	expect((await viewOf(task.id)).state).toBe('running');
	setStatus(name, 'active');
	await sleep(300);
	turn(name, '做完了，已 deactivate。\nDONE', '2 張');
	expect((await ended(task.id, run.id)).status).toBe('success');
});

test('an unattended controller ending ASK: still fails (#665)', async () => {
	const unattended = await create({ agent: unattendedAgent() });
	hcomPlan([{ name: 'un-ask' }]);
	const started = await runNow(unattended.id);
	await runWhen(unattended.id, started.id, (run) => run.sessionId === 's-un-ask', 'un-ask to be listed');
	turn('un-ask', `ASK: ${QUESTION}`);
	const failed = await ended(unattended.id, started.id);
	expect(failed.status).toBe('failed');
	expect(failed.asks).toBeUndefined();
});

test('a manual run ending DECIDE: still fails (#665)', async () => {
	const manual = await create({ name: '人工任務' });
	hcomPlan([{ name: 'man-decide' }]);
	const run = await runNow(manual.id);
	await runWhen(manual.id, run.id, (each) => each.sessionId === 's-man-decide', 'man-decide to be listed');
	turn('man-decide', `DECIDE: ${QUESTION}`);
	const ranOut = await ended(manual.id, run.id);
	expect(ranOut.status).toBe('failed');
	expect(ranOut.asks).toBeUndefined();
});

test.each([
	['unattended DECIDE', 'DECIDE', true],
	['unattended HELP', 'HELP', true],
	['manual ASK', 'ASK', false]
])('%s: a hcom message from another agent does not answer it, the panel answer (lat-panel) does, and the wait stays off the limit (#678)', async (_label, tag, unattended) => {
	const task = await create({ limitMinutes: 60, ...(unattended ? { agent: unattendedAgent() } : {}) });
	const name = `pan-${tag.toLowerCase()}`;
	hcomPlan([{ name }]);
	const started = await runNow(task.id);
	await runWhen(task.id, started.id, (run) => run.sessionId === `s-${name}`, `${name} to be listed`);
	turn(name, `需要你決定。\n${tag}: ${QUESTION}`);
	const run = await waitingOn(task.id, started.id, 1);

	// A helper agent reports in and the controller starts working: still waiting, hours later too.
	delivered(name, 'hcom');
	setStatus(name, 'active');
	fixture.setClock(START + 5 * 3_600_000);
	await sleep(600);
	const still = (await runsOf(task.id)).find((each) => each.id === run.id)!;
	expect([still.status, still.asks![0].answeredAt]).toEqual(['running', undefined]);
	expect((await viewOf(task.id)).state).toBe('asking');
	expect((await yellow(run.id))[0].dismissedAt).toBeUndefined();
	expect(listed(name)).toBe(true);

	// The answer the question panel delivers ends the wait; the time left counts from there.
	delivered(name, 'lat-panel');
	const after = await answered(task.id, run.id, 1);
	expect(after.asks![0]).toMatchObject({ answeredAt: START + 5 * 3_600_000, source: '終端' });
	expect((await viewOf(task.id)).state).toBe('running');
	fixture.setClock(START + 5 * 3_600_000 + 59 * 60_000);
	await sleep(600);
	expect((await runsOf(task.id)).find((each) => each.id === run.id)!.status).toBe('running');
});

test('a run left waiting, its answer missed, still ends when the agent replies DONE: success, agent closed, the question stays unanswered (#678)', async () => {
	const task = await create({ limitMinutes: 60 });
	hcomPlan([{ name: 'ask-missed' }]);
	const run = await asking(task, 'ask-missed');
	delivered('ask-missed', 'hcom');
	setStatus('ask-missed', 'active');
	await sleep(500);
	expect((await runsOf(task.id))[0].asks![0].answeredAt).toBeUndefined();
	// Only the agent's own reply, no input from the user.
	appendFileSync(join(dir, 'transcripts', 's-ask-missed.jsonl'), JSON.stringify({ kind: 'assistant', time: null, text: '另一位 Agent 已回報，全部做完。\nDONE' }) + '\n');
	setStatus('ask-missed', 'listening');
	const done = await ended(task.id, run.id);
	expect(done.status).toBe('success');
	expect(done.asks![0].answeredAt).toBeUndefined();
	expect(listed('ask-missed')).toBe(false);
});

test('a run left waiting, its answer missed, ends failed when the agent replies FAILED: agent closed, the question stays unanswered (#678)', async () => {
	const task = await create({ limitMinutes: 60 });
	hcomPlan([{ name: 'ask-missed-f' }]);
	const run = await asking(task, 'ask-missed-f');
	delivered('ask-missed-f', 'hcom');
	setStatus('ask-missed-f', 'active');
	await sleep(500);
	expect((await runsOf(task.id))[0].asks![0].answeredAt).toBeUndefined();
	appendFileSync(join(dir, 'transcripts', 's-ask-missed-f.jsonl'), JSON.stringify({ kind: 'assistant', time: null, text: '做不下去。\nFAILED: 合約檔打不開' }) + '\n');
	setStatus('ask-missed-f', 'listening');
	const failed = await ended(task.id, run.id);
	expect([failed.status, failed.reason]).toEqual(['failed', expect.stringContaining('合約檔打不開')]);
	expect(failed.asks![0].answeredAt).toBeUndefined();
	expect(listed('ask-missed-f')).toBe(false);
});
