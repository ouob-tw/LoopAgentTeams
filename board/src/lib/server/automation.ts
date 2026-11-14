// The 自動化 tab's tasks on the server: one JSON file per task in the board state directory's
// `automation` folder, written whole and atomically; one record file per task that only ever grows
// (a line when a run starts and one when it ends); the output a command printed, cut to its end.
// A command task's run is a child process in the task's folder. The scheduler checks every minute, in
// Asia/Taipei: it starts the day's one automatic try, stops runs past their limit and records the
// periods whose window passed with no run (missed), and tells `notify` so red cards and pushes can
// follow. An agent task's run opens an agent through `agents` and is watched to its end there
// (`automation-agent.ts`); one still open when the board starts again is watched on. While its agent
// waits on a question (ASK:, 等你回覆) the run stays running: the question and its answer go into
// the run's record, `notify` hears of both for the yellow card and its push, and the answer the user
// writes on the board is sent to the agent here (`reply`).
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
	AGENT_EFFORTS,
	DEFAULT_REVIEW_MODEL,
	defaultReviewClient,
	dueToday,
	endedWindows,
	ASK_SOURCE,
	isOpen,
	nextAutoAt,
	openAsk,
	openMissed,
	periodOf,
	succeeded,
	taskState,
	TIME_ZONE,
	type AgentSpec,
	type AutomationRun,
	type AutomationSchedule,
	type AutomationSnapshot,
	type AutomationTask,
	type AutomationTaskInput,
	type BrokenTask,
	type CheckResult,
	type CommandSpec,
	type FixedCheck,
	type MissedPeriod,
	type RunAsk,
	type RunReview,
	type RunTrigger,
	grantHours,
	type TaskUnattended,
	type Weekday
} from '../board/automation.ts';
import { SCOPE_KEYS, type UnattendedScope } from '../board/unattended.ts';
import {
	codexBeforeLaunch,
	controllerGoesOn,
	controllerMessage,
	CONTROLLER_RESUME_MESSAGE,
	cutReason,
	firstMessage,
	GONE_AT_RESTART,
	runTag,
	watchAgent,
	type AgentEnd,
	type AgentHost,
	type Cut
} from './automation-agent.ts';
import { appendSent, readLines, type AutomationTaskSave } from './sent-log.ts';
import { judgeReview, REVIEW_RESUME_MESSAGE, reviewBrief, reviewMessage, reviewTag } from './automation-review.ts';

/** How much of a command's output is kept: its last part, which says how it ended. */
export const OUTPUT_KEEP_CHARS = 32_000;
/** How many runs each task sends to the pages, newest first. */
const RUNS_SHOWN = 20;
/** A command's process group gets this long to end after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 5_000;

/** Field name → what is wrong with it, worded for the form. */
export type FieldErrors = Record<string, string>;

export interface SavedBy {
	deviceId: string;
}

export type Saved = { ok: true; task: AutomationTask } | { ok: false; status: number; errors: FieldErrors };
export type Started = { ok: true; run: AutomationRun } | { ok: false; status: number; message: string };

/** What red cards and pushes are made from: a run that ended, or the periods one check found missed
 *  for one task (all of them in one event, however many). */
export type AutomationEvent =
	| { type: 'run-ended'; task: AutomationTask; run: AutomationRun }
	/** The run's agent asked the user its `index`th question (in `run.asks`) and waits. */
	| { type: 'asked'; task: AutomationTask; run: AutomationRun; index: number }
	/** The question the run's agent waited on was answered: it goes on. */
	| { type: 'answered'; task: AutomationTask; run: AutomationRun }
	| { type: 'missed'; task: AutomationTask; periods: MissedPeriod[] };

export interface Automation {
	snapshot(): AutomationSnapshot;
	/** `by`: the signed-in device that sent the form, written to the action log with the task's
	 *  unattended grant; an unattended task's runs start only from such a save. */
	create(input: unknown, by?: SavedBy): Saved;
	update(id: string, input: unknown, by?: SavedBy): Saved;
	setPaused(id: string, paused: boolean): AutomationTask | null;
	/** 立即執行: refused while the same task runs. Resolves once the run has started, not ended. */
	runNow(id: string): Started;
	/** 送出回覆: the answer to the question the task's run waits on, sent to its agent as a message
	 *  from the user and kept in the run's record. Refused when nothing waits or it cannot be sent. */
	reply(id: string, text: unknown): Promise<Started>;
	/** 停止這次: ends the task's running run, recorded as stopped; false when none runs. */
	stop(id: string): boolean | null;
	/** 沿用原紀錄: this period counts as done, standing for the project's own done marker. Only the
	 *  API offers it, never a button. */
	carry(id: string, marker: unknown): Started;
	/** 這期就算了: the task's open missed periods are no longer shown; the number dismissed. */
	dismissMissed(id: string): number | null;
	/** 刪除任務: the task and everything kept for it (runs, missed periods, outputs, checker briefs).
	 *  Refused while a run of it is unfinished (running, waiting on an answer, being checked). */
	remove(id: string): { ok: true } | { ok: false; status: number; message: string };
	/** The kept output of one run; null when there is none. */
	output(taskId: string, runId: string): string | null;
	/** Resolves once every run started so far has ended (tests and closing). */
	idle(): Promise<void>;
	close(): void;
}

const ID = /^[a-z0-9-]{1,64}$/;
const newId = () => randomBytes(5).toString('hex');

/** Write a whole file so a reader sees the old one or the new one, never half of it. */
export function writeAtomic(path: string, text: string): void {
	const temporary = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
	writeFileSync(temporary, text, { mode: 0o600 });
	renameSync(temporary, path);
}

/** `~` and `~/…` are the board user's home; anything else is taken as typed. */
export function expandHome(path: string, home = homedir()): string {
	if (path === '~') return home;
	return path.startsWith('~/') ? join(home, path.slice(2)) : path;
}

const isDirectory = (path: string) => {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
};
const isFile = (path: string) => {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
};

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const integer = (value: unknown) => {
	const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
	return Number.isInteger(number) ? number : NaN;
};

/** An agent task's unattended grant as the form sent it: absent or null is none. A list's lines
 *  may come as one text, as the form's box holds them. */
