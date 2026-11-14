// The 自動化 scheduler on the built board, driven by a clock the test sets and a check every 0.1 s,
// with the server's own zone set to UTC so every day and set time must be read in Asia/Taipei: the
// day's one automatic try, retry the next day, stop once the period succeeded, a try at once after a
// restart, missed periods (one by one after a long stop, one notice per task, dismissed, not while
// paused), the limit counted from the start, runs kept in the period they started in, 沿用原紀錄,
// and a try that comes due while the task still runs.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { logged, sleep, startFixture, type Fixture } from '../harness.ts';
import type { AutomationRun, AutomationSnapshot, AutomationTask, AutomationTaskView } from '../../src/lib/board/automation.ts';

/** A wall-clock time in Asia/Taipei. */
const tpe = (year: number, month: number, day: number, hour = 12, minute = 0) => Date.UTC(year, month - 1, day, hour - 8, minute);
/** Long enough for several checks to have run: what has not happened by then will not. */
const SETTLE_MS = 700;

let fixture: Fixture | undefined;
let cookie: string;
let work: string;

afterEach(async () => {
	await fixture?.cleanup();
	fixture = undefined;
});

async function open(time: number): Promise<Fixture> {
	fixture = await startFixture({ env: { TZ: 'UTC', LAT_BOARD_AUTOMATION_TICK_SECONDS: '0.1' } });
	fixture.setClock(time);
	// The board's first check ran on the real time; let one run on the test's, so periods are looked
	// at from here.
	await sleep(SETTLE_MS);
	cookie = await fixture.login();
	work = join(fixture.dir, 'work');
	mkdirSync(work, { recursive: true });
	return fixture;
}

/** Stop the board, move the clock while it is down, start it again. */
async function restartAt(time: number): Promise<void> {
	await fixture!.stop();
	fixture!.setClock(time);
	await fixture!.start();
}

/** A logged-in request; the clock jumps weeks ahead here, past a login's idle limit, so an expired
 *  login is made again once. */
async function authed(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
	const response = await fixture!.fetch(path, { ...init, cookie });
	if (response.status !== 401) return response;
	cookie = await fixture!.login();
	return fixture!.fetch(path, { ...init, cookie });
}
const send = (path: string, method: string, body?: unknown) =>
	authed(path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const snapshot = async (): Promise<AutomationSnapshot> => (await authed('/api/automation')).json();
const viewOf = async (id: string): Promise<AutomationTaskView> => (await snapshot()).tasks.find((view) => view.task.id === id)!;
const autoRuns = async (id: string) => (await viewOf(id)).runs.filter((run) => run.trigger === 'auto');

function commandTask(schedule: object, line: string, overrides: Record<string, unknown> = {}) {
	return {
		name: '排程測試',
		schedule,
		time: '10:00',
		limitMinutes: 30,
		kind: 'command',
		command: { command: line, folder: work, checks: [] },
		review: { enabled: false, checklist: [] },
		...overrides
	};
}

async function create(body: unknown): Promise<AutomationTask> {
	const response = await send('/api/automation', 'POST', body);
	expect(response.status).toBe(201);
	return response.json();
}

async function eventually<T>(read: () => Promise<T | undefined | false>, what: string, timeoutMs = 8_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(50);
	}
}

/** Wait for the task's runs to number `count` in all, every one ended; the newest first. */
const ended = (id: string, count: number) =>
	eventually(async () => {
		const runs = (await viewOf(id)).runs;
		return runs.length === count && runs.every((run) => run.status !== 'running') ? runs : undefined;
	}, `${count} ended runs`);

/** Set the clock and let the checks run. */
async function at(time: number): Promise<void> {
	fixture!.setClock(time);
	await sleep(SETTLE_MS);
}

const missedLogs = (taskId: string) => logged(fixture!.serverOutput(), 'automation periods missed').filter((line) => line.task_id === taskId);

