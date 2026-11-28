// 事件任務's words on the list and the task page (#765), read alone: the state mark for each state,
// the line beside 一次性／可重複 (the deadline while it may hand over, else when and how it did),
// the last result, the short event name, the trigger rows and what a handoff did.
import { expect, test } from 'bun:test';
import { TIME_ZONE, timeFormat, type AutomationRun, type AutomationTaskView } from '../../src/lib/board/automation.ts';
import { eventLines, isEventView, type EventTaskViewOf } from '../../src/lib/board/event-task-view.ts';
import { eventMark, eventRows, eventShort, outcomeText, type EventSettings, type EventTaskState, type RunHandoff } from '../../src/lib/board/event-tasks.ts';

const at = timeFormat(TIME_ZONE);
const T = Date.parse('2026-11-28T07:12:00Z'); // 11/28 15:12 in Taipei
const DEADLINE = Date.parse('2026-11-29T09:40:00Z'); // 11/29 17:40
const log = { type: 'log' as const, path: '/home/user/project/logs/full-suite.log', text: 'DONE', caseSensitive: true };

function view(state: EventTaskState, settings: Partial<EventSettings> = {}, runs: Partial<AutomationRun>[] = []): EventTaskViewOf {
	const event: EventSettings = { event: log, deadlineMinutes: 24 * 60, repeat: true, handoff: 'resume', ...settings };
	return {
		task: { id: 't', name: '整套測試跑完後收尾', trigger: 'event', event, source: { proposer: { name: 'rivuta', client: 'claude', role: 'controller' } } } as unknown as EventTaskViewOf['task'],
		state: 'waiting',
		nextAt: null,
		missed: [],
		runs: runs as AutomationRun[],
		event: { state, since: 0, deadlineAt: DEADLINE, canTrigger: state === 'waiting', canRetry: state === 'failed' || state === 'unknown', ...(state === 'expired-paused' ? { ended: { status: 'expired-paused', at: DEADLINE } } : {}) }
	};
}
const handoff = (status: RunHandoff['status'], cause: RunHandoff['event']['cause'] = 'event', evidence?: RunHandoff['evidence']): RunHandoff => ({ occurrence: 'r', attempt: 1, status, settledAt: T, event: { cause, at: T, details: [] }, ...(evidence ? { evidence } : {}) });

test('the state mark: 等待事件 with the short event, then 已暫停, 接手失敗, 接手結果不明, 已發生, 已到期', () => {
	const mark = (state: EventTaskState, cause?: RunHandoff['event']['cause']) => eventMark(state, log, cause ? handoff('handed', cause) : undefined, at.full);
	expect(mark('waiting')).toEqual({ tone: 'event', text: '… 等待事件：Log 出現「DONE」' });
	expect(mark('paused')).toEqual({ tone: 'wait', text: '‖ 已暫停' });
	expect(mark('failed')).toEqual({ tone: 'bad', text: '✕ 接手失敗' });
	expect(mark('unknown')).toEqual({ tone: 'warn', text: '? 接手結果不明' });
	expect(mark('done', 'event')).toEqual({ tone: 'ok', text: '✓ 已發生：Log 出現「DONE」' });
	// A one-shot task that ran at its deadline ended, but its event never came.
	expect(mark('done', 'deadline')).toEqual({ tone: 'warn', text: '! 已到期：事件沒有發生' });
	expect(mark('expired', 'event').text).toBe('! 已到期');
	expect(mark('expired-paused').text).toBe('! 已到期（暫停中）');
	expect(mark('handing').text).toBe('▶ 接手中');
});

test('the short event: a file by its name, a process by its PID, a time in Taipei', () => {
	expect(eventShort({ type: 'file', path: '/home/user/out/report.md' }, at.full)).toBe('report.md 出現或更新');
	expect(eventShort({ type: 'process', pid: 48213, startTime: 1 }, at.full)).toBe('程序 48213 結束');
	expect(eventShort({ type: 'time', at: Date.parse('2026-11-29T01:00:00Z') }, at.full)).toBe('到 11/29 09:00');
});

test('the trigger rows: the kind first, then each field, the path and the text in monospace', () => {
	expect(eventRows(log, at.full)).toEqual({ kind: 'Log 檔出現文字', rows: [{ label: '路徑', value: log.path, mono: true }, { label: '文字', value: 'DONE', mono: true }] });
	expect(eventRows({ ...log, caseSensitive: false }, at.full).rows.at(-1)).toEqual({ label: '大小寫', value: '不分' });
	expect(eventRows({ type: 'time', at: Date.parse('2026-11-29T01:00:00Z') }, at.full)).toEqual({ kind: '到達時間', rows: [{ label: '時間', value: '11/29 09:00（台灣時間）' }] });
});

test('what a handoff did: a new Agent, the controller resumed or messaged by its registered name, else the attempt status', () => {
	expect(outcomeText(handoff('handed'), 'new-agent', 'rivuta')).toBe('已開新 Agent');
	expect(outcomeText(handoff('handed', 'event', { sessionId: 's', resumed: { name: 'other' } }), 'resume', 'rivuta')).toBe('已接回主控 rivuta');
	expect(outcomeText(handoff('handed', 'event', { messageId: '9001', to: 'grp-rivuta' }), 'resume', null)).toBe('已傳訊息給主控 grp-rivuta');
	expect(outcomeText(handoff('failed'), 'resume', 'rivuta')).toBe('接手失敗');
	expect(outcomeText(handoff('unknown'), 'new-agent', 'rivuta')).toBe('接手結果不明');
});

test('the card lines: the deadline and the last result while it may hand over; when and how once it did', () => {
	const handed = { id: 'r1', startedAt: T, status: 'success' as const, handoff: handoff('handed', 'event', { sessionId: 's', resumed: { name: 'rivuta' } }) };
	expect(eventLines(view('waiting'), TIME_ZONE)).toMatchObject({ line: '最晚 11/29 17:40', last: null });
	expect(eventLines(view('waiting', {}, [handed]), TIME_ZONE)).toMatchObject({ line: '最晚 11/29 17:40', last: '上次 11/28 15:12 事件發生，已接回主控 rivuta' });
	const failed = { id: 'r2', startedAt: T, status: 'failed' as const, handoff: handoff('failed', 'manual') };
	expect(eventLines(view('failed', {}, [failed]), TIME_ZONE).last).toBe('上次 11/28 15:12 手動觸發，接手失敗');
	const built = { id: 'r3', startedAt: T, status: 'success' as const, handoff: handoff('handed') };
	expect(eventLines(view('done', { repeat: false, handoff: 'new-agent' }, [built]), TIME_ZONE)).toMatchObject({ line: '11/28 15:12 已開新 Agent', last: null });
	expect(eventLines(view('expired-paused'), TIME_ZONE)).toMatchObject({ line: '11/29 17:40 結束', last: null });
});

test('only a view with its event settings and wait counts as an event task', () => {
	expect(isEventView(view('waiting'))).toBe(true);
	const periodic = { ...view('waiting'), event: undefined } as unknown as AutomationTaskView;
	expect(isEventView(periodic)).toBe(false);
});
