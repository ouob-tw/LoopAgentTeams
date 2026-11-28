// 事件任務 (#758, #763): an automation task that waits for one event instead of a schedule, and on
// it (or at its deadline, on 立即觸發 or on 重試接手) hands over to a new Agent run as an agent
// task's run does. The shapes the server, the pages and the agent's proposal share, and the pure
// rules the state and the closing (收尾規則) are read by. Times are UTC milliseconds; the page words
// them in Asia/Taipei.

/** The four events of the first version. */
export type EventType = 'process' | 'file' | 'log' | 'time';

export type EventSpec =
	/** 程序結束: the process with this PID and the start time the board read when the proposal came
	 *  in (`/proc/<pid>/stat` field 22, clock ticks after boot). Gone, or a different start time (the
	 *  PID reused), is the original ended. */
	| { type: 'process'; pid: number; startTime: number }
	/** 檔案出現或更新: the file's modification time later than the wait's start. */
	| { type: 'file'; path: string }
	/** Log 檔出現指定文字: a line written after the wait's start holding `text`. */
	| { type: 'log'; path: string; text: string; caseSensitive: boolean }
	/** 到達時間: the moment, kept as UTC; the agent gives it in Asia/Taipei. */
	| { type: 'time'; at: number };

/** How an event task hands over. `new-agent` (開新 Agent) is #763; `resume` (接回原主控) is #764. */
export type HandoffKind = 'new-agent' | 'resume';

/** An event task's own settings, beside the agent task fields its new-Agent handoff runs with. */
export interface EventSettings {
	event: EventSpec;
	/** From the approval: 1 minute to 7 days, 24 hours unless given. */
	deadlineMinutes: number;
	/** 可重複: only file and Log events may be. */
	repeat: boolean;
	handoff: HandoffKind;
}

export const DEFAULT_DEADLINE_MINUTES = 24 * 60;
export const MAX_DEADLINE_MINUTES = 7 * 24 * 60;
/** The longest text a Log event looks for, and the longest matched line a handoff carries. */
export const MAX_LOG_TEXT = 500;
export const MAX_MATCHED_LINE = 2_000;

/** Why a handoff runs: the event, the deadline with no event, or the user's 立即觸發. */
export type HandoffCause = 'event' | 'deadline' | 'manual';

export const CAUSE_TEXT: Record<HandoffCause, string> = {
	event: '你等的事件發生了',
	deadline: '等到期限，事件沒有發生',
	manual: '使用者手動觸發'
};

/** What happened, as the run record keeps it and the handoff's first message says it. */
export interface EventOccurrence {
	cause: HandoffCause;
	/** When the board saw it. */
	at: number;
	/** The event's details in words: exit code, path, matched line, time. */
	details: string[];
}

/** 接手中 → 已接手 / 接手失敗 / 接手結果不明. */
export type HandoffStatus = 'handing' | 'handed' | 'failed' | 'unknown';

export const HANDOFF_TEXT: Record<HandoffStatus, string> = { handing: '接手中', handed: '已接手', failed: '接手失敗', unknown: '接手結果不明' };

/** One handoff attempt, written on its run before anything is launched or sent. A retry is a new
 *  run with the same `occurrence` and event, its `attempt` one more. */
export interface RunHandoff {
	/** The first attempt's run ID: every retry of the same event shares it. */
	occurrence: string;
	attempt: number;
	event: EventOccurrence;
	status: HandoffStatus;
	/** What this attempt's delivery left: the session its new Agent got (#764 adds the resumed
	 *  session and HCOM's message ID). */
	evidence?: { sessionId?: string; messageId?: string };
	/** Why it failed or is not known. */
	reason?: string;
	/** When it became 已接手, 接手失敗 or 接手結果不明. */
	settledAt?: number;
}

/** How an event task ended for good. */
export type EventEnd = 'done' | 'expired' | 'expired-paused';