test('the day’s one try at the set time: a quick failure waits for the next day, success ends the period, a manual run uses no try', async () => {
	await open(tpe(2026, 11, 2, 9));
	const task = await create(commandTask({ type: 'monthly', fromDay: 1, toDay: 5 }, 'echo broke; exit 1'));
	// Before the set time nothing starts, and the next try shown is today's, in Taipei time.
	await at(tpe(2026, 11, 2, 9, 30));
	expect((await viewOf(task.id)).runs).toEqual([]);
	expect((await viewOf(task.id)).nextAt).toBe(tpe(2026, 11, 2, 10));
	// 立即執行 before the set time does not use up the day's try.
	expect((await send(`/api/automation/${task.id}/run`, 'POST')).status).toBe(202);
	await ended(task.id, 1);
	await at(tpe(2026, 11, 2, 10, 1));
	const [first] = await ended(task.id, 2);
	expect(first).toMatchObject({ trigger: 'auto', status: 'failed', period: '2026-11', startedAt: tpe(2026, 11, 2, 10, 1) });
	// Failed fast: no second try the same day, and the next one is tomorrow's.
	await at(tpe(2026, 11, 2, 15));
	expect(await autoRuns(task.id)).toHaveLength(1);
	expect((await viewOf(task.id)).nextAt).toBe(tpe(2026, 11, 3, 10));
	await at(tpe(2026, 11, 3, 10, 0));
	await ended(task.id, 3);
	expect(await autoRuns(task.id)).toHaveLength(2);
	// Fixed, and the next day's try succeeds: the period is done and no other try starts in it.
	expect((await send(`/api/automation/${task.id}`, 'PUT', commandTask({ type: 'monthly', fromDay: 1, toDay: 5 }, 'echo ok'))).status).toBe(200);
	await at(tpe(2026, 11, 4, 10, 5));
	const runs = await ended(task.id, 4);
	expect(runs[0]).toMatchObject({ trigger: 'auto', status: 'success' });
	expect((await viewOf(task.id)).state).toBe('done');
	expect((await viewOf(task.id)).nextAt).toBe(tpe(2026, 12, 1, 10));
	await at(tpe(2026, 11, 5, 10, 5));
	expect((await viewOf(task.id)).runs).toHaveLength(4);
	// The next period's window opens: tried again.
	await at(tpe(2026, 12, 1, 10, 0));
	await ended(task.id, 5);
	expect((await viewOf(task.id)).runs[0]).toMatchObject({ trigger: 'auto', period: '2026-12' });
}, 60_000);

test('a restart before or after the set time tries at once when today is in the window, untried and the period not done', async () => {
	await open(tpe(2026, 11, 2, 7));
	const before = await create(commandTask({ type: 'daily' }, 'echo ok', { name: '早上重啟' }));
	const after = await create(commandTask({ type: 'monthly', fromDay: 1, toDay: 5 }, 'exit 1', { name: '下午重啟', time: '13:00' }));
	const paused = await create(commandTask({ type: 'daily' }, 'echo ok', { name: '暫停中' }));
	expect((await send(`/api/automation/${paused.id}/pause`, 'POST', { paused: true })).status).toBe(200);
	// Down over night; back at 07:30, before the 10:00 set time: tried at once.
	await restartAt(tpe(2026, 11, 3, 7, 30));
	expect((await ended(before.id, 1))[0]).toMatchObject({ trigger: 'auto', status: 'success', startedAt: tpe(2026, 11, 3, 7, 30), period: '2026-11-03' });
	expect((await ended(after.id, 1))[0]).toMatchObject({ trigger: 'auto', status: 'failed' });
	expect((await viewOf(paused.id)).runs).toEqual([]);
	// Back again the same day, after the set time: both were tried today already.
	await restartAt(tpe(2026, 11, 3, 14));
	await sleep(SETTLE_MS);
	expect((await viewOf(before.id)).runs).toHaveLength(1);
	expect((await viewOf(after.id)).runs).toHaveLength(1);
	// The next day, after the set time: the failed one is tried at once; the daily one's new day too.
	await restartAt(tpe(2026, 11, 4, 14));
	expect((await ended(after.id, 2))[0]).toMatchObject({ trigger: 'auto', startedAt: tpe(2026, 11, 4, 14) });
	expect((await ended(before.id, 2))[0]).toMatchObject({ trigger: 'auto', period: '2026-11-04' });
	// A period done is not tried on a restart.
	const done = await create(commandTask({ type: 'monthly', fromDay: 1, toDay: 5 }, 'echo ok', { name: '已完成', time: '23:00' }));
	expect((await send(`/api/automation/${done.id}/run`, 'POST')).status).toBe(202);
	await ended(done.id, 1);
	await restartAt(tpe(2026, 11, 5, 8));
	await sleep(SETTLE_MS);
	expect(await autoRuns(done.id)).toEqual([]);
	expect((await viewOf(paused.id)).runs).toEqual([]);
}, 60_000);

