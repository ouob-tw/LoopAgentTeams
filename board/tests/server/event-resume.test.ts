// 接回原主控 and 事件等待 on the built board (#764): a LAT controller (ctrl) proposes an event task
// that hands back to itself, the user approves it, and the controller runs `task-proposal.py away`
// (為事件任務暫停並關閉自己). The board writes the 事件等待 record in the test's pause folder and
// closes the controller through the fake hcom; on the event it resumes the session (`hcom r`) with
// the event message, or sends one HCOM message (the fake's `send --json` receipt) when the controller
// runs. Every hcom call goes to the fake, every folder is the test's own.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { jsonLines, logged, sleep, type Fixture } from '../harness.ts';
import { asAgent, listed, parsed } from '../task-proposal-fixture.ts';
import { approved, call, cleanupEventBoard, eventually, handoffRuns, inState, MINUTE, pushes, setup, T0, touchAt, viewOf, type Board } from '../event-task-fixture.ts';

afterEach(cleanupEventBoard);

const pausedDir = (board: Fixture) => board.serverEnv().LAT_HCOM_PAUSED_DIR;
const pauseFile = (board: Fixture) => join(pausedDir(board), 'session-ctrl.json');
const pauseRecord = (board: Fixture) => (existsSync(pauseFile(board)) ? JSON.parse(readFileSync(pauseFile(board), 'utf8')) : null);
const hcomCalls = (board: Fixture) => jsonLines(join(board.dir, 'hcom-calls.jsonl')) as { args: string[] }[];
const resumes = (board: Fixture) => hcomCalls(board).filter((entry) => entry.args[0] === 'r');
/** The board's sends to the controller; the 任務提案 result messages to it are not among them. */
const sends = (board: Fixture) => ((existsSync(join(board.dir, 'hcom-send-calls.jsonl')) ? jsonLines(join(board.dir, 'hcom-send-calls.jsonl')) : []) as { args: string[]; text: string }[]).filter((entry) => entry.args.includes('--json'));
const promptOf = (entry: { args: string[] }) => entry.args[entry.args.indexOf('--hcom-prompt') + 1];

/** ctrl as hcom lists it on its link, in its Herdr pane. */
const ctrlListed = (s: Board, overrides: Record<string, unknown> = {}) => listed(s.ctrl, { launch_context: { process_id: s.ctrl.processId, pane_id: 'wW:p-ctrl' }, ...overrides });

/** ctrl running in a pane of the Work workspace, listed by hcom; `resumed` is what `hcom r` brings back. */
function ctrlRunning(s: Board, extra: object = {}) {
	const herdr = JSON.parse(readFileSync(join(s.board.dir, 'herdr.json'), 'utf8'));
	herdr.tabs.push({ tab_id: 'wW:t-ctrl', label: 'ctrl', workspace_id: 'wW' });
	herdr.panes.push({ pane_id: 'wW:p-ctrl', workspace_id: 'wW', cwd: s.ctrl.folder, tab_id: 'wW:t-ctrl' });
	herdr.agents.push({ agent: 'claude', agent_status: 'idle', cwd: s.ctrl.folder, pane_id: 'wW:p-ctrl', tab_id: 'wW:t-ctrl', workspace_id: 'wW', agent_session: { value: 'session-ctrl' } });
	writeFileSync(join(s.board.dir, 'herdr.json'), JSON.stringify(herdr));
	s.board.setHcom({ agents: [ctrlListed(s), listed(s.luna)], resumed: ctrlListed(s, { launch_context: { process_id: s.ctrl.processId, pane_id: 'wW:p-back' } }), ...extra });
}

/** The fake hcom's plan with ctrl gone (closed) and `resumed` as the session it brings back. */
function ctrlClosed(s: Board, extra: object = {}) {
	s.board.setHcom({ agents: [listed(s.luna)], resumed: ctrlListed(s, { launch_context: { process_id: s.ctrl.processId, pane_id: 'wW:p-back' } }), ...extra });
}