function taskUnattended(given: unknown, errors: FieldErrors): TaskUnattended | undefined {
	if (given === undefined || given === null) return undefined;
	const body = (typeof given === 'object' ? given : {}) as Record<string, any>;
	const goal = text(body.goal);
	if (!goal) errors.unattendedGoal = '請填這一輪的目標';
	const done = (Array.isArray(body.done) ? body.done : String(body.done ?? '').split('\n')).map(text).filter(Boolean);
	if (!done.length) errors.unattendedDone = '做完條件至少寫一條';
	const scopeGiven = body.scope && typeof body.scope === 'object' ? body.scope : {};
	const scope = Object.fromEntries(SCOPE_KEYS.map((key) => [key, scopeGiven[key] === true])) as UnattendedScope;
	return { goal, done, scope };
}

/** Check a form's fields; the task as it will be saved, or every field that is wrong. */
export function validateTask(input: unknown, home = homedir(), { paths = true } = {}): { task: AutomationTaskInput } | { errors: FieldErrors } {
	const body = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
	const errors: FieldErrors = {};

	const name = text(body.name);
	if (!name) errors.name = '請填名稱';
	else if (name.length > 80) errors.name = '名稱最多 80 個字';

	let schedule: AutomationSchedule = { type: 'daily' };
	const given = body.schedule ?? {};
	if (given.type === 'monthly') {
		const fromDay = integer(given.fromDay);
		const toDay = integer(given.toDay);
		if (!(fromDay >= 1 && fromDay <= 31) || !(toDay >= 1 && toDay <= 31)) errors.days = '日期要填 1 到 31';
		else if (fromDay > toDay) errors.days = '開始日不能晚於結束日';
		schedule = { type: 'monthly', fromDay, toDay };
	} else if (given.type === 'weekly') {
		const fromWeekday = integer(given.fromWeekday);
		const toWeekday = integer(given.toWeekday);
		if (!(fromWeekday >= 1 && fromWeekday <= 7) || !(toWeekday >= 1 && toWeekday <= 7)) errors.weekdays = '請選星期一到星期日';
		else if (fromWeekday > toWeekday) errors.weekdays = '一週從星期一算到星期日，開始的星期不能晚於結束的星期';
		schedule = { type: 'weekly', fromWeekday: fromWeekday as Weekday, toWeekday: toWeekday as Weekday };
	} else if (given.type !== 'daily') errors.schedule = '請選每月、每週或每天';

	const time = /^(\d{1,2}):(\d{2})$/.exec(text(body.time));
	const timeText = time ? `${time[1].padStart(2, '0')}:${time[2]}` : '';
	if (!time || Number(time[1]) > 23 || Number(time[2]) > 59) errors.time = '時間請寫成 00:00 到 23:59，例如 09:30';

	const limitMinutes = integer(body.limitMinutes);
	if (!(limitMinutes >= 1 && limitMinutes <= 1440)) errors.limitMinutes = '上限請填 1 到 1440 分鐘';

	const folderOf = (value: unknown, key: string) => {
		const folder = text(value);
		const full = expandHome(folder, home);
		if (!folder) errors[key] = '請填工作資料夾';
		else if (!isAbsolute(full)) errors[key] = '請填完整路徑，以 / 或 ~ 開頭';
		else if (paths && !isDirectory(full)) errors[key] = `找不到這個資料夾：${folder}`;
		return { folder, full };
	};

	let command: CommandSpec | undefined;
	let agent: AgentSpec | undefined;
	if (body.kind === 'command') {
		const given = body.command ?? {};
		const line = text(given.command);
		if (!line) errors.command = '請填要跑的指令';
		const { folder } = folderOf(given.folder, 'folder');
		const checks: FixedCheck[] = [];
		for (const check of Array.isArray(given.checks) ? given.checks : []) {
			if (check?.type === 'file' && text(check.path)) checks.push({ type: 'file', path: text(check.path) });
			else if (check?.type === 'output' && text(check.text)) checks.push({ type: 'output', text: text(check.text) });
			else errors.checks = '固定檢查要填檔案路徑或要找的字';
		}
		command = { command: line, folder, checks };
	} else if (body.kind === 'agent') {
		const given = body.agent ?? {};
		const client = given.client;
		if (client !== 'claude' && client !== 'codex') errors.client = '請選 Claude 或 Codex';
		const model = text(given.model);
		if (!model) errors.model = '請填模型';
		const effort = given.effort;
		if (!AGENT_EFFORTS.includes(effort)) errors.effort = '請選強度';
		const { folder, full } = folderOf(given.folder, 'folder');
		const brief = text(given.brief);
		if (!brief) errors.brief = '請填任務說明檔';
		else if (paths && !errors.folder && !isFile(resolve(full, expandHome(brief, home)))) errors.brief = `資料夾裡找不到這個檔案：${brief}`;
		const unattended = taskUnattended(given.unattended, errors);
		agent = { client, model, effort, folder, brief, ...(unattended ? { unattended } : {}) };
	} else errors.kind = '請選這個任務是指令還是 Agent';

	const reviewGiven = body.review ?? {};
	const checklist = (Array.isArray(reviewGiven.checklist) ? reviewGiven.checklist : String(reviewGiven.checklist ?? '').split('\n'))
		.map(text)
		.filter(Boolean);
	// The checker's settings are checked only while it is on; off, anything unusable falls back to the defaults.
	const enabled = reviewGiven.enabled === true;
	const fallbackClient = defaultReviewClient(body.kind, agent?.client);
	const givenClient = reviewGiven.client ?? fallbackClient;
	const clientOk = givenClient === 'claude' || givenClient === 'codex';
	if (enabled && !clientOk) errors.reviewClient = '請選檢查用 Claude 或 Codex';
	const reviewClient: AgentSpec['client'] = clientOk ? givenClient : fallbackClient;
	let reviewModel = reviewGiven.model === undefined ? DEFAULT_REVIEW_MODEL[reviewClient] : text(reviewGiven.model);
	if (!reviewModel) {
		if (enabled) errors.reviewModel = '請填檢查用的模型';
		else reviewModel = DEFAULT_REVIEW_MODEL[reviewClient];
	}
	let reviewEffort = reviewGiven.effort ?? 'medium';
	if (!AGENT_EFFORTS.includes(reviewEffort)) {
		if (enabled) errors.reviewEffort = '請選檢查的強度';
		else reviewEffort = 'medium';
	}
	const review = { enabled, checklist, client: reviewClient, model: reviewModel, effort: reviewEffort };
	if (review.enabled && checklist.length === 0) errors.checklist = '請 Agent 檢查時，驗收清單至少寫一條';

	if (Object.keys(errors).length) return { errors };
	return {
		task: { name, schedule, time: timeText, limitMinutes, kind: body.kind, ...(command ? { command } : { agent }), review }
	};
}

/** A task file as read back: every field as a saved task has it, or why it cannot be used. Folders
 *  and briefs that went missing since are not checked here: that is the run's settings error. */
