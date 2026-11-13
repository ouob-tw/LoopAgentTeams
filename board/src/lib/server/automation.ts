// The 自動化 tab's tasks on the server: one JSON file per task in the board state directory's
// `automation` folder, written whole and atomically; one record file per task that only ever grows
// (a line when a run starts and one when it ends); the output a command printed, cut to its end.
// A command task's 立即執行 runs here as a child process in the task's folder. The scheduler and agent
// runs build on `startRun`/`finishRun` and the records' fields.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
	AGENT_EFFORTS,
	DEFAULT_REVIEW_MODEL,
	defaultReviewClient,
	nextAutoAt,
	periodOf,
	taskState,
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
	type RunTrigger,
	type Weekday
} from '../board/automation.ts';

/** How much of a command's output is kept: its last part, which says how it ended. */
export const OUTPUT_KEEP_CHARS = 32_000;
/** How many runs each task sends to the pages, newest first. */
const RUNS_SHOWN = 20;
/** A command's process group gets this long to end after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 5_000;
/** How often the states and next times are worked out again, as days and periods turn. */
const TICK_MS = 60_000;

/** Field name → what is wrong with it, worded for the form. */
export type FieldErrors = Record<string, string>;

export type Saved = { ok: true; task: AutomationTask } | { ok: false; status: number; errors: FieldErrors };
export type Started = { ok: true; run: AutomationRun } | { ok: false; status: number; message: string };

export interface Automation {
	snapshot(): AutomationSnapshot;
	create(input: unknown): Saved;
	update(id: string, input: unknown): Saved;
	setPaused(id: string, paused: boolean): AutomationTask | null;
	/** 立即執行: refused while the same task runs. Resolves once the run has started, not ended. */
	runNow(id: string): Started;
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
		agent = { client, model, effort, folder, brief };
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
	/** Every change, and every turn of a state as time passes, goes to the open pages. */
	publish(snapshot: AutomationSnapshot): void;
}): Automation {
	const { dir, now } = options;
	const home = options.home ?? homedir();
	const runsDir = join(dir, 'runs');
	const outputDir = join(dir, 'output');
	mkdirSync(runsDir, { recursive: true, mode: 0o700 });
	mkdirSync(outputDir, { recursive: true, mode: 0o700 });

	const tasks = new Map<string, AutomationTask>();
	let broken: BrokenTask[] = [];
	const runs = new Map<string, AutomationRun[]>();
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

	function snapshot(): AutomationSnapshot {
		const at = now();
		return {
			revision,
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			tasks: [...tasks.values()]
				.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
				.map((task) => {
					const own = runs.get(task.id) ?? [];
					return { task, state: taskState(task, own, at), nextAt: nextAutoAt(task, own, at), runs: own.slice(0, RUNS_SHOWN) };
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
	for (const [taskId, list] of runs) {
		const task = tasks.get(taskId);
		for (const run of list) {
			if (run.status === 'running' && task?.kind === 'command') record(run, { endedAt: now(), status: 'failed', reason: '看板重啟中斷' });
		}
	}
	lastSent = JSON.stringify({ ...snapshot(), revision: 0 });
	const ticker = setInterval(() => publish(false), TICK_MS);
	ticker.unref?.();

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
			let timedOut = false;
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
			const limit = setTimeout(() => {
				timedOut = true;
				signal('SIGTERM');
				setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS).unref?.();
			}, task.limitMinutes * 60_000);
			let ended = false;
			const end = (code: number | null, error?: Error) => {
				if (ended) return;
				ended = true;
				clearTimeout(limit);
				const kept = output.end(error ? `\n${error.message}` : '');
				try {
					writeAtomic(join(dir, outputName), kept.text);
				} catch {
					// The record still says how it ended.
				}
				const checks = runChecks(spec.checks, folder, kept.has);
				const status = timedOut ? 'timeout' : code === 0 && checks.every((check) => check.ok) && !error ? 'success' : 'failed';
				record(run, {
					endedAt: now(),
					status,
					exitCode: code,
					checks,
					output: outputName,
					outputTruncated: kept.truncated,
					...(timedOut ? { reason: `超過上限 ${task.limitMinutes} 分鐘，已停止` } : error ? { reason: `指令沒有啟動：${error.message}` } : {})
				});
				publish();
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
				clearTimeout(limit);
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

	return {
		snapshot,
		create(input) {
			const checked = validateTask(input, home);
			if ('errors' in checked) return { ok: false, status: 400, errors: checked.errors };
			const at = new Date(now()).toISOString();
			let id = newId();
			while (tasks.has(id)) id = newId();
			const task: AutomationTask = { id, ...checked.task, paused: false, createdAt: at, updatedAt: at };
			save(task);
			publish();
			return { ok: true, task };
		},
		update(id, input) {
			const before = tasks.get(id);
			if (!before) return { ok: false, status: 404, errors: { task: '這個任務已不存在' } };
			const checked = validateTask(input, home);
			if ('errors' in checked) return { ok: false, status: 400, errors: checked.errors };
			const task: AutomationTask = { id, ...checked.task, paused: before.paused, createdAt: before.createdAt, updatedAt: new Date(now()).toISOString() };
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
			const running = (runs.get(id) ?? []).find((run) => run.status === 'running');
			if (running || children.has(id)) {
				const since = running ? new Date(running.startedAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
				return { ok: false, status: 409, message: `這個任務正在跑${since ? `（${since} 開始）` : ''}，等這次結束再執行` };
			}
			if (task.kind !== 'command' || !task.command) return { ok: false, status: 409, message: 'Agent 任務還不能從看板執行' };
			const at = now();
			const base: AutomationRun = { id: `${at.toString(36)}-${newId()}`, taskId: id, trigger: 'manual' satisfies RunTrigger, period: periodOf(task.schedule, at), startedAt: at, status: 'running' };
			const folder = expandHome(task.command.folder, home);
			if (!isDirectory(folder)) {
				const run = record(base, { ...base, endedAt: at, status: 'config-error', reason: `找不到工作資料夾：${task.command.folder}` });
				publish();
				return { ok: true, run };
			}
			const run = record(base);
			const spec = task.command;
			const child = execute(task, run, spec).finally(() => children.delete(id));
			children.set(id, child);
			publish();
			return { ok: true, run: (runs.get(id) ?? []).find((entry) => entry.id === run.id) ?? run };
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
			process.off('exit', endGroups);
			endGroups();
		}
	};
}
