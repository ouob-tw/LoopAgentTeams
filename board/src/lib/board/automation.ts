// The 自動化 tab's tasks as the board keeps them, and the rules every part reads them by: which
// period a time falls in, whether a day is inside a task's run window, when the next automatic try
// is due and what a task's state this period is. Pure: the server computes with them in the host's
// time zone, and the page only words what the server sent.

/** Monday is 1, Sunday 7: a week runs Monday to Sunday and a weekly window never wraps past Sunday. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type AutomationSchedule =
	| { type: 'monthly'; fromDay: number; toDay: number }
	| { type: 'weekly'; fromWeekday: Weekday; toWeekday: Weekday }
	| { type: 'daily' };

export type ScheduleType = AutomationSchedule['type'];

/** A check that costs no model quota, run after a command task ends. */
export type FixedCheck = { type: 'file'; path: string } | { type: 'output'; text: string };

export interface CommandSpec {
	command: string;
	/** As the user typed it; `~` is the board user's home. */
	folder: string;
	checks: FixedCheck[];
}

export type AgentClient = 'claude' | 'codex';
export const AGENT_EFFORTS = ['low', 'medium', 'high'] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];

export interface AgentSpec {
	client: AgentClient;
	model: string;
	effort: AgentEffort;
	folder: string;
	/** The task brief: relative to the folder, or absolute. */
	brief: string;
}

export interface ReviewSpec {
	/** 跑完後請 Agent 檢查. */
	enabled: boolean;
	/** One item per line of the form's box. */
	checklist: string[];
	/** The checking agent: by default the other client than the task's own agent. */
	client: AgentClient;
	model: string;
	effort: AgentEffort;
}

/** The checking agent's client when none is chosen: the other one than the task's agent; a command task's is Codex. */
export const defaultReviewClient = (kind: 'command' | 'agent', agentClient?: AgentClient): AgentClient =>
	kind === 'agent' && agentClient === 'codex' ? 'claude' : 'codex';

/** Each client's model a checking agent starts with until one is chosen. */
export const DEFAULT_REVIEW_MODEL: Record<AgentClient, string> = { claude: 'claude-opus-5-5', codex: 'gpt-6.1-sol' };

export const EFFORT_TEXT: Record<AgentEffort, string> = { low: '低', medium: '中', high: '高' };
export const clientName = (client: AgentClient) => (client === 'codex' ? 'Codex' : 'Claude');

/** What the form edits. A task that succeeds in a period does not run again that period: fixed, not a field. */
export interface AutomationTaskInput {
	name: string;
	schedule: AutomationSchedule;
	/** HH:MM in the host's time zone. */
	time: string;
	limitMinutes: number;
	kind: 'command' | 'agent';
	command?: CommandSpec;
	agent?: AgentSpec;
	review: ReviewSpec;
}

export interface AutomationTask extends AutomationTaskInput {
	id: string;
	paused: boolean;
	createdAt: string;
	updatedAt: string;
}

/** 自動、手動、預覽、沿用原紀錄. */
export type RunTrigger = 'auto' | 'manual' | 'preview' | 'carried';

export type RunStatus = 'running' | 'success' | 'failed' | 'timeout' | 'stopped' | 'config-error' | 'quota';

export interface CheckResult {
	/** The check as the user reads it, e.g. 檔案存在：backup/db.gz. */
	label: string;
	ok: boolean;
	/** Why it did not pass, when there is more to say than the label. */
	detail?: string;
}

/** One run as its record says now; the record file holds it as a line at the start and one at the end. */
export interface AutomationRun {
	id: string;
	taskId: string;
	trigger: RunTrigger;
	/** The period the run belongs to: the one its start fell in, kept whatever happens after. */
	period: string;
	startedAt: number;
	endedAt?: number;
	status: RunStatus;
	/** A command's exit code; null when it was ended by a signal. */
	exitCode?: number | null;
	/** The command's process. */
	pid?: number;
	/** An agent run's HCOM name (agent runs come later). */
	agentName?: string;
	checks?: CheckResult[];
	/** Why it failed or was cut short, in words for the user. */
	reason?: string;
	/** Where the kept output is, relative to the board's automation folder. */
	output?: string;
	/** The output was longer than what is kept: only its end is. */
	outputTruncated?: boolean;
}