const resumeTask = (s: Board, event: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
	approved(s, event, { kind: undefined, agent: undefined, limitMinutes: undefined, handoff: 'resume', ...extra });

/** The board's read has ctrl in Herdr, so it knows its pane and can close it. */
const seenInHerdr = (s: Board) =>
	eventually(async () => {
		const read = await (await call(s.board, 'POST', '/api/refresh', { cookie: s.cookie })).json();
		return read.agents?.some((agent: { id: string }) => agent.id === 'session-ctrl');
	}, 'the board to see ctrl in Herdr');

/** The board closed ctrl: after this the fake hcom's plan is the test's again (a kill rewrites it). */
const closedOnce = (s: Board, count = 1) => eventually(async () => logged(s.board.serverOutput(), 'event_task_away_closed').length >= count, 'ctrl to be closed');

const away = async (s: Board, task: string) => parsed(await asAgent(s.board, s.ctrl, ['--json', 'away', task]));

test('暫停並關閉自己 closes the controller and leaves its LAT session, a 事件等待 record that refreshes keep and the roster text; on the event its session is resumed with the event message and the record goes; a later event while it runs is one HCOM message', async () => {
	const s = await setup({ LAT_BOARD_EVENT_AWAY_CLOSE_SECONDS: '0.2' });
	const { board, work } = s;
	ctrlRunning(s);
	const sessionFile = join(s.ctrl.folder, '.lat/sessions/session-ctrl.json');
	const session = readFileSync(sessionFile, 'utf8');
	const task = await resumeTask(s, { type: 'file', path: join(work, 'out.txt') }, { repeat: true });
	expect((await viewOf(s, task)).task).not.toHaveProperty('agent');

	// Only for its own 接回原主控 task: a plain agent is refused, a task ID that is not there too.
	expect(await asAgent(board, s.luna, ['--json', 'away', task]).then(parsed)).toMatchObject({ ok: false, error: 'not-yours' });
	expect(await away(s, 'proposal-000000000000')).toMatchObject({ ok: false, error: 'not-found' });
	expect(pauseRecord(board)).toBeNull();

	await seenInHerdr(s);
	expect(await away(s, task)).toMatchObject({ ok: true, id: task, status: 'away' });
	expect(pauseRecord(board)).toMatchObject({ session_id: 'session-ctrl', hcom_name: 'grp-ctrl', client: 'claude', pane: 'wW:p-ctrl', reason: 'event-task', task_id: task });
	await closedOnce(s);
	expect(hcomCalls(board).some((entry) => entry.args[0] === 'kill' && entry.args[1] === 'grp-ctrl')).toBe(true);
	// Closed, its pane gone: refreshes keep the record, the LAT session record is as it was.
	for (let read = 0; read < 3; read++) await call(board, 'POST', '/api/refresh', { cookie: s.cookie });
	await sleep(300);
	expect(pauseRecord(board)).toMatchObject({ reason: 'event-task', task_id: task });
	expect(readFileSync(sessionFile, 'utf8')).toBe(session);

	// The roster: the controller as the helper still binds it, waiting for its task.
	board.list([board.bound('ctrl', 'grp-ctrl', { session_id: 'session-ctrl', workspace: s.ctrl.folder })]);
	await call(board, 'POST', '/api/refresh', { cookie: s.cookie });
	const roster = await eventually(async () => (await (await call(board, 'GET', '/api/board', { cookie: s.cookie })).json()).controllers?.find((entry: { id: string }) => entry.id === 'session-ctrl'), 'ctrl on the roster');
	expect(roster).toMatchObject({ paused: true, eventWait: { taskId: task, taskName: '收 Log 後整理' } });
	expect(roster.status).not.toBe('closed');

	// The event: the closed session resumed in its workspace with the event message.
	ctrlClosed(s);
	writeFileSync(join(work, 'out.txt'), 'x');
	touchAt(join(work, 'out.txt'), T0 + MINUTE);
	board.setClock(T0 + 2 * MINUTE);
	const back = await eventually(async () => {
		const view = await viewOf(s, task);
		return handoffRuns(view)[0]?.handoff.status === 'handed' && view.event?.state === 'waiting' && view;
	}, 'the resume to be 已接手 and the task to wait again');
	expect(resumes(board)).toHaveLength(1);
	expect(resumes(board)[0].args.slice(0, 2)).toEqual(['r', 'session-ctrl']);
	const message = promptOf(resumes(board)[0]);
	expect(message).toContain('你等的事件發生了');
	expect(message).toContain(`（${task}）`);
	expect(message).toContain(join(work, 'out.txt'));
	expect(message).toContain('照平常的恢復程序繼續');
	expect(handoffRuns(back)[0]).toMatchObject({ status: 'success', handoff: { status: 'handed', evidence: { sessionId: 'session-ctrl' } } });
	expect(handoffRuns(back)[0].handoff.evidence).toHaveProperty('resumed');
	expect(pauseRecord(board)).toBeNull();
	expect(sends(board)).toHaveLength(0);

	// It runs now (as `hcom r` listed it): the next event is one HCOM message, not a second copy.
	board.setHcom({ agents: [ctrlListed(s), listed(s.luna)] });
	touchAt(join(work, 'out.txt'), T0 + 3 * MINUTE);
	board.setClock(T0 + 4 * MINUTE);
	const sent = await eventually(async () => {
		const view = await viewOf(s, task);
		return handoffRuns(view).length === 2 && handoffRuns(view)[0].handoff.status === 'handed' && view;
	}, 'the message to be 已接手');
	expect(sends(board)).toHaveLength(1);
	expect(sends(board)[0].args).toEqual(['send', '@grp-ctrl', '--json', '--intent', 'inform', '--from', 'lat-board']);
	expect(sends(board)[0].text).toContain('你等的事件發生了');
	// The fake's receipt ID: 9000 plus its sends so far, the 任務提案 result message among them.
	expect(handoffRuns(sent)[0].handoff.evidence).toEqual({ messageId: expect.stringMatching(/^90\d\d$/), to: 'grp-ctrl' });
	expect(resumes(board)).toHaveLength(1);
	// Delivered is done: busy or not, a third event is sent again.
	touchAt(join(work, 'out.txt'), T0 + 5 * MINUTE);
	board.setClock(T0 + 6 * MINUTE);
	await eventually(async () => sends(board).length === 2, 'the third event to be sent');
});

test('接手失敗 and 接手結果不明 keep the 事件等待 record; the record goes with the task on deletion and on 已到期（暫停中）, each with the push', async () => {
	const s = await setup({ LAT_BOARD_EVENT_AWAY_CLOSE_SECONDS: '0.1' });
	const { board, work } = s;
	ctrlRunning(s);
	await seenInHerdr(s);
	const task = await resumeTask(s, { type: 'file', path: join(work, 'a.txt') });
	expect(await away(s, task)).toMatchObject({ ok: true });
	await closedOnce(s);

	// hcom cannot resume it: 接手失敗 with a push, the record kept.
	ctrlClosed(s, { exit: 1, stderr: 'no such session', resumed: null });
	writeFileSync(join(work, 'a.txt'), 'x');
	touchAt(join(work, 'a.txt'), T0 + MINUTE);
	board.setClock(T0 + 2 * MINUTE);
	const failed = await inState(s, task, 'failed');
	expect(handoffRuns(failed)[0].handoff.reason).toContain('接回失敗');
	expect(pushes(board)).toContain('handoff-failed');
	expect(pauseRecord(board)).toMatchObject({ reason: 'event-task', task_id: task });

	// A retry whose resume hcom reports still starting: 接手結果不明, the record kept.
	ctrlClosed(s, { exit: 2, resumed: null });
	expect((await call(board, 'POST', `/api/automation/${task}/retry`, { cookie: s.cookie })).status).toBe(202);
	await inState(s, task, 'unknown');
	expect(pushes(board)).toContain('handoff-unknown');
	expect(pauseRecord(board)).toMatchObject({ reason: 'event-task', task_id: task });

	// Deleted: the record goes, and the user hears the controller still waits.
	expect((await call(board, 'DELETE', `/api/automation/${task}`, { cookie: s.cookie })).status).toBe(204);
	expect(pauseRecord(board)).toBeNull();
	expect(logged(board.serverOutput(), 'event_task_pushed').find((line) => line.task_id === task && line.notice === 'controller-waiting')).toMatchObject({ controller: 'grp-ctrl' });

	// Paused at its deadline: 已到期（暫停中）, the record goes, one push naming the controller.
	ctrlRunning(s);
	await seenInHerdr(s);
	const second = await resumeTask(s, { type: 'file', path: join(work, 'b.txt') }, { deadlineMinutes: 30 });
	expect(await away(s, second)).toMatchObject({ ok: true });
	await closedOnce(s, 2);
	expect((await call(board, 'POST', `/api/automation/${second}/pause`, { cookie: s.cookie, body: { paused: true } })).status).toBe(200);
	board.setClock(T0 + 3 * MINUTE + 31 * MINUTE);
	await inState(s, second, 'expired-paused');
	await eventually(async () => pauseRecord(board) === null, 'the record to go');
	const expiredPush = logged(board.serverOutput(), 'event_task_pushed').find((line) => line.task_id === second);
	expect(expiredPush).toMatchObject({ notice: 'expired-paused', controller: 'grp-ctrl' });
});

test('stopped after the event and before the resume came back, the restarted board writes the 事件等待 record again before anything else and never resumes twice; one stopped after a confirmed resume removes it', async () => {
	const s = await setup({ LAT_BOARD_EVENT_AWAY_CLOSE_SECONDS: '0.1' });
	const { board, work } = s;
	ctrlRunning(s);
	await seenInHerdr(s);
	const task = await resumeTask(s, { type: 'file', path: join(work, 'a.txt') });
	expect(await away(s, task)).toMatchObject({ ok: true });
	await closedOnce(s);

	// The resume hangs; the board stops while it is on its way.
	ctrlClosed(s, { sleepMs: 5000 });
	writeFileSync(join(work, 'a.txt'), 'x');
	touchAt(join(work, 'a.txt'), T0 + MINUTE);
	board.setClock(T0 + 2 * MINUTE);
	await inState(s, task, 'handing');
	await eventually(async () => resumes(board).length === 1, 'the resume to start');
	await board.stop();
	// Lost meanwhile (as by hand): the start writes it again from the task's own records.
	rmSync(pauseFile(board), { force: true });
	ctrlClosed(s);
	await board.start();
	const unknown = await inState(s, task, 'unknown');
	expect(handoffRuns(unknown)[0].handoff.reason).toBe('看板在接手途中停止，查不到這一次已送到的證據');
	expect(pauseRecord(board)).toMatchObject({ session_id: 'session-ctrl', reason: 'event-task', task_id: task });
	const rebuilt = logged(board.serverOutput(), 'event_task_away_rebuilt');
	expect(rebuilt.length).toBeGreaterThan(0);
	await sleep(400);
	expect(resumes(board)).toHaveLength(1);

	// Stopped after the confirmed resume was written and before the record went: removed at the start.
	expect((await call(board, 'POST', `/api/automation/${task}/retry`, { cookie: s.cookie })).status).toBe(202);
	await inState(s, task, 'done');
	expect(pauseRecord(board)).toBeNull();
	await board.stop();
	writeFileSync(join(board.dir, 'board-state/automation/away', `${task}.json`), JSON.stringify({ version: 1, taskId: task, sessionId: 'session-ctrl', hcomName: 'grp-ctrl', client: 'claude', pane: null, workspace: 'wW', pausedAt: new Date(T0).toISOString() }));
	await board.start();
	await eventually(async () => (await viewOf(s, task))?.event?.state === 'done', 'the board back');
	expect(pauseRecord(board)).toBeNull();
	expect(existsSync(join(board.dir, 'board-state/automation/away', `${task}.json`))).toBe(false);
});

test('a crash before the send with the controller already in HCOM is 接手結果不明, never 已接手; with the message ID on record it is 已接手', async () => {
	const s = await setup();
	const { board, work } = s;
	const unsent = await resumeTask(s, { type: 'file', path: join(work, 'a.txt') });
	const sentTask = await resumeTask(s, { type: 'file', path: join(work, 'b.txt') });
	await board.stop();
	// Both written as 接手中 before anything was sent; the second has this attempt's message ID.
	const at = T0 + MINUTE;
	const line = (taskId: string, id: string, extra: object = {}) =>
		JSON.stringify({ id, taskId, trigger: 'event', period: '2026-11-28', startedAt: at, status: 'running', handoff: { occurrence: id, attempt: 1, event: { cause: 'event', at, details: [] }, status: 'handing', ...extra } }) + '\n';
	writeFileSync(join(board.dir, 'board-state/automation/runs', `${unsent}.jsonl`), line(unsent, `${at.toString(36)}-aaaaaaaaaa`));
	writeFileSync(join(board.dir, 'board-state/automation/runs', `${sentTask}.jsonl`), line(sentTask, `${at.toString(36)}-bbbbbbbbbb`, { evidence: { messageId: '77', to: 'grp-ctrl' } }));
	// The controller runs on its link the whole time.
	board.setHcom({ agents: [ctrlListed(s), listed(s.luna)] });
	await board.start();
	const unknown = await inState(s, unsent, 'unknown');
	expect(handoffRuns(unknown)[0].handoff.status).toBe('unknown');
	const handed = await inState(s, sentTask, 'done');
	expect(handoffRuns(handed)[0]).toMatchObject({ status: 'success', handoff: { status: 'handed', evidence: { messageId: '77' } } });
	await sleep(300);
	expect(sends(board)).toHaveLength(0);
	expect(resumes(board)).toHaveLength(0);
});

test('a 開新 Agent task writes no 事件等待 record: 暫停並關閉自己 is refused', async () => {
	const s = await setup();
	const task = await approved(s, { type: 'file', path: join(s.work, 'a.txt') });
	expect(await away(s, task)).toMatchObject({ ok: false, error: 'not-resume' });
	expect(pauseRecord(s.board)).toBeNull();
	expect(hcomCalls(s.board).some((entry) => entry.args[0] === 'kill')).toBe(false);
});
