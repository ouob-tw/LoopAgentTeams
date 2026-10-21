// The board's sent log: one JSON line per attempt to send a message to a controller, per
// answer the helper accepted, per attempt to start a new controller, per attempt to wake one and
// per action on an agent of the 所有 Agent tab, kept in the board's state directory so every logged-in device sees the same history. Lines are only appended; what became
// of an answer, a launch or a resume is a later line of its own.
//
// The board is the only writer, so the parsed lines are kept per state directory and read again only
// when the file's size or time is not what the board left it at. Lines older than 30 days are
// dropped by the group they belong to, like the reports.
//
// What the lines come to is worked out in `sent-views.ts`; how each feature settles its own
// entries against the clients running now is in that feature's module.
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAction } from '../board/agent-actions.ts';
import type { AnswerState, SentAnswer } from '../board/answers.ts';
import type { LaunchFollow, SentLaunch } from '../board/launch.ts';
import type { SentMessage } from '../board/messages.ts';
import type { ModelChoice, SentSwitch, SwitchState } from '../board/models.ts';
import type { ResumeClose, SentWake } from '../board/wake.ts';

const SENT_LOG_FILE = 'sent-log.jsonl';

/** An answer as its line holds it: where it stands is not part of the line. */
export type StoredAnswer = Omit<SentAnswer, 'state' | 'settledAt'> & {
	/** The controller's question file, kept for when the controller has ended. Never sent to a page. */
	questionsPath?: string;
};

/** What became of the answer with this ID; the latest line for an answer is the one that counts. */
export interface AnswerMark {
	kind: 'answer-state';
	answerId: string;
	state: AnswerState;
	time: string;
}

/** The controller a launch became: a binding with the launch's HCOM name appeared. Written once. */
interface LaunchMark {
	kind: 'launch-bound';
	launchId: string;
	controllerId: string;
	time: string;
}

/** How a plain agent's launch was followed through: written once, when it appeared in Herdr and
 *  its tab was renamed and moved, or when the wait ran out. */
export interface LaunchFollowed extends LaunchFollow {
	kind: 'launch-followed';
	launchId: string;
	time: string;
}

/** How an open resume attempt was closed. Written once. */
export interface ResumeMark {
	kind: 'resume-closed';
	wakeId: string;
	result: ResumeClose;
	/** Why it `failed`. */
	reason?: string;
	time: string;
}

/** How the hcom resume of an attempt ended. The attempt is logged before hcom runs, as `pending`,
 *  so a board that stops meanwhile, or this line failing to be written, leaves it open. */
export interface ResumeResult {
	kind: 'resume-result';
	wakeId: string;
	outcome: 'started' | 'pending' | 'failed';
	error: string | null;
	resumedName: string | null;
	pane: string | null;
	time: string;
}

/** The Herdr pane a resume attempt runs in, learned after the attempt was logged. */
export interface ResumePane {
	kind: 'resume-pane';
	wakeId: string;
	pane: string;
	time: string;
}

/** A later step of a Codex model switch: where its stop got to, that it is over (`done`, when its
 *  session is found running again outside its own resume; `abandoned`, given up by the user), or
 *  new settings the user chose when continuing it. */
export interface SwitchStep {
	kind: 'switch-step';
	switchId: string;
	state?: SwitchState;
	error?: string | null;
	to?: ModelChoice;
	/** The pane of a later stop, which replaces the one the switch was logged with. */
	pane?: string | null;
	/** The effort carried, resolved again with new settings or a later stop. */
	carriedEffort?: string | null;
	/** The HCOM name of the client a relaunch started; empty when a relaunch's hcom run begins. */
	relaunchedName?: string;
	time: string;
}

export type Line =
	| SentMessage
	| StoredAnswer
	| AnswerMark
	| SentLaunch
	| LaunchMark
	| LaunchFollowed
	| SentWake
	| ResumeMark
	| ResumeResult
	| ResumePane
	| SentSwitch
	| SwitchStep
	| AgentAction;

/** How long a group of lines is kept after its latest line, as the reports are. */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** How long after a cleaning the next read cleans again. */
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;

interface Row {
	raw: string;
	/** Null for a line that cannot be read: kept in the file, left out of what is read. */
	line: Line | null;
}

interface Cached {
	rows: Row[];
	lines: readonly Line[];
	size: number;
	mtimeMs: number;
	/** The text ends with a whole line, so a line appended stands on its own. */
	whole: boolean;
}