/** A task's state this period, as the list's pill shows it. */
export type TaskState = 'running' | 'paused' | 'done' | 'failed' | 'check-failed' | 'missed' | 'waiting';

export interface AutomationTaskView {
	task: AutomationTask;
	state: TaskState;
	/** When the next automatic try is due; null when paused or none is in sight. */
	nextAt: number | null;
	/** Newest first, the latest few. */
	runs: AutomationRun[];
}

/** A task file the board could not read: shown as an error, never taken for an empty task. */
export interface BrokenTask {
	file: string;
	error: string;
}

export interface AutomationSnapshot {
	/** Grows with every change, so a page keeps only the newest of two it hears. */
	revision: number;
	/** The host's time zone: every time shown is in it. */
	timeZone: string;
	tasks: AutomationTaskView[];
	broken: BrokenTask[];
}

export const EMPTY_AUTOMATION: AutomationSnapshot = { revision: 0, timeZone: 'UTC', tasks: [], broken: [] };

const WEEKDAY_NAMES = ['一', '二', '三', '四', '五', '六', '日'];
export const weekdayName = (day: number) => WEEKDAY_NAMES[day - 1] ?? '?';

/** The run window as the list shows it: 每月 1–5 日 10:00, 每週一至三 09:00, 每天 03:00. */
export function scheduleText(schedule: AutomationSchedule, time: string): string {
	if (schedule.type === 'daily') return `每天 ${time}`;
	if (schedule.type === 'weekly') {
		const { fromWeekday: from, toWeekday: to } = schedule;
		return `每週${weekdayName(from)}${from === to ? '' : `至${weekdayName(to)}`} ${time}`;
	}
	const { fromDay: from, toDay: to } = schedule;
	return `每月 ${from === to ? from : `${from}–${to}`} 日 ${time}`;
}

export const kindText = (kind: AutomationTask['kind']) => (kind === 'command' ? '指令' : 'Agent');

/** A calendar day in the host's time zone. */
interface Day {
	year: number;
	/** 1–12. */
	month: number;
	day: number;
	weekday: Weekday;
}

const pad = (value: number) => String(value).padStart(2, '0');

function dayOf(time: number): Day {
	const date = new Date(time);
	const weekday = date.getDay();
	return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), weekday: (weekday === 0 ? 7 : weekday) as Weekday };
}

const daysInMonth = (year: number, month: number) => new Date(year, month, 0).getDate();

/** The period a time falls in: the month (2026-11), the week by its Monday (2026-W11-09) or the day (2026-11-13). */
export function periodOf(schedule: AutomationSchedule, time: number): string {
	const day = dayOf(time);
	if (schedule.type === 'monthly') return `${day.year}-${pad(day.month)}`;
	if (schedule.type === 'daily') return `${day.year}-${pad(day.month)}-${pad(day.day)}`;
	const monday = new Date(day.year, day.month - 1, day.day - (day.weekday - 1));
	return `${monday.getFullYear()}-W${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`;
}

/** Whether a day is inside the run window; a month shorter than the window ends it on its last day. */
export function inWindow(schedule: AutomationSchedule, time: number): boolean {
	const day = dayOf(time);
	if (schedule.type === 'daily') return true;
	if (schedule.type === 'weekly') return day.weekday >= schedule.fromWeekday && day.weekday <= schedule.toWeekday;
	const last = daysInMonth(day.year, day.month);
	const from = Math.min(schedule.fromDay, last);
	const to = Math.min(schedule.toDay, last);
	return day.day >= from && day.day <= to;
}

/** The time of day on the day `time` falls in. */
function atTime(time: number, hhmm: string): number {
	const [hours, minutes] = hhmm.split(':').map(Number);
	const date = new Date(time);
	return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hours, minutes).getTime();
}

/** Runs that settle a period: any run but a preview that ended in success. */
export const succeeded = (run: AutomationRun) => run.trigger !== 'preview' && run.status === 'success';
const isRunning = (run: AutomationRun) => run.status === 'running';

/** The next automatic try: the first day from today inside the window whose period has not
 *  succeeded, at the set time; today only while no automatic try was made today. */
