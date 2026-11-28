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
	pastLimit,
	periodOf,
	precheckDue,
	runLabel,
	runReason,
	scheduleText,
	spanText,
	taskState,
	waitedMs,
	workedMs,
	workedText,
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
	expect(lastRunText({ ...going, startedAt: at(2026, 11, 2, 10) }, zone, now)).toBe('已跑 25 分鐘（扣掉等你回覆 5 分鐘）');
	expect(lastRunText({ ...going, startedAt: at(2026, 11, 2, 10) }, zone)).toBe('11/02 10:00 開始，10:23 你已回覆，繼續中');
	expect(taskState(task(), [going], now)).toBe('running');
	expect(openAsk(run({ status: 'timeout', asks: [asked] }))).toBeUndefined();
	expect(taskState(task(), [run({ status: 'timeout', asks: [asked] })], now)).toBe('failed');
});

test('working time (#675): from the start less every wait, an unanswered one up to now; the limit counts only that', () => {
	const start = at(2026, 11, 17, 3);
	const min = 60_000;
	const ask = (asked: number, answered?: number) => ({ question: '？', askedAt: start + asked * min, ...(answered === undefined ? {} : { answer: 'a', answeredAt: start + answered * min, source: '終端' }) });
	// No question: all of it is work.
	expect(workedMs(run({ startedAt: start }), start + 45 * min)).toBe(45 * min);
	// Asked at 30 minutes and still unanswered: work stops at 30 however long it waits.
	const waiting = run({ startedAt: start, asks: [ask(30)] });
	expect(waitedMs(waiting, start + 330 * min)).toBe(300 * min);
	expect(workedMs(waiting, start + 330 * min)).toBe(30 * min);
	expect(pastLimit(waiting, 60, start + 24 * 60 * min)).toBe(false);
	// The issue's example: limit 60, 30 worked, 5 hours waited, then 31 more is past it and 29 is not.
	const answered = run({ startedAt: start, asks: [ask(30, 330)] });
	expect(pastLimit(answered, 60, start + 359 * min)).toBe(false);
	expect(pastLimit(answered, 60, start + 360 * min)).toBe(true);
	// Several waits, one from the terminal, one still open: each is taken off.
	const many = run({ startedAt: start, asks: [ask(10, 70), ask(80, 200), ask(210)] });
	expect(waitedMs(many, start + 300 * min)).toBe((60 + 120 + 90) * min);
	expect(workedMs(many, start + 300 * min)).toBe(30 * min);
	// A run a restarted board took over is judged from the same record: nothing else is kept.
	expect(workedMs(JSON.parse(JSON.stringify(many)), start + 300 * min)).toBe(30 * min);
	// A wait never takes off time before the start or after now.
	expect(waitedMs(run({ startedAt: start, asks: [ask(-10, 5)] }), start + 20 * min)).toBe(5 * min);
	expect(waitedMs(run({ startedAt: start, asks: [ask(5, 50)] }), start + 20 * min)).toBe(15 * min);
});

test('working time in words: worked minutes, and the waiting taken off when there was any (#675)', () => {
	const start = at(2026, 11, 17, 3);
	const min = 60_000;
	expect([spanText(0), spanText(25 * min), spanText(60 * min), spanText(125 * min + 59_000)]).toEqual(['0 分鐘', '25 分鐘', '1 小時', '2 小時 5 分鐘']);
	expect(workedText(run({ startedAt: start }), start + 12 * min)).toBe('已跑 12 分鐘');
	expect(workedText(run({ startedAt: start, asks: [{ question: '？', askedAt: start + 30 * min }] }), start + 330 * min)).toBe('已跑 30 分鐘（扣掉等你回覆 5 小時）');
	// Under a minute of waiting says nothing extra.
	expect(workedText(run({ startedAt: start, asks: [{ question: '？', askedAt: start + 5 * min, answer: 'a', answeredAt: start + 5 * min + 30_000 }] }), start + 12 * min)).toBe('已跑 11 分鐘');
	expect(lastRunText(run({ status: 'running', startedAt: start, asks: [{ question: '？', askedAt: start + 30 * min, answer: 'a', answeredAt: start + 330 * min }] }), 'Asia/Taipei', start + 340 * min)).toBe('已跑 40 分鐘（扣掉等你回覆 5 小時）');
});

test('a rerun is checked first only when the period’s latest run failed and was not checked since (#751); the check is no day’s try unless stopped', () => {
	const now = at(2026, 11, 3, 10);
	const failed = run({ id: 'f', trigger: 'auto', startedAt: at(2026, 11, 2, 10), endedAt: at(2026, 11, 2, 10, 5), status: 'failed' });
	// A first try, a success, a settings error, or a failure of another period: nothing to check.
	expect(precheckDue(task(), [], now)).toBeNull();
	expect(precheckDue(task(), [run({ status: 'success' })], now)).toBeNull();
	expect(precheckDue(task(), [run({ status: 'config-error' })], now)).toBeNull();
	expect(precheckDue(task(), [run({ status: 'failed', period: '2026-10' })], now)).toBeNull();
	for (const status of ['failed', 'timeout', 'quota', 'stopped'] as const) expect(precheckDue(task(), [run({ id: 'x', status })], now)?.id).toBe('x');
	expect(precheckDue(task(), [failed], now)).toBe(failed);
	// Checked once: the rerun follows, and a later failure is checked again.
	const checked = run({ id: 'p', trigger: 'auto', startedAt: at(2026, 11, 3, 10), status: 'skipped', precheck: { of: 'f', by: 'review' } });
	expect(precheckDue(task(), [checked, failed], now)).toBeNull();
	expect(precheckDue(task(), [run({ id: 'g', trigger: 'auto', startedAt: at(2026, 11, 3, 10, 1), status: 'failed' }), checked, failed], now)?.id).toBe('g');

	// A check that did not pass leaves today's try due; one the user stopped takes it.
	expect(nextAutoAt(task(), [checked, failed], now)).toBe(at(2026, 11, 3, 10));
	expect(nextAutoAt(task(), [{ ...checked, status: 'stopped' }, failed], now)).toBe(at(2026, 11, 4, 10));
	// Its PASS settles the period.
	const passed = { ...checked, status: 'success' as const, review: { status: 'pass' as const, startedAt: now, client: 'codex' as const, model: 'm', effort: 'medium' as const, items: [] } };
	expect(taskState(task(), [passed, failed], now)).toBe('done');

	expect(runLabel({ ...checked, status: 'success', review: { ...passed.review, status: 'checking' } }).text).toBe('▶ 重跑前核對中');
	expect(runLabel(checked).text).toBe('↻ 核對沒過，重跑');
	expect(runLabel(passed).text).toBe('✓ 成功');
	expect(runReason(passed)).toBe('重跑前核對通過：這期的成果已在，不重跑');
	expect(runReason({ ...passed, review: undefined, precheck: { of: 'f', by: 'reply', repliedAt: at(2026, 11, 2, 15, 21) } })).toBe('重跑前核對通過：判失敗後 Agent 在 11/02 15:21 回覆 DONE，這期不重跑');
	expect(runReason({ ...checked, review: { ...passed.review, status: 'fail' } })).toBe('重跑前核對沒過，照常重跑');
	expect(lastRunText({ ...passed, endedAt: at(2026, 11, 3, 10, 2) }, 'Asia/Taipei')).toBe('11/03 10:02 完成，重跑前核對通過');
});
