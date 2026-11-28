// An event task's card and page lines (#765): what it waits for or how it ended, its deadline or
// its latest handoff, and its last result, worded from the snapshot the server sent. Pure; every
// time in Asia/Taipei.
import { timeFormat, type AutomationRun, type AutomationTaskView } from './automation.ts';
import { CAUSE_SHORT, eventMark, latestHandoff, outcomeText, type EventSpec, type RunHandoff } from './event-tasks.ts';

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
	const last = latestHandoff(view.runs as AutomationRun[]);
	const event: EventSpec = view.task.event.event;
	const mark = eventMark(view.event.state, event, last?.handoff, at.full);
	const state = view.event.state;
	const finished = state === 'running' || state === 'done' || state === 'expired';
	if (finished && last?.handoff.status === 'handed') return { mark, line: `${at.full(last.handoff.settledAt ?? last.startedAt)} ${attemptText(view, last.handoff)}`, last: null };
	if (state === 'expired-paused' || state === 'expired' || state === 'done') return { mark, line: `${at.full(view.event.ended?.at ?? view.event.deadlineAt)} 結束`, last: null };
	return {
		mark,
		line: `最晚 ${at.full(view.event.deadlineAt)}`,
		last: last ? `上次 ${at.full(last.startedAt)} ${CAUSE_SHORT[last.handoff.event.cause]}，${attemptText(view, last.handoff)}` : null
	};
}
