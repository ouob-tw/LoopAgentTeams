// The 自動化 tab's tasks as the board keeps them, and the rules every part reads them by: which
// period a time falls in, whether a day is inside a task's run window, when the next automatic try
// is due and what a task's state this period is. Pure: every day, period and set time is read in
// Asia/Taipei whatever the host's zone, times are kept as UTC milliseconds, and the page only words
// what the server sent.

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
	/** HH:MM in Asia/Taipei. */
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

/** `skipped`: an automatic try came due while the task still ran; it is recorded and counts as the day's try. */
export type RunStatus = 'running' | 'success' | 'failed' | 'timeout' | 'stopped' | 'config-error' | 'quota' | 'skipped';

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
	/** An agent run's HCOM name, once hcom gave it. */
	agentName?: string;
	/** An agent run's session, once hcom listed it: its page on the board. */
	sessionId?: string;
	/** The Herdr workspace its agent opened in, for a resume there. */
	agentWorkspace?: string;
	/** Replies of the conversation at or before this position came before the latest resume. */
	judgeAfter?: number;
	/** The codex-multi-auth account a Codex run's agent runs on: pinned when it launched or switched to. */
	codexAccount?: number;
	/** Each switch of Codex account the run made, in words. */
	accountSwitches?: string[];
	/** The agent could not be closed after the run ended: why. */
	closeError?: string;
	checks?: CheckResult[];
	/** Why it failed or was cut short, in words for the user. */
	reason?: string;
	/** Where the kept output is, relative to the board's automation folder. */
	output?: string;
	/** The output was longer than what is kept: only its end is. */
	outputTruncated?: boolean;
	/** 沿用原紀錄: the project's own done marker this record stands for. */
	marker?: string;
	/** The checking agent's work on a run that succeeded, while it checks and once it judged; a fail makes a red card. */
	review?: RunReview;
	/** The questions the agent asked while it ran (ASK: …) and the answers it got (#605); the checking agent reads them. */
	asks?: RunAsk[];
}

/** One question of a run's agent and the answer it got. */
export interface RunAsk {
	question: string;
	askedAt: number;
	answer?: string;
	answeredAt?: number;
	/** Where the answer came from: the board or the agent's terminal. */
	source?: string;
}

/** The checking agent's verdict on one checklist item. */
export interface ReviewItem {
	label: string;
	ok: boolean;
	reason?: string;
}

/** `checking` counts as the task still running. `error`: it ended without a verdict (past the limit,
 *  gone, out of quota, could not start, replied in another form, stopped). */
export type ReviewStatus = 'checking' | 'pass' | 'fail' | 'error';

/** The checking agent of a run: its settings when it started, its agent kept as a run's own is,
 *  and its verdict item by item. */
export interface RunReview {
	status: ReviewStatus;
	startedAt: number;
	endedAt?: number;
	client: AgentClient;
	model: string;
	effort: AgentEffort;
	/** Its brief, relative to the board's automation folder. */
	brief?: string;
	agentName?: string;
	sessionId?: string;
	agentWorkspace?: string;
	judgeAfter?: number;
	codexAccount?: number;
	accountSwitches?: string[];
	closeError?: string;
	items?: ReviewItem[];
	/** Why it ended without a verdict, or why a PASS was not taken as one. */
	reason?: string;
	/** How a check with no verdict ended, when it was 停止這次, past the limit or out of quota: its
	 *  label and card say so as a run's would. */
	ended?: 'stopped' | 'timeout' | 'quota';
}

/** A period's run window: its first moment and the moment after its last day. */
export interface RunWindow {
	period: string;
	from: number;
	to: number;
}

/** A period whose whole window passed with no run at all, while the task was not paused. */
export interface MissedPeriod extends RunWindow {
	recordedAt: number;
	/** 這期就算了: no longer shown. */
	dismissedAt?: number;
}

