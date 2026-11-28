// 事件任務 on the built board (#763): a LAT controller proposes one through the 任務提案 command,
// the user approves it with the board's passkey (a software authenticator), and the board waits for
// the event on its minute check (every 0.1 s here), with the board's clock set by the test. On the
// event, the deadline, 立即觸發 or 重試接手 it hands over to a new Agent through the fake hcom and
// Herdr, as an agent task's run; the handoff's first message, its run record with the attempt's
// delivery evidence, the task's state and its pushes (logged as `event_task_pushed`) are read back.
// Processes are looked up in a folder of the test's own, never the host's /proc. Each test has a
// board of its own (`event-task-fixture.ts`).
import { appendFileSync, chmodSync, readFileSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { logged, sleep } from '../harness.ts';
import { parsed, proposalsDir, stored, submit } from '../task-proposal-fixture.ts';
import { approved, call, cleanupEventBoard, done, eventually, fakeProcess, handoffRuns, hcomPlan, inState, launches, MINUTE, procDir, promptOf, proposal, pushes, setup, snapshot, T0, touchAt, viewOf } from '../event-task-fixture.ts';
afterEach(cleanupEventBoard);


test('only a controller proposes an event task; the checks refuse what the Spec rules out; the approved task keeps 事件, the controller and the brief copy, and cannot be edited', async () => {
	const s = await setup();
	const { board, ctrl, luna, work } = s;
	fakeProcess(4242, 1000);

	const fromAgent = parsed(await submit(board, luna, proposal(work, { type: 'process', pid: 4242 })));
	expect(fromAgent).toMatchObject({ ok: false, error: 'not-controller', reason: '事件任務只收 LAT 主控的提案' });
	const before = (await import('node:fs')).readdirSync(proposalsDir(board));
	expect(before.filter((name) => name.endsWith('.json'))).toEqual([]);

	const refused = async (event: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
		const reply = parsed(await submit(board, ctrl, proposal(work, event, extra)));
		expect(reply.status).toBe('invalid');
		return reply.errors as Record<string, string>;
	};
	expect((await refused({ type: 'process', pid: 4242 }, { repeat: true })).repeat).toBe('程序結束只能一次性');
	expect((await refused({ type: 'time', at: '2026-11-28T12:00' }, { repeat: true })).repeat).toBe('到達時間只能一次性');
	expect((await refused({ type: 'process', pid: 999 })).eventPid).toBe('程序 999 已不存在');
	expect((await refused({ type: 'file', path: join(work, 'out.txt') }, { deadlineMinutes: 7 * 24 * 60 + 1 })).deadlineMinutes).toBeTruthy();
	expect((await refused({ type: 'file', path: join(work, 'out.txt') }, { deadlineMinutes: 0 })).deadlineMinutes).toBeTruthy();
	// 09:00 in Taipei is 01:00 UTC, the board's clock now: already passed. Past the deadline too.
	expect((await refused({ type: 'time', at: '2026-11-28T09:00' })).eventAt).toBe('指定的時間已經過了');
	expect((await refused({ type: 'time', at: '2026-11-29T09:30' })).eventAt).toBe('指定的時間超過期限');
	expect((await refused({ type: 'log', path: 'logs/run.log', text: 'x' })).eventPath).toBeTruthy();
	expect((await refused({ type: 'file', path: join(work, 'out.txt') }, { agent: { client: 'claude', model: 'm', effort: 'low', folder: work, brief: 'brief.md', unattended: { goal: 'g', done: ['d'], scope: {} } } })).unattended).toBeTruthy();
	expect((await refused({ type: 'signal' })).event).toBeTruthy();

	// 新增任務 offers none.
	const formed = await call(board, 'POST', '/api/automation', { cookie: s.cookie, body: proposal(work, { type: 'file', path: join(work, 'out.txt') }) });
	expect(formed.status).toBe(400);

	const id = await approved(s, { type: 'process', pid: 4242 });
	const view = await viewOf(s, id);
	expect(view.task).toMatchObject({ trigger: 'event', kind: 'agent', limitMinutes: 60, event: { event: { type: 'process', pid: 4242, startTime: 1000 }, deadlineMinutes: 24 * 60, repeat: false, handoff: 'new-agent' } });
	expect(view.task.source).toMatchObject({ proposer: { name: 'grp-ctrl', client: 'claude', role: 'controller', folder: ctrl.folder, sessionId: 'session-ctrl' }, approvedAt: new Date(T0).toISOString() });
	expect(readFileSync(view.task.agent!.brief, 'utf8')).toBe('# 收完 Log 後整理\n');
	expect(view.event).toMatchObject({ state: 'waiting', since: T0, deadlineAt: T0 + 24 * 60 * MINUTE, canTrigger: true, canRetry: false });
	expect(stored(board, id.replace('proposal-', '')).task.event.event.startTime).toBe(1000);

	// A time that passed between the proposal and the approval: 核准失敗, no task.
	const late = parsed(await submit(board, ctrl, proposal(work, { type: 'time', at: '2026-11-28T09:10' })));
	board.setClock(T0 + 11 * MINUTE);
	const lateCard = await (await call(board, 'GET', `/api/task-proposals/${late.id}`, { cookie: s.cookie })).json();
	const { options: lateOptions } = await (await call(board, 'POST', `/api/task-proposals/${late.id}/challenge`, { cookie: s.cookie, body: { contentHash: lateCard.contentHash } })).json();
	const lateAnswer = await (await call(board, 'POST', `/api/task-proposals/${late.id}/approve`, { cookie: s.cookie, body: { response: s.passkey.answer(lateOptions) } })).json();
	expect(lateAnswer).toMatchObject({ status: 'approve-failed' });
	expect(lateAnswer.reason).toContain('指定的時間在核准時已經過了');

	const edited = await call(board, 'PUT', `/api/automation/${id}`, { cookie: s.cookie, body: { ...view.task, name: '改名' } });
	expect(edited.status).toBe(409);
	expect((await call(board, 'POST', `/api/automation/${id}/run`, { cookie: s.cookie })).status).toBe(409);
	// Existing 週期 tasks read as they are: no trigger, no event view.
	expect((await snapshot(s)).tasks.filter((entry) => !entry.task.trigger)).toEqual([]);
});

test('程序結束: the same start time waits; gone or a reused PID is the original ended; the handoff names the event, then 已接手 with this attempt\'s session, and a one-shot task is 已完成', async () => {
	const s = await setup();
	const { board } = s;
	fakeProcess(4242, 1000);
	const id = await approved(s, { type: 'process', pid: 4242 });
	hcomPlan(board, [s.ctrl, s.luna], ['evt-one']);
	await sleep(500);
	expect(launches(board)).toHaveLength(0);

	// The PID now belongs to another process: the original ended, the newcomer is not taken for it.
	fakeProcess(4242, 5000);
	const view = await inState(s, id, 'done');
	const [run] = handoffRuns(view);
	expect(run.trigger).toBe('event');
	expect(run.handoff).toMatchObject({ attempt: 1, occurrence: run.id, status: 'handed', evidence: { sessionId: 's-evt-one' }, event: { cause: 'event' } });
	const prompt = promptOf(launches(board)[0]);
	expect(prompt).toContain('你等的事件發生了');
	expect(prompt).toContain(`（${id}）`);
	expect(prompt).toContain('程序 4242 已結束');
	expect(prompt).toContain('結束碼：看板無法得知結束碼');
	expect(prompt).toContain(`讀取並照做 ${view.task.agent!.brief}`);
	done(board, 'evt-one');
	await eventually(async () => handoffRuns(await viewOf(s, id))[0].status === 'success', 'the handoff run to succeed');
	await sleep(400);
	expect(launches(board)).toHaveLength(1);
	expect((await viewOf(s, id)).event!.state).toBe('done');
});

test('檔案出現或更新, reusable: only a modification after the wait counts; at most one handoff at a time; it waits again from the run\'s end', async () => {
	const s = await setup();
	const { board, work } = s;
	const report = join(work, 'report.md');
	writeFileSync(report, 'old');
	touchAt(report, T0 - MINUTE);
	const id = await approved(s, { type: 'file', path: report }, { repeat: true });
	hcomPlan(board, [s.ctrl, s.luna], ['evt-f1']);
	await sleep(400);
	expect(launches(board)).toHaveLength(0);

	board.setClock(T0 + 10 * MINUTE);
	touchAt(report, T0 + 5 * MINUTE);
	await inState(s, id, 'running');
	expect(promptOf(launches(board)[0])).toContain(`檔案：${report}`);
	// Written again while the first handoff's run goes on: not stacked.
	touchAt(report, T0 + 9 * MINUTE);
	await sleep(400);
	expect(launches(board)).toHaveLength(1);
	board.setClock(T0 + 20 * MINUTE);
	done(board, 'evt-f1');
	const waiting = await inState(s, id, 'waiting');
	expect(waiting.event!.since).toBe(T0 + 20 * MINUTE);
	await sleep(400);
	expect(launches(board)).toHaveLength(1);
	hcomPlan(board, [s.ctrl, s.luna], ['evt-f2']);
	touchAt(report, T0 + 21 * MINUTE);
	await inState(s, id, 'running');
	expect(launches(board)).toHaveLength(2);
	expect(handoffRuns(await viewOf(s, id)).map((run) => run.handoff.attempt)).toEqual([1, 1]);
});

test('Log 檔出現指定文字: old content and other lines do not count; a matching line does, also without case; a replaced file already holding it does; a cut file is read from byte 0; a missing file says why and is tried again', async () => {
	const s = await setup();
	const { board, work } = s;
	const logFile = join(work, 'logs/collect.log');
	writeFileSync(logFile, 'start\nCOLLECT DONE (old run)\n');
	const id = await approved(s, { type: 'log', path: logFile, text: 'collect done', caseSensitive: false }, { repeat: true });
	hcomPlan(board, [s.ctrl, s.luna], ['evt-l1']);
	appendFileSync(logFile, 'still collecting\npartial COLLECT');
	await sleep(400);
	expect(launches(board)).toHaveLength(0);
	// The line ends: it is whole now and holds the text.
	appendFileSync(logFile, ' DONE at 10:02\n');
	await inState(s, id, 'running');
	expect(promptOf(launches(board)[0])).toContain('比對到的那一行：partial COLLECT DONE at 10:02');
	board.setClock(T0 + 5 * MINUTE);
	done(board, 'evt-l1');
	await inState(s, id, 'waiting');
	hcomPlan(board, [s.ctrl, s.luna], ['evt-l2']);

	// Rotated: another file under the name, already holding the text.
	const rotated = join(work, 'logs/new.log');
	writeFileSync(rotated, 'fresh file\ncollect done again\n');
	renameSync(rotated, logFile);
	await inState(s, id, 'running');
	expect(promptOf(launches(board)[1])).toContain('比對到的那一行：collect done again');
	board.setClock(T0 + 10 * MINUTE);
	done(board, 'evt-l2');
	await inState(s, id, 'waiting');
	hcomPlan(board, [s.ctrl, s.luna], ['evt-l3']);

	// Missing: shown on the task, and looked at again.
	rmSync(logFile);
	const missing = await eventually(async () => {
		const view = await viewOf(s, id);
		return view.event?.readError ? view : undefined;
	}, 'the read error');
	expect(missing.event!.readError).toBe('讀不到 Log 檔：檔案不存在');
	writeFileSync(logFile, 'x'.repeat(200) + '\n');
	await eventually(async () => !(await viewOf(s, id)).event?.readError, 'the read error to clear');
	// Cut shorter than what was read: from byte 0.
	truncateSync(logFile, 0);
	appendFileSync(logFile, 'Collect Done\n');
	await inState(s, id, 'running');
	expect(promptOf(launches(board)[2])).toContain('比對到的那一行：Collect Done');
});

test('到達時間 hands over once the Taipei time comes; 立即觸發 works only while waiting and says 使用者手動觸發', async () => {
	const s = await setup();
	const { board } = s;
	const id = await approved(s, { type: 'time', at: '2026-11-28T11:00' });
	hcomPlan(board, [s.ctrl, s.luna], ['evt-t1', 'evt-m1']);
	board.setClock(Date.parse('2026-11-28T02:59:00Z'));
	await sleep(400);
	expect(launches(board)).toHaveLength(0);
	board.setClock(Date.parse('2026-11-28T03:00:00Z'));
	await inState(s, id, 'done');
	expect(promptOf(launches(board)[0])).toContain('指定時間：2026/11/28 11:00:00（台灣時間）');
	// Not waiting any more.
	expect((await call(board, 'POST', `/api/automation/${id}/trigger`, { cookie: s.cookie })).status).toBe(409);

	const manual = await approved(s, { type: 'file', path: join(s.work, 'never.txt') }, { repeat: true });
	const paused = await call(board, 'POST', `/api/automation/${manual}/pause`, { cookie: s.cookie, body: { paused: true } });
	expect(paused.status).toBe(200);
	expect((await call(board, 'POST', `/api/automation/${manual}/trigger`, { cookie: s.cookie })).status).toBe(409);
	await call(board, 'POST', `/api/automation/${manual}/pause`, { cookie: s.cookie, body: { paused: false } });
	const triggered = await call(board, 'POST', `/api/automation/${manual}/trigger`, { cookie: s.cookie });
	expect(triggered.status).toBe(202);
	expect((await triggered.json()).handoff).toMatchObject({ status: 'handing', event: { cause: 'manual' } });
	await inState(s, manual, 'running');
	expect(promptOf(launches(board)[1])).toContain('使用者手動觸發');
	// Once going, no second one.
	expect((await call(board, 'POST', `/api/automation/${manual}/trigger`, { cookie: s.cookie })).status).toBe(409);
});

test('期限: no event hands over as 等到期限，事件沒有發生 with a push, a one-shot then 已完成, a reusable one 已到期; paused at the deadline is 已到期（暫停中） with a push and no handoff; resuming resets the wait', async () => {
	const s = await setup();
	const { board, work } = s;
	const once = await approved(s, { type: 'file', path: join(work, 'a.txt') }, { deadlineMinutes: 30 });
	const reusable = await approved(s, { type: 'file', path: join(work, 'b.txt') }, { deadlineMinutes: 30, repeat: true });
	const pausedTask = await approved(s, { type: 'file', path: join(work, 'c.txt') }, { deadlineMinutes: 60 });
	const resumed = await approved(s, { type: 'file', path: join(work, 'd.txt') }, { deadlineMinutes: 120 });
	await call(board, 'POST', `/api/automation/${pausedTask}/pause`, { cookie: s.cookie, body: { paused: true } });
	await call(board, 'POST', `/api/automation/${resumed}/pause`, { cookie: s.cookie, body: { paused: true } });
	hcomPlan(board, [s.ctrl, s.luna], ['evt-d1', 'evt-d2']);

	board.setClock(T0 + 30 * MINUTE);
	await inState(s, once, 'done');
	const expired = await inState(s, reusable, 'expired');
	expect(handoffRuns(expired)[0].handoff.event.cause).toBe('deadline');
	const prompts = launches(board).map(promptOf);
	expect(prompts).toHaveLength(2);
	for (const prompt of prompts) expect(prompt).toContain('等到期限，事件沒有發生');
	expect(pushes(board).filter((notice) => notice === 'deadline')).toHaveLength(2);

	// Paused across its deadline: ended with a push, nothing handed over.
	board.setClock(T0 + 60 * MINUTE);
	await inState(s, pausedTask, 'expired-paused');
	expect(handoffRuns(await viewOf(s, pausedTask))).toEqual([]);
	expect(pushes(board)).toContain('expired-paused');

	// Written while paused: not counted after 恢復.
	writeFileSync(join(work, 'd.txt'), 'x');
	touchAt(join(work, 'd.txt'), T0 + 61 * MINUTE);
	board.setClock(T0 + 62 * MINUTE);
	await call(board, 'POST', `/api/automation/${resumed}/pause`, { cookie: s.cookie, body: { paused: false } });
	const back = await inState(s, resumed, 'waiting');
	expect(back.event!.since).toBe(T0 + 62 * MINUTE);
	await sleep(400);
	expect(launches(board)).toHaveLength(2);
	expect(handoffRuns(await viewOf(s, resumed))).toEqual([]);
});

test('a handoff run going across the deadline gets no timeout handoff and the reusable task ends 已到期; an event seen with the deadline passed (after a restart) wins', async () => {
	const s = await setup();
	const { board, work } = s;
	const across = await approved(s, { type: 'file', path: join(work, 'a.txt') }, { deadlineMinutes: 30, repeat: true });
	hcomPlan(board, [s.ctrl, s.luna], ['evt-a1']);
	writeFileSync(join(work, 'a.txt'), 'x');
	touchAt(join(work, 'a.txt'), T0 + MINUTE);
	board.setClock(T0 + 2 * MINUTE);
	await inState(s, across, 'running');
	board.setClock(T0 + 40 * MINUTE);
	await sleep(400);
	expect(launches(board)).toHaveLength(1);
	done(board, 'evt-a1');
	await inState(s, across, 'expired');
	await sleep(300);
	expect(launches(board)).toHaveLength(1);
	expect(pushes(board)).not.toContain('deadline');

	const both = await approved(s, { type: 'file', path: join(work, 'b.txt') }, { deadlineMinutes: 30 });
	hcomPlan(board, [s.ctrl, s.luna], ['evt-b1']);
	await board.stop();
	writeFileSync(join(work, 'b.txt'), 'x');
	touchAt(join(work, 'b.txt'), T0 + 45 * MINUTE);
	board.setClock(T0 + 80 * MINUTE);
	await board.start();
	const view = await inState(s, both, 'done');
	expect(handoffRuns(view)[0].handoff.event.cause).toBe('event');
	expect(promptOf(launches(board)[1])).toContain('你等的事件發生了');
});

test('接手失敗 is not used up: a push, no automatic retry, 重試接手 only on the user\'s action and not while it runs; after the deadline a retry still works and closes by the 收尾規則', async () => {
	const s = await setup();
	const { board, work } = s;
	const once = await approved(s, { type: 'file', path: join(work, 'a.txt') }, { deadlineMinutes: 30 });
	const reusable = await approved(s, { type: 'file', path: join(work, 'b.txt') }, { deadlineMinutes: 30, repeat: true });
	hcomPlan(board, [s.ctrl, s.luna], [], { exit: 1, stderr: 'hcom: launch failed' });
	for (const name of ['a.txt', 'b.txt']) {
		writeFileSync(join(work, name), 'x');
		touchAt(join(work, name), T0 + MINUTE);
	}
	board.setClock(T0 + 2 * MINUTE);
	const failed = await inState(s, once, 'failed');
	await inState(s, reusable, 'failed');
	expect(handoffRuns(failed)[0].handoff).toMatchObject({ status: 'failed', attempt: 1 });
	expect(handoffRuns(failed)[0].handoff.reason).toContain('開不了 Agent');
	expect(failed.event).toMatchObject({ canRetry: true, canTrigger: false });
	expect(pushes(board).filter((notice) => notice === 'handoff-failed')).toHaveLength(2);
	expect((await call(board, 'POST', `/api/automation/${once}/trigger`, { cookie: s.cookie })).status).toBe(409);
	// Past the deadline: still 接手失敗, no timeout handoff, no retry by itself.
	board.setClock(T0 + 40 * MINUTE);
	await sleep(500);
	expect(launches(board)).toHaveLength(2);
	expect((await viewOf(s, once)).event!.state).toBe('failed');

	hcomPlan(board, [s.ctrl, s.luna], ['evt-r1', 'evt-r2'], { sleepMs: 1500 });
	const retried = await call(board, 'POST', `/api/automation/${once}/retry`, { cookie: s.cookie });
	expect(retried.status).toBe(202);
	const attempt = await retried.json();
	expect(attempt.handoff).toMatchObject({ attempt: 2, status: 'handing', event: handoffRuns(failed)[0].handoff.event, occurrence: handoffRuns(failed)[0].handoff.occurrence });
	// Disabled while that attempt goes.
	expect((await call(board, 'POST', `/api/automation/${once}/retry`, { cookie: s.cookie })).status).toBe(409);
	await inState(s, once, 'done');
	expect(await (await call(board, 'POST', `/api/automation/${reusable}/retry`, { cookie: s.cookie })).status).toBe(202);
	// A reusable task whose retry succeeded past its deadline: 已到期.
	await inState(s, reusable, 'expired');
});

test('stopped halfway through a handoff, the board never sends it again: with this attempt\'s evidence 已接手, without it 接手結果不明 with a push, whatever hcom lists; a retry of it is allowed', async () => {
	const s = await setup();
	const { board, work } = s;
	// Stopped after the record and before the launch came back.
	const before = await approved(s, { type: 'file', path: join(work, 'a.txt') });
	hcomPlan(board, [s.ctrl, s.luna], ['evt-x1'], { sleepMs: 5000 });
	writeFileSync(join(work, 'a.txt'), 'x');
	touchAt(join(work, 'a.txt'), T0 + MINUTE);
	board.setClock(T0 + 2 * MINUTE);
	await inState(s, before, 'handing');
	await eventually(async () => launches(board).length === 1, 'the launch to start');
	await board.stop();
	// The agent did come up: hcom lists it, but nothing in the record says this attempt reached it.
	const runsFile = join(board.dir, 'board-state/automation/runs', `${before}.jsonl`);
	const lines = readFileSync(runsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
	expect(lines.at(-1).handoff?.status ?? lines[0].handoff.status).toBe('handing');

	await board.start();
	const unknown = await inState(s, before, 'unknown');
	expect(handoffRuns(unknown)[0].handoff.reason).toBe('看板在接手途中停止，查不到這一次已送到的證據');
	expect(unknown.event!.canRetry).toBe(true);
	expect(pushes(board)).toContain('handoff-unknown');
	await sleep(400);
	expect(launches(board)).toHaveLength(1);

	// Stopped after this attempt's session was recorded and before the attempt was marked 已接手.
	const evidenced = await approved(s, { type: 'file', path: join(work, 'c.txt') });
	// And one stopped right after the record was written, before any launch.
	const recorded = await approved(s, { type: 'file', path: join(work, 'd.txt') });
	await board.stop();
	const early = `${(T0 + 3 * MINUTE).toString(36)}-0123456789`;
	writeFileSync(
		join(board.dir, 'board-state/automation/runs', `${recorded}.jsonl`),
		JSON.stringify({ id: early, taskId: recorded, trigger: 'event', period: '2026-11-28', startedAt: T0 + 3 * MINUTE, status: 'running', handoff: { occurrence: early, attempt: 1, event: { cause: 'event', at: T0 + 3 * MINUTE, details: [] }, status: 'handing' } }) + '\n'
	);
	const id = `${(T0 + 3 * MINUTE).toString(36)}-abcdef1234`;
	const handoff = { occurrence: id, attempt: 1, event: { cause: 'event', at: T0 + 3 * MINUTE, details: [] }, status: 'handing' };
	writeFileSync(
		join(board.dir, 'board-state/automation/runs', `${evidenced}.jsonl`),
		[{ id, taskId: evidenced, trigger: 'event', period: '2026-11-28', startedAt: T0 + 3 * MINUTE, status: 'running', handoff }, { id, agentName: 'evt-y1', launchedAt: T0 + 3 * MINUTE }, { id, sessionId: 's-evt-y1' }].map((line) => JSON.stringify(line)).join('\n') + '\n'
	);
	await board.start();
	const handed = await inState(s, evidenced, 'done');
	expect(handoffRuns(handed)[0].handoff).toMatchObject({ status: 'handed', evidence: { sessionId: 's-evt-y1' } });
	await inState(s, recorded, 'unknown');
	await sleep(300);
	expect(launches(board)).toHaveLength(1);

	hcomPlan(board, [s.ctrl, s.luna], ['evt-x2']);
	expect((await call(board, 'POST', `/api/automation/${before}/retry`, { cookie: s.cookie })).status).toBe(202);
	await inState(s, before, 'done');
});

test('after a restart, events still in evidence hand over; Log lines rotated away while the board was off do not', async () => {
	const s = await setup();
	const { board, work } = s;
	const kept = join(work, 'logs/kept.log');
	const rotated = join(work, 'logs/rotated.log');
	writeFileSync(kept, 'begin\n');
	writeFileSync(rotated, 'begin\n');
	const keptTask = await approved(s, { type: 'log', path: kept, text: 'FINISHED' });
	const rotatedTask = await approved(s, { type: 'log', path: rotated, text: 'FINISHED' });
	fakeProcess(777, 42);
	const processTask = await approved(s, { type: 'process', pid: 777 });
	hcomPlan(board, [s.ctrl, s.luna], ['evt-k1', 'evt-p1']);
	await sleep(300);
	await board.stop();
	appendFileSync(kept, 'FINISHED ok\n');
	appendFileSync(rotated, 'FINISHED ok\n');
	// Rotated away: a new file under the name, without the line.
	rmSync(rotated);
	writeFileSync(rotated, 'next log\n');
	rmSync(join(procDir(), '777'), { recursive: true });
	await board.start();
	await inState(s, keptTask, 'done');
	await inState(s, processTask, 'done');
	await sleep(500);
	expect((await viewOf(s, rotatedTask)).event!.state).toBe('waiting');
	expect(launches(board)).toHaveLength(2);
});

test('a Log file unreadable when the wait begins counts from its length at the first good read', async () => {
	const s = await setup();
	const { board, work } = s;
	const logFile = join(work, 'logs/locked.log');
	writeFileSync(logFile, 'READY from before\n');
	chmodSync(join(work, 'logs'), 0o000);
	const id = await approved(s, { type: 'log', path: logFile, text: 'READY' });
	hcomPlan(board, [s.ctrl, s.luna], ['evt-u1']);
	expect((await viewOf(s, id)).event!.readError).toContain('讀不到 Log 檔');
	chmodSync(join(work, 'logs'), 0o755);
	await eventually(async () => !(await viewOf(s, id)).event?.readError, 'the read error to clear');
	await sleep(400);
	expect(launches(board)).toHaveLength(0);
	appendFileSync(logFile, 'READY now\n');
	await inState(s, id, 'done');
	expect(promptOf(launches(board)[0])).toContain('比對到的那一行：READY now');
});

test('a reusable Log task whose run ended just before the board stopped sees a line written while it was off', async () => {
	const s = await setup();
	const { board, work } = s;
	const logFile = join(work, 'logs/ready.log');
	writeFileSync(logFile, 'begin\n');
	const id = await approved(s, { type: 'log', path: logFile, text: 'READY' }, { repeat: true });
	hcomPlan(board, [s.ctrl, s.luna], ['evt-z1']);
	appendFileSync(logFile, 'READY one\n');
	await inState(s, id, 'running');
	appendFileSync(logFile, 'READY while it ran\n');
	board.setClock(T0 + 5 * MINUTE);
	done(board, 'evt-z1');
	await inState(s, id, 'waiting');
	await board.stop();
	// As a board stopped after the run's end was recorded and before the new wait was saved: the wait
	// file still holds the wait before the handoff.
	const waitFile = join(board.dir, 'board-state/automation/events', `${id}.json`);
	writeFileSync(waitFile, JSON.stringify({ version: 1, since: T0, log: null }));
	appendFileSync(logFile, 'READY while the board was off\n');
	hcomPlan(board, [s.ctrl, s.luna], ['evt-z2']);
	await board.start();
	await inState(s, id, 'running');
	expect(launches(board)).toHaveLength(2);
	expect(promptOf(launches(board)[1])).toContain('比對到的那一行：READY while the board was off');
});