/** `automation/events/<task>.json`: where the wait stands, written whole by the board. */
export interface EventWait {
	version: 1;
	/** Events count from here: the approval, the end of the run of the last handoff, or a resume. */
	since: number;
	/** A Log event's file as last read: its identity and the byte up to which every whole line was
	 *  looked at. Null while there is no such file. */
	log?: { dev: number; ino: number; offset: number } | null;
	/** Why the last look could not read what it waits on (讀不到 Log 檔：…); cleared by a good read. */
	readError?: string;
	ended?: { status: EventEnd; at: number };
}

/** The state the list and the task page show. */
export type EventTaskState = 'waiting' | 'paused' | 'handing' | 'running' | 'failed' | 'unknown' | 'done' | 'expired' | 'expired-paused';

export const EVENT_STATE_TEXT: Record<EventTaskState, string> = {
	waiting: '等待中',
	paused: '已暫停',
	handing: '接手中',
	running: '執行中',
	failed: '接手失敗',
	unknown: '接手結果不明',
	done: '已完成',
	expired: '已到期',
	'expired-paused': '已到期（暫停中）'
};

/** An event task as the snapshot sends it, beside its task and runs. */
export interface EventTaskView {
	state: EventTaskState;
	since: number;
	deadlineAt: number;
	readError?: string;
	ended?: EventWait['ended'];
	/** 立即觸發 is offered (waiting only); 重試接手 (after 接手失敗 or 接手結果不明, none running). */
	canTrigger: boolean;
	canRetry: boolean;
}

/** What a retry of 接手結果不明 warns of. */
export const UNKNOWN_RETRY_WARNING = '上一次可能已經送到，重試可能讓主控收到兩次或開出兩個 Agent';

/** The deadline of a wait that began at its approval, `start`. */
export const deadlineOf = (start: number, settings: Pick<EventSettings, 'deadlineMinutes'>) => start + settings.deadlineMinutes * 60_000;

/** The run of the latest handoff attempt, from runs newest first. */
export function latestHandoff<R extends { handoff?: RunHandoff; startedAt: number }>(runs: readonly R[]): (R & { handoff: RunHandoff }) | undefined {
	return runs.find((run): run is R & { handoff: RunHandoff } => run.handoff !== undefined);
}

/** 收尾規則: once an attempt is 已接手, whether the task ends and as what. One-shot tasks are
 *  已完成; a reusable one is 已到期 after a timeout handoff or one that succeeded past the deadline;
 *  otherwise null, and the task waits again once the run is over. */
export function closingOf(settings: Pick<EventSettings, 'repeat'>, handoff: RunHandoff, deadlineAt: number): EventEnd | null {
	if (handoff.status !== 'handed') return null;
	if (!settings.repeat) return 'done';
	if (handoff.event.cause === 'deadline' || (handoff.settledAt ?? 0) >= deadlineAt) return 'expired';
	return null;
}

/** The task's state from its wait and runs (newest first): an end first, then the latest
 *  attempt (接手中, 接手失敗, 接手結果不明, or its run still going), then paused, then waiting. */
export function eventState(paused: boolean, wait: Pick<EventWait, 'ended'>, runs: readonly { handoff?: RunHandoff; startedAt: number; status: string; review?: unknown; fix?: unknown }[], open: (run: any) => boolean): EventTaskState {
	if (wait.ended) return wait.ended.status;
	const last = latestHandoff(runs);
	if (last?.handoff.status === 'handing') return 'handing';
	if (last?.handoff.status === 'failed') return 'failed';
	if (last?.handoff.status === 'unknown') return 'unknown';
	if (last && open(last)) return 'running';
	return paused ? 'paused' : 'waiting';
}

/** An event in words, for the list (等待事件：…) and the handoff message. */
export function eventText(event: EventSpec, timeText: (time: number) => string): string {
	if (event.type === 'process') return `程序 ${event.pid} 結束`;
	if (event.type === 'file') return `檔案出現或更新：${event.path}`;
	if (event.type === 'log') return `Log 檔 ${event.path} 出現「${event.text}」${event.caseSensitive ? '' : '（不分大小寫）'}`;
	return `到達 ${timeText(event.at)}（台灣時間）`;
}