/** A task's state this period, as the list's pill shows it. */
/** `asking`: the run's agent asked the user something (ASK:) and waits for the answer. */
export type TaskState = 'running' | 'asking' | 'paused' | 'done' | 'failed' | 'check-failed' | 'missed' | 'waiting';

export interface AutomationTaskView {
	task: AutomationTask;
	state: TaskState;
	/** When the next automatic try is due; null when paused or none is in sight. */
	nextAt: number | null;
	/** Newest first, the latest few. */
	runs: AutomationRun[];
	/** Missed periods still to be handled (not dismissed, no run since), oldest first. */
	missed: MissedPeriod[];
}

/** A task file the board could not read: shown as an error, never taken for an empty task. */
export interface BrokenTask {
	file: string;
	error: string;
}

export interface AutomationSnapshot {
	/** Grows with every change, so a page keeps only the newest of two it hears. */
	revision: number;
	/** Asia/Taipei: every time shown is in it. */
	timeZone: string;
	tasks: AutomationTaskView[];
	broken: BrokenTask[];
}

/** The zone every day, period and set time is read in, whatever the host's own. */
export const TIME_ZONE = 'Asia/Taipei';
/** Asia/Taipei has kept UTC+8 with no daylight saving since 1980, so its days are fixed offsets of UTC. */
const OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;

export const EMPTY_AUTOMATION: AutomationSnapshot = { revision: 0, timeZone: TIME_ZONE, tasks: [], broken: [] };

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

/** A calendar day in Asia/Taipei. */
interface Day {
	year: number;
	/** 1–12. */
	month: number;
	day: number;
	weekday: Weekday;
}

const pad = (value: number) => String(value).padStart(2, '0');

function dayOf(time: number): Day {
	const date = new Date(time + OFFSET_MS);
	const weekday = date.getUTCDay();
	return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), weekday: (weekday === 0 ? 7 : weekday) as Weekday };
}

/** The first moment of a day in Asia/Taipei; a day past the month's end runs on into the next. */
const dayStart = (year: number, month: number, day: number) => Date.UTC(year, month - 1, day) - OFFSET_MS;
const startOf = (day: Day) => dayStart(day.year, day.month, day.day);
const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** The period a time falls in: the month (2026-11), the week by its Monday (2026-W11-09) or the day (2026-11-13). */
export function periodOf(schedule: AutomationSchedule, time: number): string {
	const day = dayOf(time);
	if (schedule.type === 'monthly') return `${day.year}-${pad(day.month)}`;
	if (schedule.type === 'daily') return `${day.year}-${pad(day.month)}-${pad(day.day)}`;
	const monday = dayOf(dayStart(day.year, day.month, day.day - (day.weekday - 1)));
	return `${monday.year}-W${pad(monday.month)}-${pad(monday.day)}`;
}

/** The run window of the period a time falls in: its first moment and the moment after its last
 *  day. A month shorter than the window ends it on its last day. */
export function windowOf(schedule: AutomationSchedule, time: number): RunWindow {
	const day = dayOf(time);
	const period = periodOf(schedule, time);
	if (schedule.type === 'daily') return { period, from: startOf(day), to: startOf(day) + DAY_MS };
	if (schedule.type === 'weekly') {
		const monday = startOf(day) - (day.weekday - 1) * DAY_MS;
		return { period, from: monday + (schedule.fromWeekday - 1) * DAY_MS, to: monday + schedule.toWeekday * DAY_MS };
	}
	const last = daysInMonth(day.year, day.month);
	const from = dayStart(day.year, day.month, Math.min(schedule.fromDay, last));
	return { period, from, to: dayStart(day.year, day.month, Math.min(schedule.toDay, last)) + DAY_MS };
}

/** Whether a day is inside the run window; the window's last day counts to its end. */
export function inWindow(schedule: AutomationSchedule, time: number): boolean {
	const { from, to } = windowOf(schedule, time);
	return time >= from && time < to;
}

