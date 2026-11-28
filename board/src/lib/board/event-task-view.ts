// An event task's card and page lines (#765): what it waits for or how it ended, its deadline or
// its latest handoff, and its last result, worded from the snapshot the server sent. Pure; every
// time in Asia/Taipei.
import { timeFormat, type AutomationTaskView } from './automation.ts';
import { CAUSE_SHORT, eventMark, isEnded, latestHandoff, outcomeText, type EventSpec, type RunHandoff } from './event-tasks.ts';

/** A view known to be an event task's. */
export type EventTaskViewOf = AutomationTaskView & { event: NonNullable<AutomationTaskView['event']>; task: AutomationTaskView['task'] & { event: NonNullable<AutomationTaskView['task']['event']> } };

export const isEventView = (view: AutomationTaskView): view is EventTaskViewOf => view.event !== undefined && view.task.event !== undefined;

/** The registering controller's HCOM name, from the approved proposal. */
export const controllerOf = (view: AutomationTaskView) => view.task.source?.proposer.name ?? null;

/** An attempt's result in a few words: 已開新 Agent, 已接回主控 rivuta, 接手失敗. */
export const attemptText = (view: EventTaskViewOf, handoff: Pick<RunHandoff, 'status' | 'evidence'>) => outcomeText(handoff, view.task.event.handoff, controllerOf(view));

export interface EventLines {
	mark: ReturnType<typeof eventMark>;
	/** Beside 一次性／可重複: 最晚 <deadline> while it may still hand over, else when and how it did. */
	line: string;
	/** The latest attempt, while the line does not already say it. */
	last: string | null;
}

export function eventLines(view: EventTaskViewOf, timeZone: string): EventLines {
	const at = timeFormat(timeZone);
	const last = latestHandoff(view.runs);
	const event: EventSpec = view.task.event.event;
	const mark = eventMark(view.event.state, event, last?.handoff, at.full);
	const state = view.event.state;
	// Handed over, and either its Agent still runs or the task is over: when and how it was.
	const handedOver = (state === 'running' || isEnded(state)) && last?.handoff.status === 'handed';
	if (handedOver) return { mark, line: `${at.full(last.handoff.settledAt ?? last.startedAt)} ${attemptText(view, last.handoff)}`, last: null };
	if (isEnded(state)) return { mark, line: `${at.full(view.event.ended?.at ?? view.event.deadlineAt)} 結束`, last: null };
	// 接手失敗 and 接手結果不明 keep, and can be retried, past the deadline: it is named, not as a limit.
	const stuck = state === 'failed' || state === 'unknown';
	return {
		mark,
		line: `${stuck ? '期限' : '最晚'} ${at.full(view.event.deadlineAt)}`,
		last: last ? `上次 ${at.full(last.startedAt)} ${CAUSE_SHORT[last.handoff.event.cause]}，${attemptText(view, last.handoff)}` : null
	};
}