function parseTask(raw: string, file: string, home: string): AutomationTask | string {
	let value: any;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		return `不是完整的 JSON：${(error as Error).message}`;
	}
	if (!value || typeof value !== 'object') return '內容不是一個任務';
	if (value.id !== file.replace(/\.json$/, '')) return '檔名和裡面的任務編號不一致';
	for (const key of ['createdAt', 'updatedAt']) if (typeof value[key] !== 'string') return `少了 ${key}`;
	const checked = validateTask(value, home, { paths: false });
	if ('errors' in checked) return `欄位不對：${Object.keys(checked.errors).join('、')}`;
	return { ...checked.task, id: value.id, paused: value.paused === true, createdAt: value.createdAt, updatedAt: value.updatedAt };
}

/** The runs as the record says now: the lines of a run merged in order. A line that cannot be read
 *  (the end of one cut off by a crash) is left out. */
export function readRuns(file: string): AutomationRun[] {
	let raw: string;
	try {
		raw = readFileSync(file, 'utf8');
	} catch {
		return [];
	}
	const runs = new Map<string, AutomationRun>();
	for (const line of raw.split('\n')) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as AutomationRun;
			if (typeof entry.id !== 'string') continue;
			runs.set(entry.id, { ...runs.get(entry.id), ...entry });
		} catch {
			// A torn line.
		}
	}
	return [...runs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/** A command's output as it comes: its end kept for saving, and whether each text the checks look for
 *  appeared anywhere in it, however long it grew. Bytes are decoded per stream, so a character split
 *  between two chunks is whole. */
export function outputCollector(sought: readonly string[]) {
	const overlap = Math.max(0, ...sought.map((text) => text.length - 1));
	const found = new Set<string>();
	let kept = '';
	let dropped = 0;
	let tail = '';
	const take = (text: string) => {
		if (!text) return;
		const window = tail + text;
		for (const wanted of sought) if (!found.has(wanted) && window.includes(wanted)) found.add(wanted);
		tail = overlap ? window.slice(-overlap) : '';
		kept += text;
		if (kept.length > OUTPUT_KEEP_CHARS * 2) {
			dropped += kept.length - OUTPUT_KEEP_CHARS;
			kept = kept.slice(kept.length - OUTPUT_KEEP_CHARS);
		}
	};
	const decoders = new Map<string, StringDecoder>();
	return {
		add(stream: string, chunk: Buffer) {
			if (!decoders.has(stream)) decoders.set(stream, new StringDecoder('utf8'));
			take(decoders.get(stream)!.write(chunk));
		},
		/** The end of the output, saying how much was left out before it. */
		end(extra = ''): { text: string; truncated: boolean; has: (text: string) => boolean } {
			for (const decoder of decoders.values()) take(decoder.end());
			take(extra);
			const over = kept.length - OUTPUT_KEEP_CHARS;
			const lost = dropped + Math.max(0, over);
			const text = over > 0 ? kept.slice(over) : kept;
			return { text: lost ? `（前面省略 ${lost} 字）\n${text}` : text, truncated: lost > 0, has: (wanted) => found.has(wanted) };
		}
	};
}

/** A task's missed periods as their record says now, merged by period; torn lines left out. */
export function readMissed(file: string): MissedPeriod[] {
	let raw: string;
	try {
		raw = readFileSync(file, 'utf8');
	} catch {
		return [];
	}
	const found = new Map<string, MissedPeriod>();
	for (const line of raw.split('\n')) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as MissedPeriod;
			if (typeof entry.period === 'string') found.set(entry.period, { ...found.get(entry.period), ...entry });
		} catch {
			// A torn line.
		}
	}
	return [...found.values()].sort((a, b) => a.from - b.from);
}

/** Whether the file's last line has no line end: what a crash in the middle of an append leaves. */
function endsTorn(file: string): boolean {
	let fd: number;
	try {
		fd = openSync(file, 'r');
	} catch {
		return false;
	}
	try {
		const size = fstatSync(fd).size;
		if (size === 0) return false;
		const last = Buffer.alloc(1);
		readSync(fd, last, 0, 1, size - 1);
		return last[0] !== 0x0a;
	} finally {
		closeSync(fd);
	}
}

/** Run the fixed checks on how a command ended; `printed` says whether the output held a text. */
export function runChecks(checks: readonly FixedCheck[], folder: string, printed: (text: string) => boolean): CheckResult[] {
	return checks.map((check) => {
		if (check.type === 'file') {
			const ok = existsSync(resolve(folder, check.path));
			return { label: `檔案存在：${check.path}`, ok, ...(ok ? {} : { detail: '找不到這個檔案' }) };
		}
		const ok = printed(check.text);
		return { label: `輸出含「${check.text}」`, ok, ...(ok ? {} : { detail: '輸出裡沒有這段字' }) };
	});
}