/** How far back a check looks: a board off for years still starts in a moment. */
const LOOK_BACK_DAYS = 3_660;

/** The windows that ended after `after` and by `upTo`, oldest first, from the last LOOK_BACK_DAYS days. */
export function endedWindows(schedule: AutomationSchedule, after: number, upTo: number): RunWindow[] {
	const found = new Map<string, RunWindow>();
	const first = Math.max(after, upTo - LOOK_BACK_DAYS * DAY_MS);
	for (let time = startOf(dayOf(first)); time <= upTo; time += DAY_MS) {
		const window = windowOf(schedule, time + DAY_MS / 2);
		if (window.to > after && window.to <= upTo) found.set(window.period, window);
	}
	return [...found.values()];
}

/** The set time on the day `time` falls in. */
function atTime(time: number, hhmm: string): number {
	const [hours, minutes] = hhmm.split(':').map(Number);
	return startOf(dayOf(time)) + (hours * 60 + minutes) * 60_000;
}

/** Whether two times fall on the same day in Asia/Taipei. */
export const sameDay = (a: number, b: number) => startOf(dayOf(a)) === startOf(dayOf(b));

/** Runs that settle a period: any run but a preview that ended in success, and passed its check when it had one. */
export const succeeded = (run: AutomationRun) => run.trigger !== 'preview' && run.status === 'success' && (!run.review || run.review.status === 'pass');
/** The run is still going: running, or its checking agent is still at it. Either way the task is busy. */
export const isOpen = (run: Pick<AutomationRun, 'status' | 'review'>) => run.status === 'running' || run.review?.status === 'checking';
/** The question a running run's agent waits on: its last one, while unanswered. */
export function openAsk(run: Pick<AutomationRun, 'status' | 'asks'>): RunAsk | undefined {
	const last = run.status === 'running' ? run.asks?.at(-1) : undefined;
	return last && last.answeredAt === undefined ? last : undefined;
}
/** Where an answer came from, as the record shows it: the board's reply box or the agent's own terminal. */
export const ASK_SOURCE = { board: '看板', terminal: '終端' } as const;
/** The first line of a question: a yellow card's title and the start of its push. */
export const askFirstLine = (question: string) => question.trim().split('\n')[0].trim();
/** Its check ended without a pass: failed, or could not judge (stopped by the user aside). */
export const reviewFailed = (run: Pick<AutomationRun, 'status' | 'review'>) =>
	run.status === 'success' && (run.review?.status === 'fail' || (run.review?.status === 'error' && run.review.ended !== 'stopped'));
/** What a run's label says: its own status, or how its check ended when that went otherwise than a pass. */
export function runLabel(run: Pick<AutomationRun, 'status' | 'review' | 'asks'>): { text: string; key: string } {
	if (openAsk(run)) return { text: STATE_TEXT.asking, key: 'asking' };
	const review = run.status === 'success' ? run.review : undefined;
	if (!review || review.status === 'pass') return { text: RUN_STATUS_TEXT[run.status], key: run.status };
	if (review.status === 'checking') return { text: '▶ 檢查中', key: 'running' };
	if (review.status === 'error' && review.ended) return { text: RUN_STATUS_TEXT[review.ended], key: review.ended };
	return { text: STATE_TEXT['check-failed'], key: 'check-failed' };
}
/** An automatic try made on the day `time` falls in: whatever it ended in, it is the day's one. */
export const triedOn = (runs: readonly AutomationRun[], time: number) => runs.some((run) => run.trigger === 'auto' && sameDay(run.startedAt, time));

/** When today's automatic try is due: at the set time, or at once on the board's first check after
 *  it started. Null when no try is due today: paused, outside the window, tried already, the period
 *  done. Whether the task is running now is the caller's to see. */
