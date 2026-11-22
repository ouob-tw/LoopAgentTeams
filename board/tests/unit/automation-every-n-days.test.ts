// Every N days (#692): blocks of N days from the start date, each a period named by its first day
// and run on that day only; N = 1 and the old `{ type: 'daily' }` give exactly what every day gave
// before. Times are written in Asia/Taipei (UTC+8), whatever zone the host runs in.
import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';
import * as automation from '../../src/lib/board/automation.ts';
import {
	dateOf,
	dueToday,
	endedWindows,
	inWindow,
	nextAutoAt,
	parseDate,
	periodOf,
	scheduleText,
	taskState,
	windowOf,
	type AutomationRun,
	type AutomationTask,
	type DailySchedule
} from '../../src/lib/board/automation.ts';
import { dailyCases } from '../fixtures/daily-cases.ts';

const at = (year: number, month: number, day: number, hour = 12, minute = 0) => Date.UTC(year, month - 1, day, hour - 8, minute);
const every = (everyDays: number, startDate: string): DailySchedule => ({ type: 'daily', everyDays, startDate });
const task = (schedule: DailySchedule, overrides: Partial<AutomationTask> = {}): AutomationTask => ({
	id: 't1',
	name: '每兩天修 bug',
	schedule,
	time: '07:00',
	limitMinutes: 60,
	kind: 'command',
	command: { command: 'true', folder: '/tmp', checks: [] },
	review: { enabled: false, checklist: [], client: 'codex', model: 'gpt-6.1-sol', effort: 'medium' },
	paused: false,
	createdAt: '',
	updatedAt: '',
	...overrides
});
const run = (overrides: Partial<AutomationRun>): AutomationRun => ({ id: `r${Math.random()}`, taskId: 't1', trigger: 'auto', period: '', startedAt: 0, status: 'success', ...overrides });

test('N = 1, old or new form, gives exactly what every day gave before #692', () => {
	const before = JSON.parse(readFileSync(new URL('../fixtures/daily-before-692.json', import.meta.url), 'utf8'));
	const roundTrip = (value: unknown) => JSON.parse(JSON.stringify(value));
	expect(before.length).toBeGreaterThan(50);
	expect(roundTrip(dailyCases(automation, { type: 'daily' }))).toEqual(before);
	expect(roundTrip(dailyCases(automation, { type: 'daily', everyDays: 1 }))).toEqual(before);
	// A start date beside N = 1 changes nothing.
	expect(roundTrip(dailyCases(automation, { type: 'daily', everyDays: 1, startDate: '2026-11-22' }))).toEqual(before);
});

test('the list words it: 每天 for N = 1, 每 N 天 from 2', () => {
	expect(scheduleText({ type: 'daily' }, '03:00')).toBe('每天 03:00');
	expect(scheduleText({ type: 'daily', everyDays: 1 }, '03:00')).toBe('每天 03:00');
	expect(scheduleText(every(2, '2026-11-22'), '07:00')).toBe('每 2 天 07:00');
	expect(scheduleText(every(365, '2026-11-22'), '00:00')).toBe('每 365 天 00:00');
});

test('N = 2 from 11/22: two-day blocks named by their first day, only that day in the window', () => {
	const two = every(2, '2026-11-22');
	expect(periodOf(two, at(2026, 11, 22, 0))).toBe('2026-11-22');
	expect(periodOf(two, at(2026, 11, 23, 23, 59))).toBe('2026-11-22');
	expect(periodOf(two, at(2026, 11, 24, 0))).toBe('2026-11-24');
	expect(windowOf(two, at(2026, 11, 23))).toEqual({ period: '2026-11-22', from: at(2026, 11, 22, 0), to: at(2026, 11, 23, 0) });
	expect(inWindow(two, at(2026, 11, 22, 23, 59))).toBe(true);
	expect(inWindow(two, at(2026, 11, 23, 0))).toBe(false);
	expect(inWindow(two, at(2026, 11, 24, 7))).toBe(true);
	// The live task: succeeded on 11/22, so the next try is 11/24 07:00.
	const morari = task(two);
	const done = [run({ period: '2026-11-22', startedAt: at(2026, 11, 22, 7) })];
	expect(nextAutoAt(morari, done, at(2026, 11, 23, 9))).toBe(at(2026, 11, 24, 7));
	expect(taskState(morari, done, at(2026, 11, 23, 9))).toBe('done');
	expect(dueToday(morari, done, at(2026, 11, 23, 9))).toBeNull();
});

test('N = 7: weekly blocks from the start date, whatever weekday it is', () => {
	// 2026-11-25 is a Wednesday.
	const seven = every(7, '2026-11-25');
	expect(periodOf(seven, at(2026, 12, 1))).toBe('2026-11-25');
	expect(periodOf(seven, at(2026, 12, 2))).toBe('2026-12-02');
	expect(nextAutoAt(task(seven), [], at(2026, 11, 26))).toBe(at(2026, 12, 2, 7));
	expect(nextAutoAt(task(seven), [], at(2026, 11, 25, 6))).toBe(at(2026, 11, 25, 7));
	expect(endedWindows(seven, at(2026, 11, 20), at(2026, 12, 20)).map((window) => window.period)).toEqual(['2026-11-25', '2026-12-02', '2026-12-09', '2026-12-16']);
});

