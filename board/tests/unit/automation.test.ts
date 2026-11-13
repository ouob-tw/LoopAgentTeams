// The 自動化 rules every part reads tasks by: the run window's words, periods, windows in short
// months, the next automatic try and a task's state this period. Times are the host's local time.
import { expect, test } from 'bun:test';
import { lastRunText, nextAutoAt, periodOf, scheduleText, taskState, type AutomationRun, type AutomationTask } from '../../src/lib/board/automation.ts';

const at = (year: number, month: number, day: number, hour = 12, minute = 0) => new Date(year, month - 1, day, hour, minute).getTime();

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
	const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	expect(lastRunText(undefined, zone)).toBe('還沒跑過');
	expect(lastRunText(run({ endedAt: at(2026, 11, 1, 3, 4), checks: [{ label: '檔案存在：x', ok: true }] }), zone)).toBe('11/01 03:04 完成，1 項檢查都通過');
	expect(lastRunText(run({ status: 'failed', exitCode: 1, endedAt: at(2026, 11, 5, 9) }), zone)).toBe('11/05 09:00 失敗：結束碼 1');
	expect(lastRunText(run({ status: 'running', startedAt: at(2026, 11, 5, 9) }), zone)).toBe('11/05 09:00 開始，執行中');
});