const cache = new Map<string, Cached>();
/** When each state directory's log was last cleaned, by the board's clock. */
const prunedAt = new Map<string, number>();

/** The reads of the board under way, by state directory (`openLog`): each is handed every line
 *  the board appends while it lasts, or null when the file may now hold anything else. */
const live = new Map<string, Set<(line: Line | null) => void>>();

const tell = (stateDir: string, line: Line | null) => {
	for (const add of live.get(stateDir) ?? []) add(line);
};

/** How many times the whole file was read and parsed; tests count the reads with it. */
export const sentLogReads = { count: 0 };

function deepFreeze<T>(value: T): T {
	if (value && typeof value === 'object') {
		for (const inner of Object.values(value)) deepFreeze(inner);
		Object.freeze(value);
	}
	return value;
}

function parse(raw: string): Line | null {
	try {
		const line = JSON.parse(raw);
		return line && typeof line === 'object' ? deepFreeze(line) : null;
	} catch {
		// One cut short by a failed write.
		return null;
	}
}

/** Stat the file; null when there is none yet. */
function stamp(path: string) {
	try {
		return statSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

const unchanged = (cached: Cached | undefined, info: { size: number; mtimeMs: number } | null): cached is Cached =>
	!!cached && !!info && cached.size === info.size && cached.mtimeMs === info.mtimeMs;

function cacheRows(stateDir: string, rows: Row[], size: number, mtimeMs: number, whole: boolean): Cached {
	const cached: Cached = { rows, lines: Object.freeze(rows.flatMap((row) => (row.line ? [row.line] : []))), size, mtimeMs, whole };
	cache.set(stateDir, cached);
	return cached;
}

export function appendSent(stateDir: string, entry: Line): void {
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const path = join(stateDir, SENT_LOG_FILE);
	const raw = JSON.stringify(entry);
	const cached = cache.get(stateDir);
	// Kept only while the file is as the board left it: someone else's write is read whole next time.
	const keep = unchanged(cached, stamp(path)) && cached!.whole;
	cache.delete(stateDir);
	/** The line as the cache now has it; null when the cache could not keep up, the write failed, or
	 *  the file ended with a line cut short that it joined: a read of the file tells then. */
	let line: Line | null = null;
	try {
		// The text may hold internal addresses and paths, like the reports do.
		appendFileSync(path, raw + '\n', { mode: 0o600 });
		if (!keep) return;
		const size = cached!.size + Buffer.byteLength(raw + '\n');
		const info = stamp(path);
		if (info?.size !== size) return;
		line = parse(raw);
		cacheRows(stateDir, [...cached!.rows, { raw, line }], size, info.mtimeMs, true);
	} finally {
		tell(stateDir, line);
	}
}

/** The IDs a line belongs with: its own entry's, and a switch's for the wake that resumes it. */
function keysOf(line: Line): string[] {
	switch (line.kind) {
		case 'answer-state':
			return [line.answerId];
		case 'launch-bound':
		case 'launch-followed':
			return [line.launchId];
		case 'resume-closed':
		case 'resume-result':
		case 'resume-pane':
			return [line.wakeId];
		case 'switch-step':
			return [line.switchId];
		case 'wake':
			return line.switchId ? [line.id, line.switchId] : [line.id];
		default:
			return [line.id];
	}
}

/**
 * Drop every group whose latest line is more than 30 days before `now`: an entry with the lines
 * that add to it, and a switch with the wakes that resume it. The file is replaced whole, and only
 * when something is dropped. Lines that cannot be read, or have no time, are kept.
 */
function prune(stateDir: string, cached: Cached, now: number): Cached {
	// Union of IDs into groups, each with its latest time.
	const parent = new Map<string, string>();
	const root = (key: string): string => {
		let top = key;
		while (parent.has(top) && parent.get(top) !== top) top = parent.get(top)!;
		parent.set(key, top);
		return top;
	};
	for (const line of cached.lines) {
		const [first, ...rest] = keysOf(line).map(root);
		for (const other of rest) if (other !== first) parent.set(other, first);
	}
	const latest = new Map<string, number>();
	for (const line of cached.lines) {
		const group = root(keysOf(line)[0]);
		const time = Date.parse(line.time);
		latest.set(group, Math.max(latest.get(group) ?? -Infinity, Number.isNaN(time) ? Infinity : time));
	}
	const kept = cached.rows.filter(({ line }) => !line || !(now - latest.get(root(keysOf(line)[0]))! > RETENTION_MS));
	if (kept.length === cached.rows.length) return cached;
	const path = join(stateDir, SENT_LOG_FILE);
	const temporary = `${path}.${process.pid}.tmp`;
	const text = kept.map(({ raw }) => raw + '\n').join('');
	try {
		// One left by a board stopped midway would keep its own mode.
		rmSync(temporary, { force: true });
		writeFileSync(temporary, text, { mode: 0o600 });
		renameSync(temporary, path);
		tell(stateDir, null);
	} catch {
		// The log stays whole until the next cleaning; reading it is not held up by this.
		rmSync(temporary, { force: true });
		return cached;
	}
	const info = stamp(path);
	const size = Buffer.byteLength(text);
	if (info?.size !== size) {
		cache.delete(stateDir);
		return readCached(stateDir) ?? cached;
	}
	return cacheRows(stateDir, kept, size, info.mtimeMs, true);
}

/** The log as it is in the file, from the cache while the file is as the board left it. */
function readCached(stateDir: string): Cached | null {
	const path = join(stateDir, SENT_LOG_FILE);
	const info = stamp(path);
	const cached = cache.get(stateDir);
	if (unchanged(cached, info)) return cached;
	cache.delete(stateDir);
	if (!info) return null;
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
	sentLogReads.count += 1;
	// Read again because it changed: a log kept up with may miss what changed it.
	tell(stateDir, null);
	const rows = text
		.split('\n')
		.filter((raw) => raw.trim())
		.map((raw) => ({ raw, line: parse(raw) }));
	const size = Buffer.byteLength(text);
	const whole = text === '' || text.endsWith('\n');
	// A line appended between the stat and the read: what was read is used once, and read again next time.
	if (size !== info.size) return { rows, lines: Object.freeze(rows.flatMap((row) => (row.line ? [row.line] : []))), size, mtimeMs: info.mtimeMs, whole };
	return cacheRows(stateDir, rows, size, info.mtimeMs, whole);
}

/**
 * Every line of the log. Called with the board's clock, the first read of a state directory, and
 * the first one a day after, drop what is past retention too. The lines are frozen: they are the
 * cache's own.
 */
export function readLines(stateDir: string, now: number): readonly Line[] {
	return readRows(stateDir, now)?.lines ?? [];
}

function readRows(stateDir: string, now: number): Cached | null {
	let cached = readCached(stateDir);
	const last = prunedAt.get(stateDir);
	if (last === undefined || now - last >= PRUNE_EVERY_MS) {
		prunedAt.set(stateDir, now);
		if (cached) cached = prune(stateDir, cached, now);
	}
	return cached;
}

/** The lines one read of the board works from (`openLog`), and how it adds one; `append` throws
 *  as `appendSent` does. */
export interface SentLog {
	/** Throws, once the file has to be read again, when it cannot be. */
	readonly lines: readonly Line[];
	append(line: Line): void;
	/** Stop adding the lines appended from now on. */
	close(): void;
}

/**
 * The log read once, for one read of the board: its lines now, and, until `close`, every line the
 * board appends meanwhile, by the read itself or by a request alongside it. When the board cannot
 * tell what the file holds after a change (a write failed, joined a line cut short or found the
 * file changed by someone else; a cleaning rewrote it; any read found it changed), `lines` reads
 * the file again next, as every step of a read used to. Otherwise `lines` is what a read of the
 * file would give: the board is the only writer, and a change by anyone else is seen once the
 * board next writes or reads the file.
 */
export function openLog(stateDir: string, now: number): SentLog {
	let lines = [...(readRows(stateDir, now)?.lines ?? [])];
	let stale = false;
	const add = (line: Line | null) => {
		if (line && !stale) lines.push(line);
		else stale = true;
	};
	const reads = live.get(stateDir) ?? new Set();
	live.set(stateDir, reads.add(add));
	return {
		get lines() {
			if (stale) {
				lines = [...(readCached(stateDir)?.lines ?? [])];
				stale = false;
			}
			return lines;
		},
		append: (line) => appendSent(stateDir, line),
		close() {
			reads.delete(add);
			if (!reads.size && live.get(stateDir) === reads) live.delete(stateDir);
		}
	};
}
