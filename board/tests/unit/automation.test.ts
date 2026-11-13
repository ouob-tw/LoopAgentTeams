// The 自動化 rules every part reads tasks by: the run window's words, periods, windows in short
// months, the next automatic try, missed windows and a task's state this period. Times are written
// in Asia/Taipei (UTC+8), whatever zone the host runs in.
import { expect, test } from 'bun:test';
import {
	endedWindows,
	inWindow,
	lastRunText,
	missedNames,
	missedText,
	nextAutoAt,
	openAsk,
	periodOf,
	runLabel,
	scheduleText,
	taskState,
	windowOf,
	type AutomationRun,
	type AutomationTask,
	type MissedPeriod
} from '../../src/lib/board/automation.ts';

/** A wall-clock time in Asia/Taipei. */
const at = (year: number, month: number, day: number, hour = 12, minute = 0) => Date.UTC(year, month - 1, day, hour - 8, minute);

function task(overrides: Partial<AutomationTask> = {}): AutomationTask {
	return {
		id: 't1',
		name: '任務',
		schedule: { type: 'monthly', fromDay: 1, toDay: 5 },
		time: '10:00',
		limitMinutes: 60,
		kind: 'command',
		command: { command: 'true', folder: '/tmp', checks: [] },
		review: { enabled: false, checklist: [], client: 'codex', model: 'gpt-6.1-sol', effort: 'medium' },
		paused: false,
		createdAt: '',
		updatedAt: '',
		...overrides
	};
}
const run = (overrides: Partial<AutomationRun>): AutomationRun => ({ id: `r${Math.random()}`, taskId: 't1', trigger: 'manual', period: '2026-11', startedAt: at(2026, 11, 2), status: 'success', ...overrides });

test('the run window reads as the list shows it, for each type', () => {
	expect(scheduleText({ type: 'monthly', fromDay: 1, toDay: 5 }, '10:00')).toBe('每月 1–5 日 10:00');
	expect(scheduleText({ type: 'monthly', fromDay: 25, toDay: 25 }, '02:00')).toBe('每月 25 日 02:00');
	expect(scheduleText({ type: 'weekly', fromWeekday: 1, toWeekday: 3 }, '09:00')).toBe('每週一至三 09:00');
	expect(scheduleText({ type: 'weekly', fromWeekday: 7, toWeekday: 7 }, '09:00')).toBe('每週日 09:00');
	expect(scheduleText({ type: 'daily' }, '03:00')).toBe('每天 03:00');
});

test('periods: the month, the week by its Monday, the day', () => {
	// 2026-11-15 is a Sunday: its week began on Monday the 9th.
	expect(periodOf({ type: 'monthly', fromDay: 1, toDay: 5 }, at(2026, 11, 15))).toBe('2026-11');
	expect(periodOf({ type: 'weekly', fromWeekday: 1, toWeekday: 7 }, at(2026, 11, 15))).toBe('2026-W11-09');
	expect(periodOf({ type: 'weekly', fromWeekday: 1, toWeekday: 7 }, at(2026, 11, 16))).toBe('2026-W11-16');
	expect(periodOf({ type: 'daily' }, at(2026, 11, 15, 23, 59))).toBe('2026-11-15');
});

test('next try: today while untried, else the next day in the window; a done period is skipped', () => {
	const monthly = task();
	expect(nextAutoAt(monthly, [], at(2026, 11, 3, 8))).toBe(at(2026, 11, 3, 10));
	expect(nextAutoAt(monthly, [], at(2026, 11, 10))).toBe(at(2026, 12, 1, 10));
	// Done this month: next month.
	expect(nextAutoAt(monthly, [run({})], at(2026, 11, 3, 8))).toBe(at(2026, 12, 1, 10));
	// Tried automatically today and failed: tomorrow.
	expect(nextAutoAt(monthly, [run({ trigger: 'auto', status: 'failed', startedAt: at(2026, 11, 3, 10) })], at(2026, 11, 3, 11))).toBe(at(2026, 11, 4, 10));
	// A manual run today does not use up the day's try.
	expect(nextAutoAt(monthly, [run({ status: 'failed', startedAt: at(2026, 11, 3, 9) })], at(2026, 11, 3, 9, 30))).toBe(at(2026, 11, 3, 10));
	// A window past a short month's end stops at its last day.
	const late = task({ schedule: { type: 'monthly', fromDay: 30, toDay: 31 } });
	expect(nextAutoAt(late, [], at(2027, 2, 1))).toBe(at(2027, 2, 28, 10));
	const weekly = task({ schedule: { type: 'weekly', fromWeekday: 1, toWeekday: 3 }, time: '09:00' });
	// Thursday 2026-11-12: next Monday.
	expect(nextAutoAt(weekly, [], at(2026, 11, 12))).toBe(at(2026, 11, 16, 9));
	const daily = task({ schedule: { type: 'daily' }, time: '03:00' });
	expect(nextAutoAt(daily, [run({ period: '2026-11-12', startedAt: at(2026, 11, 12, 3) })], at(2026, 11, 12, 4))).toBe(at(2026, 11, 13, 3));
	expect(nextAutoAt(task({ paused: true }), [], at(2026, 11, 3))).toBeNull();
});