test('a manual run that fails after the period succeeded leaves the period done', async () => {
	await open(tpe(2026, 11, 2, 10, 30));
	const task = await create(commandTask({ type: 'monthly', fromDay: 1, toDay: 5 }, 'echo ok'));
	await at(tpe(2026, 11, 2, 10, 31));
	await ended(task.id, 1);
	expect((await send(`/api/automation/${task.id}`, 'PUT', commandTask({ type: 'monthly', fromDay: 1, toDay: 5 }, 'exit 4'))).status).toBe(200);
	expect((await send(`/api/automation/${task.id}/run`, 'POST')).status).toBe(202);
	const runs = await ended(task.id, 2);
	expect(runs[0]).toMatchObject({ trigger: 'manual', status: 'failed' });
	expect((await viewOf(task.id)).state).toBe('done');
	await at(tpe(2026, 11, 3, 10, 30));
	expect(await autoRuns(task.id)).toHaveLength(1);
}, 30_000);

test('back late on the window’s last day: tried, not missed; a window passed with no run is missed, once per period, one notice per task', async () => {
	await open(tpe(2026, 11, 7, 12));
	const late = await create(commandTask({ type: 'monthly', fromDay: 8, toDay: 10 }, 'echo ok', { name: '最後一天晚上', time: '08:00' }));
	// Set late in the day, so once resumed at 23:30 no check before midnight finds it due.
	const gone = await create(commandTask({ type: 'monthly', fromDay: 8, toDay: 10 }, 'echo ok', { name: '整段錯過', time: '23:45' }));
	const weekly = await create(commandTask({ type: 'weekly', fromWeekday: 1, toWeekday: 1 }, 'echo ok', { name: '每週錯過', time: '08:00' }));
	const paused = await create(commandTask({ type: 'monthly', fromDay: 8, toDay: 10 }, 'echo ok', { name: '暫停不算錯過', time: '08:00' }));
	await send(`/api/automation/${paused.id}/pause`, 'POST', { paused: true });
	await send(`/api/automation/${gone.id}/pause`, 'POST', { paused: true });
	// Down from the 7th until 23:30 on the 10th, the last day: tried at once, the period done.
	await restartAt(tpe(2026, 11, 10, 23, 30));
	expect((await ended(late.id, 1))[0]).toMatchObject({ trigger: 'auto', status: 'success', period: '2026-11' });
	// The weekly one's Monday (11/9) was passed while down: missed, as soon as the board is back.
	await eventually(async () => (await viewOf(weekly.id)).state === 'missed', 'the week to be missed');
	await send(`/api/automation/${gone.id}/pause`, 'POST', { paused: false });
	await sleep(SETTLE_MS);
	expect((await viewOf(gone.id)).runs).toEqual([]);
	// Midnight passes with the board up: the window ended with no run of the resumed one.
	await at(tpe(2026, 11, 11, 0, 1));
	expect((await viewOf(late.id)).state).toBe('done');
	expect((await viewOf(late.id)).missed).toEqual([]);
	const missed = await viewOf(gone.id);
	expect(missed.state).toBe('missed');
	expect(missed.runs).toEqual([]);
	expect(missed.missed).toEqual([{ period: '2026-11', from: tpe(2026, 11, 8, 0), to: tpe(2026, 11, 11, 0), recordedAt: expect.any(Number) }]);
	expect(missedLogs(gone.id)).toHaveLength(1);
	expect((await viewOf(paused.id)).missed).toEqual([]);
	// More checks and a restart do not record it again.
	await restartAt(tpe(2026, 11, 11, 9));
	await sleep(SETTLE_MS);
	expect(missedLogs(gone.id)).toHaveLength(1);
	expect((await viewOf(gone.id)).missed).toHaveLength(1);
	// No catching up on its own.
	expect((await viewOf(gone.id)).runs).toEqual([]);
}, 60_000);