export function dueToday(task: AutomationTask, runs: readonly AutomationRun[], now: number): number | null {
	if (task.paused || !inWindow(task.schedule, now) || triedOn(runs, now)) return null;
	const period = periodOf(task.schedule, now);
	if (runs.some((run) => run.period === period && succeeded(run))) return null;
	return atTime(now, task.time);
}

/** The next automatic try: the first day from today inside the window whose period has not
 *  succeeded, at the set time; today only while no automatic try was made today. */
export function nextAutoAt(task: AutomationTask, runs: readonly AutomationRun[], now: number): number | null {
	if (task.paused) return null;
	const done = new Set(runs.filter(succeeded).map((run) => run.period));
	const triedToday = triedOn(runs, now);
	const today = startOf(dayOf(now));
	// A month window is at most a month away, with periods that succeeded skipped on the way.
	for (let offset = 0; offset < 800; offset++) {
		const noon = today + offset * DAY_MS + DAY_MS / 2;
		if (!inWindow(task.schedule, noon) || done.has(periodOf(task.schedule, noon))) continue;
		if (offset === 0 && triedToday) continue;
		return atTime(noon, task.time);
	}
	return null;
}

const FAILED: readonly RunStatus[] = ['failed', 'timeout', 'stopped', 'config-error', 'quota'];

/** The missed periods still to show: not dismissed, and no 立即執行 (or 沿用原紀錄) since the window
 *  ended. A later automatic try does not count: only the user handles a miss. */
export function openMissed(missed: readonly MissedPeriod[], runs: readonly AutomationRun[]): MissedPeriod[] {
	const latest = Math.max(-Infinity, ...runs.filter((run) => run.trigger === 'manual' || run.trigger === 'carried').map((run) => run.startedAt));
	return missed.filter((entry) => entry.dismissedAt === undefined && latest < entry.to).sort((a, b) => a.from - b.from);
}

/** The task's state this period: running first, then paused; else done once a run of this period
 *  succeeded (a later failure does not undo it), missed while a missed period is still open,
 *  failed when this period's latest run failed. */
export function taskState(task: AutomationTask, runs: readonly AutomationRun[], now: number, missed: readonly MissedPeriod[] = []): TaskState {
	if (runs.some((run) => openAsk(run))) return 'asking';
	if (runs.some(isOpen)) return 'running';
	if (task.paused) return 'paused';
	const period = periodOf(task.schedule, now);
	const own = runs.filter((run) => run.period === period && run.trigger !== 'preview' && run.status !== 'skipped');
	if (own.some(succeeded)) return 'done';
	if (openMissed(missed, runs).length) return 'missed';
	const latest = own.reduce<AutomationRun | undefined>((last, run) => (!last || run.startedAt > last.startedAt ? run : last), undefined);
	if (latest?.review?.status === 'error' && (latest.review.ended === 'quota' || latest.review.ended === 'timeout')) return 'failed';
	if (latest && reviewFailed(latest)) return 'check-failed';
	if (latest && FAILED.includes(latest.status)) return 'failed';
	return 'waiting';
}

/** A missed window as the list words it: 11/8–11/10, or 11/13 for one day; the year is added when
 *  it is not the year of `reference` (the newest window in the same line). */
export function windowText(entry: { from: number; to: number }, reference: number): string {
	const first = dayOf(entry.from);
	const last = dayOf(entry.to - 1);
	const thisYear = dayOf(reference).year;
	const text = (day: Day, withYear: boolean) => `${withYear ? `${day.year}/` : ''}${day.month}/${day.day}`;
	const start = text(first, first.year !== thisYear);
	if (startOf(first) === startOf(last)) return start;
	return `${start}–${text(last, last.year !== first.year)}`;
}

/** How many missed windows a line names before it only counts the rest. */
export const MISSED_NAMED = 3;

/** The missed windows named in a line, oldest first: the first few, each year shown against the newest's. */
export function missedNames(missed: readonly MissedPeriod[]): string[] {
	const reference = missed.at(-1)!.to - 1;
	return missed.slice(0, MISSED_NAMED).map((entry) => windowText(entry, reference));
}