export function nextAutoAt(task: AutomationTask, runs: readonly AutomationRun[], now: number): number | null {
	if (task.paused) return null;
	const done = new Set(runs.filter(succeeded).map((run) => run.period));
	const today = dayOf(now);
	const triedToday = runs.some((run) => run.trigger === 'auto' && sameDay(dayOf(run.startedAt), today));
	// A month window is at most a month away, with periods that succeeded skipped on the way.
	for (let offset = 0; offset < 800; offset++) {
		const noon = new Date(today.year, today.month - 1, today.day + offset, 12).getTime();
		if (!inWindow(task.schedule, noon) || done.has(periodOf(task.schedule, noon))) continue;
		if (offset === 0 && triedToday) continue;
		return atTime(noon, task.time);
	}
	return null;
}

const sameDay = (a: Day, b: Day) => a.year === b.year && a.month === b.month && a.day === b.day;

const FAILED: readonly RunStatus[] = ['failed', 'timeout', 'stopped', 'config-error', 'quota'];

/** The task's state this period: running first, then paused; else done once a run of this period
 *  succeeded (a later failure does not undo it), failed when this period's latest run failed. */
export function taskState(task: AutomationTask, runs: readonly AutomationRun[], now: number): TaskState {
	if (runs.some(isRunning)) return 'running';
	if (task.paused) return 'paused';
	const period = periodOf(task.schedule, now);
	const own = runs.filter((run) => run.period === period && run.trigger !== 'preview');
	if (own.some(succeeded)) return 'done';
	const latest = own.reduce<AutomationRun | undefined>((last, run) => (!last || run.startedAt > last.startedAt ? run : last), undefined);
	if (latest && FAILED.includes(latest.status)) return 'failed';
	return 'waiting';
}

export const STATE_TEXT: Record<TaskState, string> = {
	running: '▶ 執行中',
	paused: '‖ 已暫停',
	done: '✓ 本期已完成',
	failed: '✕ 失敗',
	'check-failed': '✕ 檢查未過',
	missed: '! 本期錯過',
	waiting: '… 等待中'
};

export const RUN_STATUS_TEXT: Record<RunStatus, string> = {
	running: '▶ 執行中',
	success: '✓ 成功',
	failed: '✕ 失敗',
	timeout: '✕ 逾時',
	stopped: '■ 已停止',
	'config-error': '✕ 設定錯誤',
	quota: '✕ 額度用完'
};

export const TRIGGER_TEXT: Record<RunTrigger, string> = {
	auto: '自動',
	manual: '手動',
	preview: '預覽',
	carried: '沿用原紀錄'
};

/** Formats a time in the host's time zone: 11/05 09:00, or 09:00 alone. */
export function timeFormat(timeZone: string) {
	const date = new Intl.DateTimeFormat('en-US', { timeZone, month: '2-digit', day: '2-digit' });
	const clock = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false });
	return {
		day: (time: number) => date.format(time),
		clock: (time: number) => clock.format(time),
		full: (time: number) => `${date.format(time)} ${clock.format(time)}`
	};
}

/** Why a run ended as it did, in one short line. */
export function runReason(run: AutomationRun): string {
	if (run.reason) return run.reason;
	if (run.status === 'success') return run.checks?.length ? `${run.checks.length} 項檢查都通過` : '結束碼 0';
	const failed = run.checks?.filter((check) => !check.ok) ?? [];
	if (run.exitCode !== undefined && run.exitCode !== 0) return run.exitCode === null ? '被中止' : `結束碼 ${run.exitCode}`;
	if (failed.length) return `檢查沒過：${failed.map((check) => check.label).join('、')}`;
	return RUN_STATUS_TEXT[run.status].slice(2);
}

/** The list card's last line: how the latest run ended, or that there has been none. */
export function lastRunText(run: AutomationRun | undefined, timeZone: string): string {
	if (!run) return '還沒跑過';
	const at = timeFormat(timeZone);
	if (run.status === 'running') return `${at.full(run.startedAt)} 開始，執行中`;
	const when = at.full(run.endedAt ?? run.startedAt);
	if (run.status === 'success') return `${when} 完成，${runReason(run)}`;
	return `${when} ${RUN_STATUS_TEXT[run.status].slice(2)}：${runReason(run)}`;
}
