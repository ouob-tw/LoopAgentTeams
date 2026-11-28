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
	/** What this attempt's delivery left: the session its new Agent got; for 接回原主控 (#764) the
	 *  session hcom resumed with what it reported (`resumed`: its HCOM name, when it printed one), or
	 *  the ID of the HCOM message sent to the controller that was running (`to`: its HCOM name). */
	evidence?: { sessionId?: string; resumed?: { name: string | null }; messageId?: string; to?: string };
	/** Why it failed or is not known. */
	reason?: string;
	/** When it became 已接手, 接手失敗 or 接手結果不明. */
	settledAt?: number;
	/** Written with the end of an 已接手 attempt's run: the wait a reusable task starts from then. */
	next?: EventWait;
}

/** How an event task ended for good. */
export type EventEnd = 'done' | 'expired' | 'expired-paused';

/** `automation/events/<task>.json`: where the wait stands, written whole by the board. */
export interface EventWait {
	version: 1;
	/** Events count from here: the approval, the end of the run of the last handoff, or a resume. */
	since: number;
	/** A Log event's file as last read: its identity and the byte up to which every whole line was
	 *  looked at. Null while there is no such file (it is read from byte 0 once it is there);
	 *  absent while the wait began on a file that could not be read (its length then is the start). */
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

/** 事件等待 (#764): a 接回原主控 task's controller that asked the board to pause and close it, kept
 *  as `automation/away/<task>.json` until it is handed back (confirmed), the task is deleted or it
 *  ends 已到期（暫停中）. The shared pause record (`reason: event-task`) is written from it, and
 *  written again from it when the board starts. */
export interface EventAway {
	version: 1;
	taskId: string;
	sessionId: string;
	hcomName: string;
	client: string;
	/** Its Herdr pane and workspace when it closed: where hcom resumes it. */
	pane: string | null;
	workspace: string | null;
	/** UTC ISO 8601, as the pause record's `paused_at`. */
	pausedAt: string;
}

/** The roster's words for a controller waiting on its event task. */
export const awayText = (taskName: string) => `等待事件任務：${taskName}`;

/** Why an event task has no edit: the board refuses it and its page says so. */
export const EVENT_UNCHANGEABLE = '事件任務建立後不能修改；要改請刪除，讓主控重新提案，再用 passkey 核准';

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
export function eventState<R extends { handoff?: RunHandoff; startedAt: number }>(paused: boolean, wait: Pick<EventWait, 'ended'>, runs: readonly R[], open: (run: R) => boolean): EventTaskState {
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

// ── Words for the pages (#765) ──

/** The event in a few words for the list's state mark: Log 出現「DONE」, report.md 出現或更新. */
export function eventShort(event: EventSpec, timeText: (time: number) => string): string {
	if (event.type === 'process') return `程序 ${event.pid} 結束`;
	if (event.type === 'file') return `${event.path.split('/').filter(Boolean).at(-1) ?? event.path} 出現或更新`;
	if (event.type === 'log') return `Log 出現「${event.text}」`;
	return `到 ${timeText(event.at)}`;
}

/** 觸發條件 as the task page and the approval card show it: the kind, then its fields
 *  (`mono` for paths, PIDs and the text looked for). */
export function eventRows(event: EventSpec, timeText: (time: number) => string): { kind: string; rows: { label: string; value: string; mono?: boolean }[] } {
	if (event.type === 'process') return { kind: '程序結束', rows: [{ label: 'PID', value: String(event.pid), mono: true }] };
	if (event.type === 'file') return { kind: '檔案出現或更新', rows: [{ label: '路徑', value: event.path, mono: true }] };
	if (event.type === 'log')
		return {
			kind: 'Log 檔出現文字',
			rows: [
				{ label: '路徑', value: event.path, mono: true },
				{ label: '文字', value: event.text, mono: true },
				...(event.caseSensitive ? [] : [{ label: '大小寫', value: '不分' }])
			]
		};
	return { kind: '到達時間', rows: [{ label: '時間', value: `${timeText(event.at)}（台灣時間）` }] };
}

/** 次數 in words. */
export const repeatText = (repeat: boolean) => (repeat ? '可重複' : '一次性');

/** Why a handoff ran, as a run's mark and the list's last line say it. */
export const CAUSE_SHORT: Record<HandoffCause, string> = { event: '事件發生', deadline: '期限到了', manual: '手動觸發' };

/** What a settled attempt did, in a few words: 已開新 Agent, 已接回主控 rivuta, 已傳訊息給主控 rivuta,
 *  接手失敗, 接手結果不明, 接手中. `controller`: the registering controller's HCOM name. */
export function outcomeText(handoff: Pick<RunHandoff, 'status' | 'evidence'>, kind: HandoffKind, controller: string | null): string {
	if (handoff.status !== 'handed') return HANDOFF_TEXT[handoff.status];
	if (kind === 'new-agent') return '已開新 Agent';
	const name = controller ?? handoff.evidence?.to ?? handoff.evidence?.resumed?.name ?? null;
	const who = name ? ` ${name}` : '';
	return handoff.evidence?.messageId !== undefined ? `已傳訊息給主控${who}` : `已接回主控${who}`;
}

/** The state mark's colour: waiting for the event, going, done, needs the user, or off. */
export type MarkTone = 'event' | 'going' | 'ok' | 'warn' | 'bad' | 'wait';

/** An event task's state mark on its card and page: an icon and words, and the colour. The latest
 *  attempt (`last`) tells an ended one-shot task that ran at its deadline from one whose event came. */
export function eventMark(state: EventTaskState, event: EventSpec, last: Pick<RunHandoff, 'event'> | undefined, timeText: (time: number) => string): Mark {
	const what = eventShort(event, timeText);
	const cause = last?.event.cause;
	switch (state) {
		case 'waiting':
			return { tone: 'event', text: `… 等待事件：${what}` };
		case 'paused':
			return { tone: 'wait', text: '‖ 已暫停' };
		case 'handing':
			return { tone: 'going', text: `▶ ${HANDOFF_TEXT.handing}` };
		case 'running':
			return { tone: 'going', text: cause === 'manual' ? '▶ 已手動觸發，Agent 執行中' : cause === 'deadline' ? '▶ 已到期，Agent 執行中' : `▶ 已發生：${what}` };
		case 'failed':
			return { tone: 'bad', text: `✕ ${HANDOFF_TEXT.failed}` };
		case 'unknown':
			return { tone: 'warn', text: `? ${HANDOFF_TEXT.unknown}` };
		case 'done':
			return cause === 'deadline' ? { tone: 'warn', text: '! 已到期：事件沒有發生' } : cause === 'manual' ? { tone: 'ok', text: '✓ 已手動觸發' } : { tone: 'ok', text: `✓ 已發生：${what}` };
		case 'expired':
			return { tone: 'warn', text: cause === 'deadline' ? '! 已到期：事件沒有發生' : '! 已到期' };
		case 'expired-paused':
			return { tone: 'warn', text: '! 已到期（暫停中）' };
	}
}

/** An event task that ended for good: only 刪除 is left. */
export const isEnded = (state: EventTaskState) => state === 'done' || state === 'expired' || state === 'expired-paused';

/** A state mark: its colour and its icon with words. */
export type Mark = { tone: MarkTone; text: string };

/** One handoff record's mark: how the attempt went, or why it ran once it was handed over. */
export function attemptMark(handoff: Pick<RunHandoff, 'status' | 'event'>): Mark {
	if (handoff.status === 'failed') return { tone: 'bad', text: `✕ ${HANDOFF_TEXT.failed}` };
	if (handoff.status === 'unknown') return { tone: 'warn', text: `? ${HANDOFF_TEXT.unknown}` };
	if (handoff.status === 'handing') return { tone: 'going', text: `▶ ${HANDOFF_TEXT.handing}` };
	return handoff.event.cause === 'deadline' ? { tone: 'warn', text: `! ${CAUSE_SHORT.deadline}` } : { tone: 'ok', text: `✓ ${CAUSE_SHORT[handoff.event.cause]}` };
}

/** The state counts as waiting for the event task tab's number. */
export const isWaiting = (state: EventTaskState) => state === 'waiting';