export function createAutomation(options: {
	/** The board state directory's `automation` folder. */
	dir: string;
	now(): number;
	home?: string;
	/** How often the scheduler checks; a minute unless a test wants it faster. */
	tickMs?: number;
	/** Every change, and every turn of a state as time passes, goes to the open pages. */
	publish(snapshot: AutomationSnapshot): void;
	/** Runs that ended and periods found missed, for red cards and pushes. */
	notify?(event: AutomationEvent): void;
	/** How agent tasks' runs open, watch and close their agents; without it agent tasks do not run. */
	agents?: AgentHost;
	/** The board state folder, whose action log (`sent-log.jsonl`) gets each save of a task and
	 *  each run of an unattended one; the folder above `dir` unless given. */
	stateDir?: string;
	/** The LAT skill folder an unattended task's controller runs `lat-unattended.py` from. */
	latDir?: string;
}): Automation {
	const { dir, now } = options;
	const stateDir = options.stateDir ?? dirname(dir);
	const home = options.home ?? homedir();
	const runsDir = join(dir, 'runs');
	const outputDir = join(dir, 'output');
	const missedDir = join(dir, 'missed');
	/** When the scheduler last checked: periods that ended after it and by now are looked at for missed. */
	const checkedFile = join(dir, 'checked-at.txt');
	for (const folder of [runsDir, outputDir, missedDir]) mkdirSync(folder, { recursive: true, mode: 0o700 });

	const tasks = new Map<string, AutomationTask>();
	let broken: BrokenTask[] = [];
	const runs = new Map<string, AutomationRun[]>();
	const missed = new Map<string, MissedPeriod[]>();
	/** Runs whose answer the board is sending now: what their agent's conversation shows meanwhile is
	 *  that answer, not one typed in its terminal. */
	const replying = new Set<string>();
	/** How to stop each run going now, by run: past the limit (the scheduler) or on 停止這次. */
	const stoppers = new Map<string, (why: Cut) => void>();
	/** Children running now, by task. */
	const children = new Map<string, Promise<void>>();
	/** Their process groups: a command ends with the board, as the spec has it. */
	const groups = new Set<number>();
	const endGroups = () => {
		for (const pid of groups) {
			try {
				process.kill(-pid, 'SIGTERM');
			} catch {
				// Already gone.
			}
		}
	};
	process.once('exit', endGroups);
	let revision = Date.now();
	let closed = false;
	let lastSent = '';

	const runsFile = (taskId: string) => join(runsDir, `${taskId}.jsonl`);
	const missedFile = (taskId: string) => join(missedDir, `${taskId}.jsonl`);
	const taskFile = (taskId: string) => join(dir, `${taskId}.json`);

	function load(): void {
		broken = [];
		for (const file of readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
			let raw: string;
			try {
				raw = readFileSync(join(dir, file), 'utf8');
			} catch (error) {
				broken.push({ file, error: (error as Error).message });
				continue;
			}
			const task = parseTask(raw, file, home);
			if (typeof task === 'string') broken.push({ file, error: task });
			else {
				tasks.set(task.id, task);
				runs.set(task.id, readRuns(runsFile(task.id)));
				missed.set(task.id, readMissed(missedFile(task.id)));
			}
		}
	}

	function record(run: AutomationRun, fields: Partial<AutomationRun> = run): AutomationRun {
		const file = runsFile(run.taskId);
		// A line cut off by a crash is left alone: the new one starts on a line of its own.
		appendFileSync(file, (endsTorn(file) ? '\n' : '') + JSON.stringify({ id: run.id, ...fields }) + '\n', { mode: 0o600 });
		const list = runs.get(run.taskId) ?? [];
		const index = list.findIndex((entry) => entry.id === run.id);
		const merged = { ...(index >= 0 ? list[index] : run), ...fields } as AutomationRun;
		if (index >= 0) list[index] = merged;
		else list.unshift(merged);
		list.sort((a, b) => b.startedAt - a.startedAt);
		runs.set(run.taskId, list);
		return merged;
	}

	/** A missed period's line: a line per change, merged by period, as the run records are. */
	function recordMissed(taskId: string, entry: MissedPeriod): void {
		const file = missedFile(taskId);
		appendFileSync(file, (endsTorn(file) ? '\n' : '') + JSON.stringify(entry) + '\n', { mode: 0o600 });
		const list = (missed.get(taskId) ?? []).filter((other) => other.period !== entry.period);
		missed.set(taskId, [...list, entry].sort((a, b) => a.from - b.from));
	}

	function snapshot(): AutomationSnapshot {
		const at = now();
		return {
			revision,
			timeZone: TIME_ZONE,
			tasks: [...tasks.values()]
				.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
				.map((task) => {
					const own = runs.get(task.id) ?? [];
					const recorded = missed.get(task.id) ?? [];
					return { task, state: taskState(task, own, at, recorded), nextAt: nextAutoAt(task, own, at), runs: own.slice(0, RUNS_SHOWN), missed: openMissed(recorded, own) };
				}),
			broken
		};
	}

	/** Tell the pages; with `changed` false only when what they show would differ. */
	function publish(changed = true): void {
		if (closed) return;
		if (changed) revision++;
		const next = snapshot();
		const shown = JSON.stringify({ ...next, revision: 0 });
		if (!changed && shown === lastSent) return;
		if (!changed) next.revision = ++revision;
		lastSent = shown;
		options.publish(next);
	}

	// A run the record says is running belongs to a board process that has ended: a command's
	// process ended with it.
	load();
	/** Agent runs the board was watching when it stopped: watched on once everything is set up. */
	const adopted: [AutomationTask, AutomationRun][] = [];
	/** Checking agents the board was watching when it stopped: watched on the same way. */
	const adoptedReviews: [AutomationTask, AutomationRun][] = [];
	for (const [taskId, list] of runs) {
		const task = tasks.get(taskId);
		for (const run of list) {
			if (run.review?.status === 'checking' && task) {
				if (options.agents) adoptedReviews.push([task, run]);
				else {
					const cut = record(run, { review: { ...run.review, status: 'error', endedAt: now(), reason: '看板重啟中斷' } });
					options.notify?.({ type: 'run-ended', task, run: cut });
				}
				continue;
			}
			if (run.status !== 'running' || !task) continue;
			if (task.kind === 'agent' && options.agents && task.agent) {
				adopted.push([task, run]);
				continue;
			}
			const cut = record(run, { endedAt: now(), status: 'failed', reason: '看板重啟中斷' });
			options.notify?.({ type: 'run-ended', task, run: cut });
		}
	}
	lastSent = JSON.stringify({ ...snapshot(), revision: 0 });

	/** A task's unattended grant as its saves and runs log it: the form's fields and the hours. */
	const grantOf = (task: AutomationTask) => (task.agent?.unattended ? { ...task.agent.unattended, maxHours: grantHours(task.limitMinutes) } : null);

	/** Log a save sent by a signed-in device before it is written: what an unattended run's grant
	 *  is checked against. Nothing is saved when the log cannot be written. */
	function logSave(task: AutomationTask, by: SavedBy | undefined): Saved | null {
		if (!by) return null;
		try {
			appendSent(stateDir, { kind: 'automation-task-save', id: randomUUID(), time: new Date(now()).toISOString(), taskId: task.id, taskName: task.name, deviceId: by.deviceId, unattended: grantOf(task) });
			return null;
		} catch (error) {
			return { ok: false, status: 500, errors: { task: `操作紀錄寫不進去，沒有儲存：${(error as Error).message}` } };
		}
	}

	/** The save an unattended run's grant comes from: the latest one of the task, by a signed-in
	 *  device that is no test login, holding the grant the task has now; or why there is none. */
	function grantSave(task: AutomationTask): AutomationTaskSave | string {
		const saved = readLines(stateDir, now()).findLast((line): line is AutomationTaskSave => line.kind === 'automation-task-save' && line.taskId === task.id);
		const again = '請在看板打開這個任務重新儲存';
		if (!saved || 'testDevice' in saved) return `無人模式的設定沒有在看板儲存的紀錄，${again}`;
		if (JSON.stringify(saved.unattended) !== JSON.stringify(grantOf(task))) return `任務檔的無人模式設定和最後一次在看板儲存的不同，${again}`;
		return saved;
	}

	function save(task: AutomationTask): void {
		writeAtomic(taskFile(task.id), JSON.stringify(task, null, '\t') + '\n');
		tasks.set(task.id, task);
		if (!runs.has(task.id)) runs.set(task.id, []);
	}

	function execute(task: AutomationTask, run: AutomationRun, spec: CommandSpec): Promise<void> {
		const folder = expandHome(spec.folder, home);
		const outputName = join('output', task.id, `${run.id}.txt`);
		mkdirSync(join(outputDir, task.id), { recursive: true, mode: 0o700 });
		return new Promise<void>((done) => {
			const output = outputCollector(spec.checks.flatMap((check) => (check.type === 'output' ? [check.text] : [])));
			let cut: Cut | null = null;
			const child = spawn('bash', ['-c', spec.command], { cwd: folder, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
			child.stdout.on('data', (chunk: Buffer) => output.add('stdout', chunk));
			child.stderr.on('data', (chunk: Buffer) => output.add('stderr', chunk));
			const signal = (name: NodeJS.Signals) => {
				try {
					process.kill(-child.pid!, name);
				} catch {
					// Already gone.
				}
			};
			// Past the limit, counted from the run's start by the scheduler's clock.
			stoppers.set(run.id, (why) => {
				stoppers.delete(run.id);
				cut = why;
				signal('SIGTERM');
				setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS).unref?.();
			});
			let ended = false;
			const end = (code: number | null, error?: Error) => {
				if (ended) return;
				ended = true;
				stoppers.delete(run.id);
				const kept = output.end(error ? `\n${error.message}` : '');
				try {
					writeAtomic(join(dir, outputName), kept.text);
				} catch {
					// The record still says how it ended.
				}
				const checks = runChecks(spec.checks, folder, kept.has);
				const status = cut ?? (code === 0 && checks.every((check) => check.ok) && !error ? 'success' : 'failed');
				const finished = record(run, {
					endedAt: now(),
					status,
					exitCode: code,
					checks,
					output: outputName,
					outputTruncated: kept.truncated,
					...(cut ? { reason: cutReason(cut, task.limitMinutes) } : error ? { reason: `指令沒有啟動：${error.message}` } : {}),
					...reviewStart(task, status)
				});
				publish();
				options.notify?.({ type: 'run-ended', task, run: finished });
				done();
			};
			child.on('error', (error) => end(null, error));
			// What the command left running in the background ends with the run, before the run counts as
			// over: nothing of it may outlive the limit or overlap the next run.
			const endLeftovers = async () => {
				try {
					process.kill(-child.pid!, 'SIGTERM');
				} catch {
					return;
				}
				// True once nothing in the group is left; a forced stop also takes a moment to land.
				const goneWithin = async (ms: number) => {
					const deadline = Date.now() + ms;
					while (Date.now() < deadline) {
						await new Promise((wait) => setTimeout(wait, 100));
						try {
							process.kill(-child.pid!, 0);
						} catch {
							return true;
						}
					}
					return false;
				};
				if (await goneWithin(KILL_GRACE_MS)) return;
				signal('SIGKILL');
				await goneWithin(KILL_GRACE_MS);
			};
			child.on('close', (code) => {
				// The command itself has ended: the limit no longer applies to the cleanup after it.
				stoppers.delete(run.id);
				void endLeftovers().then(() => {
					groups.delete(child.pid!);
					end(code);
				});
			});
			if (child.pid) {
				groups.add(child.pid);
				record(run, { pid: child.pid });
			}
		});
	}

	/** Which tasks the board can run: agent tasks need the agents' host. Tasks it cannot run are
	 *  neither started by the schedule nor counted as missed. */
	const runnable = (task: AutomationTask) => (task.kind === 'command' ? task.command !== undefined : task.agent !== undefined && options.agents !== undefined);
	const busy = (taskId: string) => children.has(taskId) || (runs.get(taskId) ?? []).some(isOpen);

	/** A run of the task beginning at `at`, in the period that time falls in. */
	const newRun = (task: AutomationTask, trigger: RunTrigger, at: number): AutomationRun => ({
		id: `${at.toString(36)}-${newId()}`,
		taskId: task.id,
		trigger,
		period: periodOf(task.schedule, at),
		startedAt: at,
		status: 'running'
	});

	/** Start a run now and record it; a folder or brief gone since saving is a settings error, not a crash. */
	function start(task: AutomationTask, trigger: RunTrigger): AutomationRun {
		const at = now();
		const base = newRun(task, trigger, at);
		const configError = (reason: string) => {
			const run = record(base, { ...base, endedAt: at, status: 'config-error', reason });
			options.notify?.({ type: 'run-ended', task, run });
			return run;
		};
		const folder = expandHome((task.command ?? task.agent)!.folder, home);
		if (!isDirectory(folder)) return configError(`找不到工作資料夾：${(task.command ?? task.agent)!.folder}`);
		let job: Promise<void>;
		let run: AutomationRun;
		if (task.command) {
			run = record(base);
			job = execute(task, run, task.command);
		} else {
			const brief = resolve(folder, expandHome(task.agent!.brief, home));
			if (!isFile(brief)) return configError(`資料夾裡找不到任務說明檔：${task.agent!.brief}`);
			run = record(base);
			job = runAgent(task, run, folder, brief);
		}
		children.set(task.id, job.then(() => review(task, run, false)).finally(() => children.delete(task.id)));
		return run;
	}

	/** The run as its record says now. */
	const latest = (run: AutomationRun) => (runs.get(run.taskId) ?? []).find((entry) => entry.id === run.id) ?? run;

	/** End an agent run: its record, the pages, red cards and pushes. */
	function finish(task: AutomationTask, run: AutomationRun, end: AgentEnd): void {
		const finished = record(run, { endedAt: now(), ...end, ...reviewStart(task, end.status) });
		publish();
		options.notify?.({ type: 'run-ended', task, run: finished });
	}

	/** Watch an agent run's agent to its end; a run the board took over when it started is `adopted`. */
	async function watch(task: AutomationTask, run: AutomationRun, adopted: boolean, cut: () => Cut | null): Promise<void> {
		const host = options.agents!;
		if (!run.agentName) {
			// The board stopped between the launch and its name: hcom's list knows the run's tag.
			const listed = await host.list();
			const found = listed.ok ? listed.agents.find((agent) => agent.tag === runTag(task.id, run.id)) : undefined;
			if (!found) return finish(task, run, { status: 'failed', reason: GONE_AT_RESTART });
			run = record(run, { agentName: found.name });
			publish();
		}
		const ended = await watchAgent(host, {
			get run() {
				return latest(run);
			},
			spec: task.agent!,
			limitMinutes: task.limitMinutes,
			now,
			cut,
			note: (fields) => {
				record(run, fields);
				publish();
			},
			closing: () => closed,
			adopted,
			// An unattended controller never asks: a turn waiting on its agents goes on.
			...(task.agent!.unattended
				? { goesOn: controllerGoesOn, ending: 'DONE 或 FAILED', resumeMessage: CONTROLLER_RESUME_MESSAGE }
				: { asking: {
				waiting: () => openAsk(latest(run)) !== undefined,
				replying: () => replying.has(run.id),
				asked: (question) => {
					const asks = [...(latest(run).asks ?? []), { question, askedAt: now() }];
					const asked = record(run, { asks });
					publish();
					options.notify?.({ type: 'asked', task, run: asked, index: asks.length - 1 });
				},
				resumed: (input) => void answer(task, run, input ?? '（在 Agent 的終端繼續，看板沒讀到回覆內容）', ASK_SOURCE.terminal)
			} })
		}).catch(async (error: Error): Promise<AgentEnd> => {
			// Whatever broke, the agent is not left running.
			const now = latest(run);
			const closeError = await host.close({ sessionId: now.sessionId ?? null, name: now.agentName! }).catch((failed: Error) => failed.message);
			return { status: 'failed', reason: `看板追蹤這個 Agent 時出錯：${error.message}`, ...(closeError ? { closeError } : {}) };
		});
		if (ended) finish(task, run, ended);
	}

	/** Keep the answer to the question the run waits on: it goes on, and its yellow card goes. */
	function answer(task: AutomationTask, run: AutomationRun, text: string, source: string): AutomationRun | null {
		const current = latest(run);
		if (!openAsk(current)) return null;
		const asks: RunAsk[] = [...current.asks!];
		asks[asks.length - 1] = { ...asks.at(-1)!, answer: text, answeredAt: now(), source };
		const answered = record(current, { asks });
		publish();
		options.notify?.({ type: 'answered', task, run: answered });
		return answered;
	}

	/** An agent run: the Codex account first, then the agent, watched to its end. */
	async function runAgent(task: AutomationTask, run: AutomationRun, folder: string, brief: string): Promise<void> {
		const host = options.agents!;
		const spec = task.agent!;
		let cut: Cut | null = null;
		stoppers.set(run.id, (why) => (cut ??= why));
		try {
			if (spec.client === 'codex') {
				// A check that broke confirms nothing: nothing is switched, as when it cannot be read.
				const ready = await codexBeforeLaunch(host.accounts, spec.model, spec.effort).catch((): { ok: true; account?: number; note?: string } => ({ ok: true }));
				if (!ready.ok) return finish(task, run, { status: 'quota', reason: ready.reason });
				record(run, { ...(ready.account !== undefined ? { codexAccount: ready.account } : {}), ...(ready.note ? { accountSwitches: [ready.note] } : {}) });
			}
			if (cut) return finish(task, run, { status: cut, reason: cutReason(cut, task.limitMinutes) });
			const tag = runTag(task.id, run.id);
			let prompt = firstMessage(brief);
			if (spec.unattended) {
				// The grant the controller turns on: logged before it opens, from the user's latest save.
				const saved = grantSave(task);
				if (typeof saved === 'string') return finish(task, run, { status: 'config-error', reason: saved });
				try {
					appendSent(stateDir, { kind: 'unattended-task-run', id: run.id, time: new Date(now()).toISOString(), taskId: task.id, taskName: task.name, tag, save: saved.id, ...saved.unattended! });
				} catch (error) {
					return finish(task, run, { status: 'failed', reason: `操作紀錄寫不進去，沒有開主控：${(error as Error).message}` });
				}
				prompt = controllerMessage(spec.client, { taskName: task.name, runId: run.id, stateDir, latDir: options.latDir ?? join(home, '.agents/skills/lat'), brief });
			}
			const launched = await host
				.launch({ ...spec, folder, prompt, tag })
				.catch((error: Error) => ({ ok: false as const, reason: error.message }));
			if (!launched.ok) return finish(task, run, { status: 'failed', reason: `開不了 Agent：${launched.reason}` });
			record(run, { agentName: launched.name, ...(launched.workspace ? { agentWorkspace: launched.workspace } : {}) });
			publish();
			await watch(task, latest(run), false, () => cut);
		} finally {
			stoppers.delete(run.id);
		}
	}

	/** A run that succeeded with 跑完後請 Agent 檢查 on goes on as checking, in the same record line as its end. */
	function reviewStart(task: AutomationTask, status: AutomationRun['status']): { review?: RunReview } {
		if (status !== 'success' || !task.review.enabled || !options.agents) return {};
		const { client, model, effort } = task.review;
		return { review: { status: 'checking', startedAt: now(), client, model, effort } };
	}

	/** The checking agent of a run that succeeded: its brief, the Codex account, the agent opened like
	 *  a task's own and watched to its verdict, then closed. With the limit, 停止這次, a restart and
	 *  the quota handled as a task's agent's are. A run with no check due is left alone. */
	async function review(task: AutomationTask, run: AutomationRun, adopted: boolean): Promise<void> {
		const host = options.agents;
		if (!host || latest(run).review?.status !== 'checking') return;
		const update = (fields: Partial<RunReview>) => {
			const current = latest(run);
			return record(current, { review: { ...current.review!, ...fields } });
		};
		const settle = (fields: Partial<RunReview>) => {
			const finished = update({ endedAt: now(), ...fields });
			publish();
			options.notify?.({ type: 'run-ended', task, run: finished });
		};
		const settleEnd = (end: AgentEnd) =>
			settle(
				end.judged
					? { status: end.judged.verdict, items: end.judged.items, ...(end.judged.reason ? { reason: end.judged.reason } : {}), ...(end.closeError ? { closeError: end.closeError } : {}) }
					: { status: 'error', reason: `檢查沒有做完：${end.reason ?? '原因不明'}`, ...(end.status === 'stopped' || end.status === 'timeout' || end.status === 'quota' ? { ended: end.status } : {}), ...(end.closeError ? { closeError: end.closeError } : {}) }
			);
		let cut: Cut | null = null;
		stoppers.set(run.id, (why) => (cut ??= why));
		const checker = latest(run).review!;
		const spec: AgentSpec = { client: checker.client, model: checker.model, effort: checker.effort, folder: (task.agent ?? task.command)!.folder, brief: '' };
		try {
			const folder = expandHome(spec.folder, home);
			if (!adopted) {
				if (!isDirectory(folder)) return settle({ status: 'error', reason: `檢查沒有做完：找不到工作資料夾 ${spec.folder}` });
				const current = latest(run);
				const briefName = join('review', task.id, `${run.id}.md`);
				const transcript = task.kind === 'agent' && current.sessionId ? await host.transcript(task.agent!.client, current.sessionId).catch(() => null) : undefined;
				mkdirSync(join(dir, 'review', task.id), { recursive: true, mode: 0o700 });
				const briefPath = join(dir, briefName);
				writeAtomic(
					briefPath,
					reviewBrief({
						task,
						run: current,
						folder,
						...(task.agent ? { taskBrief: resolve(folder, expandHome(task.agent.brief, home)) } : {}),
						...(current.output ? { output: join(dir, current.output) } : {}),
						transcript
					})
				);
				update({ brief: briefName });
				if (spec.client === 'codex') {
					const ready = await codexBeforeLaunch(host.accounts, spec.model, spec.effort).catch((): { ok: true; account?: number; note?: string } => ({ ok: true }));
					if (!ready.ok) return settle({ status: 'error', ended: 'quota', reason: `檢查沒有做完：${ready.reason}` });
					update({ ...(ready.account !== undefined ? { codexAccount: ready.account } : {}), ...(ready.note ? { accountSwitches: [ready.note] } : {}) });
				}
				if (cut) return settleEnd({ status: cut, reason: cutReason(cut, task.limitMinutes) });
				const launched = await host
					.launch({ ...spec, folder, brief: briefPath, prompt: reviewMessage(briefPath), tag: reviewTag(task.id, run.id) })
					.catch((error: Error) => ({ ok: false as const, reason: error.message }));
				if (!launched.ok) return settle({ status: 'error', reason: `檢查沒有做完：開不了檢查 Agent：${launched.reason}` });
				update({ agentName: launched.name, ...(launched.workspace ? { agentWorkspace: launched.workspace } : {}) });
				publish();
			} else if (!checker.agentName) {
				// The board stopped between the launch and its name: hcom's list knows the checker's tag.
				const listed = await host.list();
				const found = listed.ok ? listed.agents.find((agent) => agent.tag === reviewTag(task.id, run.id)) : undefined;
				if (!found) return settle({ status: 'error', reason: `檢查沒有做完：${GONE_AT_RESTART}` });
				update({ agentName: found.name });
				publish();
			}
			// The checker is watched as a run of its own: its start, agent and account are the review's.
			const view = (): AutomationRun => {
				const current = latest(run);
				const own = current.review!;
				return {
					...current,
					startedAt: own.startedAt,
					agentName: own.agentName,
					sessionId: own.sessionId,
					agentWorkspace: own.agentWorkspace,
					judgeAfter: own.judgeAfter,
					codexAccount: own.codexAccount,
					accountSwitches: own.accountSwitches
				};
			};
			const ended = await watchAgent(host, {
				get run() {
					return view();
				},
				spec,
				limitMinutes: task.limitMinutes,
				now,
				cut: () => cut,
				note: (fields) => {
					update(fields as Partial<RunReview>);
					publish();
				},
				closing: () => closed,
				adopted,
				judge: judgeReview(task.review.checklist),
				ending: 'PASS 或 FAIL',
				resumeMessage: REVIEW_RESUME_MESSAGE
			}).catch(async (error: Error): Promise<AgentEnd> => {
				const own = view();
				const closeError = await host.close({ sessionId: own.sessionId ?? null, name: own.agentName! }).catch((failed: Error) => failed.message);
				return { status: 'failed', reason: `看板追蹤檢查 Agent 時出錯：${error.message}`, ...(closeError ? { closeError } : {}) };
			});
			if (ended) settleEnd(ended);
		} finally {
			stoppers.delete(run.id);
		}
	}

	/** Watch on the agent runs the board was watching when it stopped. */
	function adopt(): void {
		for (const [task, run] of adopted) {
			let cut: Cut | null = null;
			stoppers.set(run.id, (why) => (cut ??= why));
			const job = watch(task, run, true, () => cut)
				.finally(() => stoppers.delete(run.id))
				.then(() => review(task, run, false));
			children.set(task.id, job.finally(() => children.delete(task.id)));
		}
		for (const [task, run] of adoptedReviews) children.set(task.id, review(task, run, true).finally(() => children.delete(task.id)));
	}

	function readChecked(): number | null {
		try {
			const time = Date.parse(readFileSync(checkedFile, 'utf8').trim());
			return Number.isNaN(time) ? null : time;
		} catch {
			return null;
		}
	}

	/** Record the periods of one task whose window ended after `after` and by `at` with no run at all. */
	function findMissed(task: AutomationTask, after: number, at: number): MissedPeriod[] {
		const own = runs.get(task.id) ?? [];
		const known = new Set((missed.get(task.id) ?? []).map((entry) => entry.period));
		const found: MissedPeriod[] = [];
		const created = Date.parse(task.createdAt) || after;
		for (const window of endedWindows(task.schedule, after, at)) {
			// A window the task was added part way through is not counted against it.
			if (known.has(window.period) || window.from < created) continue;
			// Any run of the period, whatever it ended in, means the board was there for it.
			if (own.some((run) => run.period === window.period && (run.trigger === 'auto' || run.trigger === 'manual' || succeeded(run)))) continue;
			const entry: MissedPeriod = { ...window, recordedAt: at };
			recordMissed(task.id, entry);
			found.push(entry);
		}
		return found;
	}

	/** One check: stop runs past their limit, record missed periods, start the tries that are due. On
	 *  the first check after the board started a try due today starts at once, not at the set time. */
	function check(first: boolean): void {
		if (closed) return;
		const at = now();
		let changed = false;
		for (const list of runs.values()) {
			for (const run of list) {
				const task = tasks.get(run.taskId);
				if (run.status === 'running' && task && at - run.startedAt >= task.limitMinutes * 60_000) stoppers.get(run.id)?.('timeout');
			}
		}
		const checked = readChecked();
		if (checked !== null && checked < at) {
			for (const task of tasks.values()) {
				if (task.paused || !runnable(task)) continue;
				const found = findMissed(task, checked, at);
				if (!found.length) continue;
				changed = true;
				options.notify?.({ type: 'missed', task, periods: found });
			}
		}
		// Follows the clock back too, so a later check never starts from a time that has not come.
		if (checked !== at) writeAtomic(checkedFile, new Date(at).toISOString() + '\n');
		for (const task of tasks.values()) {
			if (!runnable(task)) continue;
			const due = dueToday(task, runs.get(task.id) ?? [], at);
			if (due === null || (!first && at < due)) continue;
			changed = true;
			if (busy(task.id)) {
				record({ ...newRun(task, 'auto', at), endedAt: at, status: 'skipped', reason: (runs.get(task.id) ?? []).some((run) => openAsk(run)) ? '上一次還在等你回覆' : '上一次還在跑' });
			} else start(task, 'auto');
		}
		publish(changed);
	}

	const ticker = setInterval(() => check(false), options.tickMs ?? 60_000);
	ticker.unref?.();
	// Right after the board starts, once whatever builds on the automation has it: the runs it
	// watched first, so a try due now never starts beside one still running.
	const firstCheck = setImmediate(() => {
		adopt();
		check(true);
	});

	return {
		snapshot,
		create(input, by) {
			const checked = validateTask(input, home);
			if ('errors' in checked) return { ok: false, status: 400, errors: checked.errors };
			const at = new Date(now()).toISOString();
			let id = newId();
			while (tasks.has(id)) id = newId();
			const task: AutomationTask = { id, ...checked.task, paused: false, createdAt: at, updatedAt: at };
			const unlogged = logSave(task, by);
			if (unlogged) return unlogged;
			save(task);
			publish();
			return { ok: true, task };
		},
		update(id, input, by) {
			const before = tasks.get(id);
			if (!before) return { ok: false, status: 404, errors: { task: '這個任務已不存在' } };
			const checked = validateTask(input, home);
			if ('errors' in checked) return { ok: false, status: 400, errors: checked.errors };
			const task: AutomationTask = { id, ...checked.task, paused: before.paused, createdAt: before.createdAt, updatedAt: new Date(now()).toISOString() };
			const unlogged = logSave(task, by);
			if (unlogged) return unlogged;
			save(task);
			publish();
			return { ok: true, task };
		},
		setPaused(id, paused) {
			const before = tasks.get(id);
			if (!before) return null;
			const task = { ...before, paused, updatedAt: new Date(now()).toISOString() };
			save(task);
			publish();
			return task;
		},
		runNow(id) {
			const task = tasks.get(id);
			if (!task) return { ok: false, status: 404, message: '這個任務已不存在' };
			const running = (runs.get(id) ?? []).find(isOpen);
			if (running && openAsk(running)) return { ok: false, status: 409, message: '這個任務正在等你回覆，回覆或停止這次之後再執行' };
			if (running || children.has(id)) {
				const since = running ? new Date(running.startedAt).toLocaleTimeString('zh-TW', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false }) : '';
				return { ok: false, status: 409, message: `這個任務正在跑${since ? `（${since} 開始）` : ''}，等這次結束再執行` };
			}
			if (!runnable(task)) return { ok: false, status: 409, message: '這個任務的設定不完整，不能執行' };
			const run = start(task, 'manual');
			publish();
			return { ok: true, run: (runs.get(id) ?? []).find((entry) => entry.id === run.id) ?? run };
		},
		async reply(id, input) {
			const task = tasks.get(id);
			if (!task) return { ok: false, status: 404, message: '這個任務已不存在' };
			const answerText = typeof input === 'string' ? input.trim() : '';
			if (!answerText) return { ok: false, status: 400, message: '請先寫回覆內容' };
			const run = (runs.get(id) ?? []).find((candidate) => openAsk(candidate));
			if (!run) return { ok: false, status: 409, message: '這個任務現在沒有在等你回覆，可能已經接著做了' };
			if (!run.sessionId || !options.agents) return { ok: false, status: 409, message: '還不知道這個 Agent 的對話，沒有送出；請打開 Agent 看即時畫面直接回覆' };
			if (replying.has(run.id)) return { ok: false, status: 409, message: '上一個回覆還在送，請稍等' };
			replying.add(run.id);
			try {
				const failed = await options.agents.send(run.sessionId, answerText).catch((error: Error) => error.message);
				if (failed) return { ok: false, status: 502, message: `回覆沒有送到 Agent：${failed}` };
				const answered = answer(task, run, answerText, ASK_SOURCE.board);
				// The run ended (past its limit, 停止這次) while the answer was on its way: nobody reads it.
				if (!answered) return { ok: false, status: 409, message: '送出時這次執行已經結束，回覆沒有記下' };
				return { ok: true, run: answered };
			} finally {
				replying.delete(run.id);
			}
		},
		stop(id) {
			if (!tasks.has(id)) return null;
			const running = (runs.get(id) ?? []).find(isOpen);
			const stopper = running && stoppers.get(running.id);
			if (!stopper) return false;
			stopper('stopped');
			return true;
		},
		carry(id, marker) {
			const task = tasks.get(id);
			if (!task) return { ok: false, status: 404, message: '這個任務已不存在' };
			const path = text(marker);
			if (!path) return { ok: false, status: 400, message: '請寫出原本的完成標記路徑（marker）' };
			const at = now();
			const run = record({ ...newRun(task, 'carried', at), endedAt: at, status: 'success', marker: path, reason: `沿用原紀錄：${path}` });
			publish();
			return { ok: true, run };
		},
		remove(id) {
			if (!tasks.has(id)) return { ok: false, status: 404, message: '這個任務已不存在' };
			if (busy(id)) return { ok: false, status: 409, message: '這個任務還有一次沒跑完，等它結束或按停止這次之後再刪除' };
			// The task file first: should the rest fail, what is left is never read as a task.
			rmSync(taskFile(id), { force: true });
			tasks.delete(id);
			runs.delete(id);
			missed.delete(id);
			try {
				for (const path of [runsFile(id), missedFile(id), join(outputDir, id), join(dir, 'review', id)]) rmSync(path, { recursive: true, force: true });
			} finally {
				// The pages hear the task is gone even when a record of it could not be removed.
				publish();
			}
			return { ok: true };
		},
		dismissMissed(id) {
			if (!tasks.has(id)) return null;
			const open = openMissed(missed.get(id) ?? [], runs.get(id) ?? []);
			const at = now();
			for (const entry of open) recordMissed(id, { ...entry, dismissedAt: at });
			if (open.length) publish();
			return open.length;
		},
		output(taskId, runId) {
			if (!ID.test(taskId)) return null;
			const run = (runs.get(taskId) ?? []).find((entry) => entry.id === runId);
			if (!run?.output) return null;
			try {
				return readFileSync(join(dir, run.output), 'utf8');
			} catch {
				return null;
			}
		},
		idle: async () => {
			while (children.size) await Promise.all(children.values());
		},
		close() {
			closed = true;
			clearInterval(ticker);
			clearImmediate(firstCheck);
			process.off('exit', endGroups);
			endGroups();
		}
	};
}