/** The list card's line for the missed periods (oldest first), short enough for a phone's card:
 *  the window when there is one, else how many; the task's page names them. */
export function missedText(missed: readonly MissedPeriod[]): string {
	if (missed.length === 1) return `${missedNames(missed)[0]} 看板沒開，這期沒跑`;
	return `看板沒開，錯過 ${missed.length} 期，沒有自動補跑`;
}

export const STATE_TEXT: Record<TaskState, string> = {
	running: '▶ 執行中',
	asking: '? 等你回覆',
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
	quota: '✕ 額度用完',
	skipped: '↷ 跳過'
};

export const TRIGGER_TEXT: Record<RunTrigger, string> = {
	auto: '自動',
	manual: '手動',
	preview: '預覽',
	carried: '沿用原紀錄'
};

/** Formats a time in the given zone (Asia/Taipei for the board): 11/05 09:00, or 09:00 alone. */
export function timeFormat(timeZone: string) {
	const date = new Intl.DateTimeFormat('en-US', { timeZone, month: '2-digit', day: '2-digit' });
	const clock = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false });
	return {
		day: (time: number) => date.format(time),
		clock: (time: number) => clock.format(time),
		full: (time: number) => `${date.format(time)} ${clock.format(time)}`
	};
}

/** The checking agent's result in one short line; empty when the run had none. */
export function reviewText(review: RunReview | undefined): string {
	if (!review) return '';
	const items = review.items ?? [];
	const failed = items.filter((item) => !item.ok).length;
	if (review.status === 'checking') return '檢查中';
	if (review.status === 'pass') return `檢查通過（${items.length} 條都過）`;
	if (review.status === 'fail') return failed ? `檢查未過（${failed} 條沒過）` : '檢查未過';
	return '檢查沒有做完';
}

/** Why a run ended as it did, in one short line. */
export function runReason(run: AutomationRun): string {
	if (run.reason) return run.reason;
	if (run.status === 'success') return run.checks?.length ? `${run.checks.length} 項檢查都通過` : run.agentName ? 'Agent 回覆 DONE' : '結束碼 0';
	const failed = run.checks?.filter((check) => !check.ok) ?? [];
	if (run.exitCode !== undefined && run.exitCode !== 0) return run.exitCode === null ? '被中止' : `結束碼 ${run.exitCode}`;
	if (failed.length) return `檢查沒過：${failed.map((check) => check.label).join('、')}`;
	return RUN_STATUS_TEXT[run.status].slice(2);
}

/** The list card's last line: how the latest run ended, or that there has been none. */
export function lastRunText(run: AutomationRun | undefined, timeZone: string, now?: number): string {
	if (!run) return '還沒跑過';
	const at = timeFormat(timeZone);
	const asked = openAsk(run);
	if (asked) return `${at.full(run.startedAt)} 開始，${at.clock(asked.askedAt)} 起等你回覆`;
	const replied = run.status === 'running' ? run.asks?.at(-1)?.answeredAt : undefined;
	if (replied !== undefined) return `${at.full(run.startedAt)} 開始，${at.clock(replied)} 你已回覆，繼續中`;
	if (run.status === 'running') return `${at.full(run.startedAt)} 開始，${now === undefined ? '執行中' : `已跑 ${Math.max(0, Math.floor((now - run.startedAt) / 60_000))} 分鐘`}`;
	const when = at.full(run.endedAt ?? run.startedAt);
	if (run.status === 'success' && run.review && run.review.status !== 'pass') return `${when} 做完，但${run.review.status === 'checking' ? '還在檢查' : reviewText(run.review)}`;
	if (run.status === 'success') return `${when} 完成，${run.review ? reviewText(run.review) : runReason(run)}`;
	return `${when} ${RUN_STATUS_TEXT[run.status].slice(2)}：${runReason(run)}`;
}