test('back after months: each period missed is listed, one notice per task, no catching up; 這期就算了 stops showing them and 立即執行 still works', async () => {
	await open(tpe(2026, 11, 7, 12));
	const monthly = await create(commandTask({ type: 'monthly', fromDay: 8, toDay: 10 }, 'echo ok', { name: '每月', time: '08:00' }));
	const daily = await create(commandTask({ type: 'daily' }, 'echo ok', { name: '每天', time: '08:00' }));
	const paused = await create(commandTask({ type: 'monthly', fromDay: 8, toDay: 10 }, 'echo ok', { name: '暫停中' }));
	await send(`/api/automation/${paused.id}/pause`, 'POST', { paused: true });
	await sleep(SETTLE_MS);
	const dailyBefore = (await viewOf(daily.id)).runs.length;
	// Down from 11/7 to 2027-03-05 at 07:00.
	await restartAt(tpe(2027, 3, 5, 7));
	const view = await eventually(async () => {
		const found = await viewOf(monthly.id);
		return found.missed.length ? found : undefined;
	}, 'the missed months');
	expect(view.missed.map((entry) => entry.period)).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
	expect(view.state).toBe('missed');
	expect(view.runs).toEqual([]);
	const notices = missedLogs(monthly.id);
	expect(notices).toHaveLength(1);
	expect(notices[0]).toMatchObject({ count: 4, periods: ['2026-11', '2026-12', '2027-01', '2027-02'] });
	// Every day from 11/8 to 3/4 for the daily one, in one notice too; today's try starts as usual.
	const dailyNotices = missedLogs(daily.id);
	expect(dailyNotices).toHaveLength(1);
	expect(dailyNotices[0].count).toBe(117);
	expect((await ended(daily.id, dailyBefore + 1))[0]).toMatchObject({ trigger: 'auto', period: '2027-03-05' });
	// Today's automatic run does not handle the misses: they stay until the user acts.
	expect((await viewOf(daily.id)).missed).toHaveLength(117);
	expect(missedLogs(paused.id)).toEqual([]);

	const dismissed = await send(`/api/automation/${monthly.id}/dismiss-missed`, 'POST', {});
	expect(await dismissed.json()).toEqual({ dismissed: 4 });
	expect((await viewOf(monthly.id)).missed).toEqual([]);
	expect((await viewOf(monthly.id)).state).toBe('waiting');
	await restartAt(tpe(2027, 3, 5, 7, 30));
	await sleep(SETTLE_MS);
	expect((await viewOf(monthly.id)).missed).toEqual([]);
	expect(missedLogs(monthly.id)).toHaveLength(1);
	expect((await send(`/api/automation/${monthly.id}/run`, 'POST')).status).toBe(202);
	expect((await ended(monthly.id, 1))[0]).toMatchObject({ trigger: 'manual', status: 'success', period: '2027-03' });
	expect((await send('/api/automation/nope/dismiss-missed', 'POST', {})).status).toBe(404);
}, 60_000);

test('立即執行 after a missed period clears it as handled', async () => {
	await open(tpe(2026, 11, 7, 12));
	const task = await create(commandTask({ type: 'monthly', fromDay: 8, toDay: 10 }, 'echo ok', { time: '08:00' }));
	await restartAt(tpe(2026, 11, 12, 9));
	await eventually(async () => (await viewOf(task.id)).state === 'missed', 'the period to be missed');
	expect((await send(`/api/automation/${task.id}/run`, 'POST')).status).toBe(202);
	await ended(task.id, 1);
	const view = await viewOf(task.id);
	expect(view.state).toBe('done');
	expect(view.missed).toEqual([]);
}, 30_000);

test('the limit counts from the start: past it the run is stopped as 逾時', async () => {
	await open(tpe(2026, 11, 20, 9));
	const task = await create(commandTask({ type: 'monthly', fromDay: 1, toDay: 3 }, 'sleep 60', { limitMinutes: 5 }));
	expect((await send(`/api/automation/${task.id}/run`, 'POST')).status).toBe(202);
	await at(tpe(2026, 11, 20, 9, 4));
	expect((await viewOf(task.id)).runs[0].status).toBe('running');
	await at(tpe(2026, 11, 20, 9, 5));
	const [run] = await ended(task.id, 1);
	expect(run).toMatchObject({ status: 'timeout', reason: '超過上限 5 分鐘，已停止', startedAt: tpe(2026, 11, 20, 9) });
	expect((await viewOf(task.id)).state).toBe('failed');
}, 30_000);