test('state: running, paused, done (a later failure does not undo it), failed, waiting; previews do not count', () => {
	const now = at(2026, 11, 4);
	expect(taskState(task(), [], now)).toBe('waiting');
	expect(taskState(task(), [run({ status: 'running' })], now)).toBe('running');
	expect(taskState(task({ paused: true }), [run({})], now)).toBe('paused');
	expect(taskState(task(), [run({ startedAt: at(2026, 11, 3, 13), status: 'failed' }), run({})], now)).toBe('done');
	expect(taskState(task(), [run({ status: 'failed' })], now)).toBe('failed');
	expect(taskState(task(), [run({ trigger: 'preview' })], now)).toBe('waiting');
	// Last month's success is not this month's.
	expect(taskState(task(), [run({ period: '2026-10' })], now)).toBe('waiting');
	// A run started late on the last day belongs to its own period even if it ends in the next.
	expect(taskState(task({ schedule: { type: 'daily' } }), [run({ period: '2026-11-03', startedAt: at(2026, 11, 3, 23, 50), endedAt: at(2026, 11, 4, 0, 10) })], now)).toBe('waiting');
});

test('the card’s last line says how the latest run ended', () => {
	const zone = 'Asia/Taipei';
	expect(lastRunText(undefined, zone)).toBe('還沒跑過');
	expect(lastRunText(run({ endedAt: at(2026, 11, 1, 3, 4), checks: [{ label: '檔案存在：x', ok: true }] }), zone)).toBe('11/01 03:04 完成，1 項檢查都通過');
	expect(lastRunText(run({ status: 'failed', exitCode: 1, endedAt: at(2026, 11, 5, 9) }), zone)).toBe('11/05 09:00 失敗：結束碼 1');
	expect(lastRunText(run({ status: 'running', startedAt: at(2026, 11, 5, 9) }), zone)).toBe('11/05 09:00 開始，執行中');
	expect(lastRunText(run({ status: 'running', startedAt: at(2026, 11, 5, 9) }), zone, at(2026, 11, 5, 9, 12))).toBe('11/05 09:00 開始，已跑 12 分鐘');
});

test('days are Taipei days whatever the host zone: 23:30 UTC on the 2nd is the 3rd in Taipei', () => {
	const time = Date.UTC(2026, 10, 2, 23, 30);
	expect(periodOf({ type: 'daily' }, time)).toBe('2026-11-03');
	expect(inWindow({ type: 'monthly', fromDay: 3, toDay: 3 }, time)).toBe(true);
	// The last day of the window counts to its very end, and not a minute past it.
	expect(inWindow({ type: 'monthly', fromDay: 1, toDay: 5 }, at(2026, 11, 5, 23, 59))).toBe(true);
	expect(inWindow({ type: 'monthly', fromDay: 1, toDay: 5 }, at(2026, 11, 6, 0, 0))).toBe(false);
});

test('a window past the month\'s end stops on its last day: February and 30-day months', () => {
	const late = { type: 'monthly' as const, fromDay: 29, toDay: 31 };
	expect(windowOf(late, at(2027, 2, 10))).toEqual({ period: '2027-02', from: at(2027, 2, 28, 0), to: at(2027, 3, 1, 0) });
	expect(windowOf(late, at(2028, 2, 10))).toEqual({ period: '2028-02', from: at(2028, 2, 29, 0), to: at(2028, 3, 1, 0) });
	expect(windowOf(late, at(2026, 11, 10))).toEqual({ period: '2026-11', from: at(2026, 11, 29, 0), to: at(2026, 12, 1, 0) });
	expect(inWindow(late, at(2026, 11, 30, 20))).toBe(true);
	expect(inWindow({ type: 'monthly', fromDay: 31, toDay: 31 }, at(2026, 11, 30, 20))).toBe(true);
	expect(nextAutoAt(task({ schedule: { type: 'monthly', fromDay: 31, toDay: 31 } }), [], at(2026, 11, 2))).toBe(at(2026, 11, 30, 10));
});