test('blocks run on across month and year ends and a leap day', () => {
	const three = every(3, '2026-12-28');
	expect([28, 29, 30, 31].map((day) => periodOf(three, at(2026, 12, day)))).toEqual(['2026-12-28', '2026-12-28', '2026-12-28', '2026-12-31']);
	expect([1, 2, 3].map((day) => periodOf(three, at(2027, 1, day)))).toEqual(['2026-12-31', '2026-12-31', '2027-01-03']);
	const two = every(2, '2028-02-27');
	expect(endedWindows(two, at(2028, 2, 26), at(2028, 3, 5)).map((window) => window.period)).toEqual(['2028-02-27', '2028-02-29', '2028-03-02', '2028-03-04']);
	expect(periodOf(two, at(2028, 3, 1))).toBe('2028-02-29');
	// Taipei days whatever the host zone: 23:30 UTC on 12/30 is 12/31 in Taipei.
	expect(periodOf(three, Date.UTC(2026, 11, 30, 23, 30))).toBe('2026-12-31');
});

test('a start date ahead: no window, no try, nothing missed before it; the first try on that day', () => {
	const two = every(2, '2026-12-01');
	const now = at(2026, 11, 23, 9);
	expect(inWindow(two, now)).toBe(false);
	expect(inWindow(two, at(2026, 11, 30, 7))).toBe(false);
	expect(dueToday(task(two), [], now)).toBeNull();
	expect(nextAutoAt(task(two), [], now)).toBe(at(2026, 12, 1, 7));
	expect(endedWindows(two, at(2026, 11, 1), at(2026, 12, 1, 23))).toEqual([]);
	expect(endedWindows(two, at(2026, 11, 1), at(2026, 12, 2, 0)).map((window) => window.period)).toEqual(['2026-12-01']);
	// Years ahead: still found.
	expect(nextAutoAt(task(every(30, '2030-01-01')), [], now)).toBe(at(2030, 1, 1, 7));
});

test('one try per block: on its first day only; a success or a try ends it; an untried first day is missed', () => {
	const two = task(every(2, '2026-11-22'));
	// First day before the set time: due at 07:00.
	expect(dueToday(two, [], at(2026, 11, 24, 6))).toBe(at(2026, 11, 24, 7));
	// Tried and failed: no more tries this block, next block's first day.
	const failed = [run({ period: '2026-11-24', startedAt: at(2026, 11, 24, 7), status: 'failed' })];
	expect(dueToday(two, failed, at(2026, 11, 24, 9))).toBeNull();
	expect(nextAutoAt(two, failed, at(2026, 11, 24, 9))).toBe(at(2026, 11, 26, 7));
	expect(taskState(two, failed, at(2026, 11, 25, 9))).toBe('failed');
	// The second day is never in the window, untried or not.
	expect(dueToday(two, [], at(2026, 11, 25, 9))).toBeNull();
	expect(nextAutoAt(two, [], at(2026, 11, 25, 9))).toBe(at(2026, 11, 26, 7));
	// The first day passed untried: that block's window ended, so it is a missed period.
	expect(endedWindows(two.schedule, at(2026, 11, 24, 1), at(2026, 11, 25, 9))).toEqual([{ period: '2026-11-24', from: at(2026, 11, 24, 0), to: at(2026, 11, 25, 0) }]);
});

test('dates: real days only', () => {
	expect(parseDate('2026-11-22')).toBe(at(2026, 11, 22, 0));
	expect(parseDate('2028-02-29')).toBe(at(2028, 2, 29, 0));
	for (const bad of ['2027-02-29', '2026-13-01', '2026-11-31', '2026-00-10', '2026-1-5', '20261122', '', '0099-01-01']) expect(parseDate(bad)).toBeNull();
	expect(dateOf(Date.UTC(2026, 10, 22, 16, 30))).toBe('2026-11-23');
});

test('before a start date ahead, runs under an earlier schedule are not this period’s: waiting, not done (#692 QA)', () => {
	// An every-day task that succeeded on 11/23, then changed to every 2 days from 12/01.
	const legacy = [run({ period: '2026-11-23', startedAt: at(2026, 11, 23, 0, 5) })];
	const two = task(every(2, '2026-12-01'));
	expect(periodOf(two.schedule, at(2026, 11, 23, 9))).toBe('2026-11-23');
	expect(taskState(two, legacy, at(2026, 11, 23, 9))).toBe('waiting');
	expect(taskState(two, [run({ period: '2026-11-23', startedAt: at(2026, 11, 23, 0, 5), status: 'failed' })], at(2026, 11, 23, 9))).toBe('waiting');
	expect(nextAutoAt(two, legacy, at(2026, 11, 23, 9))).toBe(at(2026, 12, 1, 7));
	// Still shown: a run going on, paused, and an open missed period.
	expect(taskState(two, [run({ status: 'running', startedAt: at(2026, 11, 23, 8) })], at(2026, 11, 23, 9))).toBe('running');
	expect(taskState({ ...two, paused: true }, legacy, at(2026, 11, 23, 9))).toBe('paused');
	const missed = [{ period: '2026-11-21', from: at(2026, 11, 21, 0), to: at(2026, 11, 22, 0), recordedAt: at(2026, 11, 22, 0) }];
	expect(taskState(two, [], at(2026, 11, 23, 9), missed)).toBe('missed');
	// From the start date the task's own periods count again.
	expect(taskState(two, [...legacy, run({ period: '2026-12-01', startedAt: at(2026, 12, 1, 7) })], at(2026, 12, 1, 9))).toBe('done');
});