test('a run belongs to the period it started in: ending past midnight, or cut off by a restart in the next period', async () => {
	await open(tpe(2026, 11, 30, 23, 58));
	const daily = await create(commandTask({ type: 'daily' }, 'sleep 1.5; echo ok', { time: '23:59', name: '跨夜' }));
	await at(tpe(2026, 11, 30, 23, 59));
	await eventually(async () => (await viewOf(daily.id)).runs[0]?.status === 'running', 'the run to start');
	fixture!.setClock(tpe(2026, 12, 1, 0, 1));
	const [crossed] = await eventually(async () => {
		const runs = (await viewOf(daily.id)).runs.filter((run) => run.status !== 'running');
		return runs.length ? runs : undefined;
	}, 'the run to end');
	expect(crossed).toMatchObject({ trigger: 'auto', status: 'success', period: '2026-11-30', endedAt: tpe(2026, 12, 1, 0, 1) });
	// The new day has its own try, at its set time.
	expect((await viewOf(daily.id)).state).toBe('waiting');

	const monthly = await create(commandTask({ type: 'monthly', fromDay: 1, toDay: 31 }, 'sleep 60', { name: '跨月重啟', time: '23:00' }));
	fixture!.setClock(tpe(2026, 12, 31, 23, 30));
	const cut = await eventually(async () => (await viewOf(monthly.id)).runs.find((run) => run.status === 'running'), 'the run to start');
	expect(cut.period).toBe('2026-12');
	await restartAt(tpe(2027, 1, 1, 0, 30));
	const after = await viewOf(monthly.id);
	expect(after.runs.find((run) => run.id === cut.id)).toMatchObject({ status: 'failed', reason: '看板重啟中斷', period: '2026-12' });
	// December is not done; January's try starts at once after the restart.
	const january = await eventually(async () => (await viewOf(monthly.id)).runs.find((run) => run.id !== cut.id), 'January\'s try');
	expect(january).toMatchObject({ trigger: 'auto', period: '2027-01', startedAt: tpe(2027, 1, 1, 0, 30) });
}, 60_000);

test('沿用原紀錄 makes the period done through the API, and needs the marker', async () => {
	await open(tpe(2026, 11, 2, 9));
	const task = await create(commandTask({ type: 'monthly', fromDay: 1, toDay: 5 }, 'echo ok'));
	expect((await send(`/api/automation/${task.id}/carried`, 'POST', {})).status).toBe(400);
	expect((await send('/api/automation/nope/carried', 'POST', { marker: '/x' })).status).toBe(404);
	const response = await send(`/api/automation/${task.id}/carried`, 'POST', { marker: '~/iipp/state/2026-11.done' });
	expect(response.status).toBe(201);
	const run: AutomationRun = await response.json();
	expect(run).toMatchObject({ trigger: 'carried', status: 'success', period: '2026-11', marker: '~/iipp/state/2026-11.done', reason: '沿用原紀錄：~/iipp/state/2026-11.done' });
	// The set time passes and a restart comes: no try, the period is done.
	await at(tpe(2026, 11, 2, 10, 5));
	await restartAt(tpe(2026, 11, 3, 9));
	await sleep(SETTLE_MS);
	const view = await viewOf(task.id);
	expect(view.state).toBe('done');
	expect(view.runs).toHaveLength(1);
	expect(view.nextAt).toBe(tpe(2026, 12, 1, 10));
}, 30_000);

test('weekly and daily: the same rules in their own periods', async () => {
	// 2026-11-09 is a Monday.
	await open(tpe(2026, 11, 8, 12));
	const weekly = await create(commandTask({ type: 'weekly', fromWeekday: 1, toWeekday: 3 }, 'exit 1', { name: '每週', time: '09:00' }));
	const daily = await create(commandTask({ type: 'daily' }, 'exit 1', { name: '每天', time: '09:00' }));
	expect((await viewOf(weekly.id)).nextAt).toBe(tpe(2026, 11, 9, 9));
	// Sunday: outside the weekly window; the daily one tries at its time.
	await at(tpe(2026, 11, 8, 12, 1));
	expect((await viewOf(weekly.id)).runs).toEqual([]);
	await ended(daily.id, 1);
	// Monday: both fail; once each that day.
	await at(tpe(2026, 11, 9, 9));
	await ended(weekly.id, 1);
	await ended(daily.id, 2);
	await at(tpe(2026, 11, 9, 18));
	expect((await viewOf(weekly.id)).runs).toHaveLength(1);
	expect((await viewOf(daily.id)).runs).toHaveLength(2);
	// Tuesday: fixed, both succeed; the week is done, the day too.
	for (const task of [weekly, daily]) await send(`/api/automation/${task.id}`, 'PUT', commandTask(task.schedule, 'echo ok', { name: task.name, time: '09:00' }));
	await at(tpe(2026, 11, 10, 9));
	expect((await ended(weekly.id, 2))[0]).toMatchObject({ status: 'success', period: '2026-W11-09' });
	expect((await ended(daily.id, 3))[0]).toMatchObject({ status: 'success', period: '2026-11-10' });
	expect((await viewOf(weekly.id)).nextAt).toBe(tpe(2026, 11, 16, 9));
	// Wednesday: the week is done; the new day is tried.
	await at(tpe(2026, 11, 11, 9));
	await ended(daily.id, 4);
	expect((await viewOf(weekly.id)).runs).toHaveLength(2);
	// Next Monday: a new week.
	await at(tpe(2026, 11, 16, 9));
	expect((await ended(weekly.id, 3))[0]).toMatchObject({ trigger: 'auto', period: '2026-W11-16' });
}, 60_000);