test('ended windows: every period whose window closed in between, each once, oldest first', () => {
	const monthly = { type: 'monthly' as const, fromDay: 8, toDay: 10 };
	// Off from 11/9 to 2027-02-09: November's, December's and January's windows ended; February's not yet.
	expect(endedWindows(monthly, at(2026, 11, 9), at(2027, 2, 9)).map((window) => window.period)).toEqual(['2026-11', '2026-12', '2027-01']);
	expect(endedWindows(monthly, at(2026, 11, 9), at(2027, 2, 11, 0, 0)).map((window) => window.period)).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
	// The window ends at midnight after its last day: late on the 10th it has not.
	expect(endedWindows(monthly, at(2026, 11, 9), at(2026, 11, 10, 23, 59))).toEqual([]);
	const weekly = { type: 'weekly' as const, fromWeekday: 1 as const, toWeekday: 3 as const };
	// 2026-11-09 is a Monday; from Tuesday 11-10 to Friday 11-27: three weeks' Monday–Wednesday ended.
	expect(endedWindows(weekly, at(2026, 11, 10), at(2026, 11, 27)).map((window) => window.period)).toEqual(['2026-W11-09', '2026-W11-16', '2026-W11-23']);
	expect(endedWindows({ type: 'daily' }, at(2026, 11, 10, 9), at(2026, 11, 13, 9)).map((window) => window.period)).toEqual(['2026-11-10', '2026-11-11', '2026-11-12']);
});

test('missed: shown until dismissed or a run starts after the window; done still wins; the line names the first few and the total', () => {
	const now = at(2026, 11, 12);
	const entry = (month: number, extra: Partial<MissedPeriod> = {}): MissedPeriod => ({ period: `2026-${String(month).padStart(2, '0')}`, from: at(2026, month, 8, 0), to: at(2026, month, 11, 0), recordedAt: at(2026, month, 11, 0), ...extra });
	const monthly = task({ schedule: { type: 'monthly', fromDay: 8, toDay: 10 } });
	expect(taskState(monthly, [], now, [entry(11)])).toBe('missed');
	expect(taskState(monthly, [], now, [entry(11, { dismissedAt: now })])).toBe('waiting');
	expect(taskState(monthly, [run({ status: 'failed', startedAt: at(2026, 11, 11, 9) })], now, [entry(11)])).toBe('failed');
	// A later automatic try does not handle it: only the user does.
	expect(taskState(monthly, [run({ trigger: 'auto', status: 'failed', startedAt: at(2026, 11, 11, 9) })], now, [entry(11)])).toBe('missed');
	expect(taskState(monthly, [run({ startedAt: at(2026, 11, 11, 9) })], now, [entry(11)])).toBe('done');
	// A skipped try is not a run.
	expect(taskState(monthly, [run({ trigger: 'auto', status: 'skipped', startedAt: at(2026, 11, 11, 9) })], now, [entry(11)])).toBe('missed');
	expect(missedText([entry(11)])).toBe('11/8–11/10 看板沒開，這期沒跑');
	expect(missedText([entry(7), entry(8), entry(9), entry(10), entry(11)])).toBe('看板沒開，錯過 5 期，沒有自動補跑');
	expect(missedNames([entry(7), entry(8), entry(9), entry(10), entry(11)])).toEqual(['7/8–7/10', '8/8–8/10', '9/8–9/10']);
	// Years are shown against the newest window's: an older year is written out.
	const january = { period: '2027-01-02', from: at(2027, 1, 2, 0), to: at(2027, 1, 3, 0), recordedAt: 0 };
	expect(missedNames([{ ...entry(12), from: at(2026, 12, 31, 0), to: at(2027, 1, 1, 0) }, january])).toEqual(['2026/12/31', '1/2']);
});

test('等你回覆: a running run whose last question is unanswered; the state, the run label and the card\'s last line say so', () => {
	const zone = 'Asia/Taipei';
	const now = at(2026, 11, 2, 10, 30);
	const asked = { question: '開幾張？', askedAt: at(2026, 11, 2, 10, 18) };
	const waiting = run({ status: 'running', startedAt: at(2026, 11, 2, 10), asks: [asked] });
	expect(openAsk(waiting)).toEqual(asked);
	expect(taskState(task(), [waiting], now)).toBe('asking');
	expect(runLabel(waiting)).toEqual({ text: '? 等你回覆', key: 'asking' });
	expect(lastRunText(waiting, zone, now)).toBe('11/02 10:00 開始，10:18 起等你回覆');
	// Answered, it is running again; a run that ended waits on nothing, whatever its record holds.
	const going = run({ status: 'running', asks: [{ ...asked, answer: '2 張', answeredAt: at(2026, 11, 2, 10, 23), source: '看板' }] });
	expect(openAsk(going)).toBeUndefined();
	expect(taskState(task(), [going], now)).toBe('running');
	expect(openAsk(run({ status: 'timeout', asks: [asked] }))).toBeUndefined();
	expect(taskState(task(), [run({ status: 'timeout', asks: [asked] })], now)).toBe('failed');
});