test('a try that comes due while the task still runs is skipped and recorded, once', async () => {
	await open(tpe(2026, 11, 2, 9, 59));
	const task = await create(commandTask({ type: 'monthly', fromDay: 1, toDay: 5 }, 'sleep 3; echo ok'));
	expect((await send(`/api/automation/${task.id}/run`, 'POST')).status).toBe(202);
	await at(tpe(2026, 11, 2, 10, 0));
	const skipped = (await autoRuns(task.id)).filter((run) => run.status === 'skipped');
	expect(skipped).toHaveLength(1);
	expect(skipped[0]).toMatchObject({ trigger: 'auto', status: 'skipped', reason: '上一次還在跑', period: '2026-11' });
	await ended(task.id, 2);
	await at(tpe(2026, 11, 2, 10, 30));
	// The day's try was that one: no other starts after the manual run ends.
	expect((await viewOf(task.id)).runs).toHaveLength(2);
	expect((await viewOf(task.id)).state).toBe('done');
}, 30_000);

test('a run that ends past a week’s end or a month’s end belongs to the period it started in, and the new period waits for its own set time', async () => {
	// 2026-11-15 is a Sunday and 2026-11-30 the month's last day.
	await open(tpe(2026, 11, 15, 23, 40));
	const weekly = await create(commandTask({ type: 'weekly', fromWeekday: 1, toWeekday: 7 }, 'sleep 1.5; echo ok', { name: '跨週', time: '23:45', limitMinutes: 120 }));
	await at(tpe(2026, 11, 15, 23, 46));
	await eventually(async () => (await viewOf(weekly.id)).runs[0]?.status === 'running', 'the weekly run to start');
	fixture!.setClock(tpe(2026, 11, 16, 0, 30));
	const [crossedWeek] = await ended(weekly.id, 1);
	expect(crossedWeek).toMatchObject({ trigger: 'auto', status: 'success', period: '2026-W11-09', startedAt: tpe(2026, 11, 15, 23, 46), endedAt: tpe(2026, 11, 16, 0, 30) });
	const week = await viewOf(weekly.id);
	expect(week.state).toBe('waiting');
	expect(week.missed).toEqual([]);
	expect(week.nextAt).toBe(tpe(2026, 11, 16, 23, 45));

	await restartAt(tpe(2026, 11, 30, 23, 40));
	const monthly = await create(commandTask({ type: 'monthly', fromDay: 1, toDay: 31 }, 'sleep 1.5; echo ok', { name: '跨月', time: '23:45', limitMinutes: 120 }));
	await at(tpe(2026, 11, 30, 23, 46));
	const novemberRun = await eventually(async () => (await viewOf(monthly.id)).runs.find((run) => run.status === 'running'), 'the monthly run to start');
	expect(novemberRun.period).toBe('2026-11');
	fixture!.setClock(tpe(2026, 12, 1, 0, 30));
	const crossedMonth = (await ended(monthly.id, 1))[0];
	expect(crossedMonth).toMatchObject({ id: novemberRun.id, trigger: 'auto', status: 'success', period: '2026-11', endedAt: tpe(2026, 12, 1, 0, 30) });
	const month = await viewOf(monthly.id);
	expect(month.state).toBe('waiting');
	expect(month.missed).toEqual([]);
	expect(month.nextAt).toBe(tpe(2026, 12, 1, 23, 45));
	expect(missedLogs(monthly.id)).toEqual([]);
}, 60_000);
