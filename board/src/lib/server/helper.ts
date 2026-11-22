// The only way the board reads and writes question files, and reads a controller's conversation
// and work ledger: the LAT panel helper's `board` commands.
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { ledgerFrom, type LedgerRounds, type LedgerView } from '../board/ledger.ts';
import { linkEvidence } from './ledger-evidence.ts';
import type { HelperController, HelperQuestion } from '../board/types.ts';
import type { PreauthSettings } from '../board/preauth.ts';
import { fixedModel, type CurrentSettings } from '../board/models.ts';
import type { TranscriptItem, TranscriptPage } from '../board/transcript.ts';
import { usageFrom } from '../board/usage.ts';
import { reviewFrom, type Review } from '../board/review.ts';
import { unattendedFrom, type UnattendedSettings, type UnattendedView } from '../board/unattended.ts';
import type { BoardConfig } from './config.ts';
import { parseJsonOutput, runCommand } from './external.ts';
import type { FileCache } from './read-cache.ts';

type HelperList =
	| { ok: true; controllers: HelperController[] }
	| { ok: false; reason: string };

const MAX_OUTPUT = 64 * 1024 * 1024;

/** Run one `board` command. Aborting `signal` ends the helper and everything it started: the
 *  helper command is a wrapper (`uv run`) whose Python child would otherwise keep running. */
async function run(config: BoardConfig, args: string[], signal?: AbortSignal): Promise<{ stdout: string; failure: string | null }> {
	const result = await runCommand(config.helperCommand, ['board', ...args], {
		timeoutMs: config.helperTimeoutMs,
		maxBuffer: MAX_OUTPUT,
		signal,
		// Only an abortable run leads its own process group, so the whole group can be ended.
		killGroup: signal !== undefined
	});
	let failure = result.failure;
	if (result.timedOut) failure = `輔助工具逾時（${config.helperTimeoutMs / 1000} 秒）`;
	else if (result.ended === 'exit') failure = lastLine(result.stderr) || `輔助工具結束碼 ${result.code ?? result.signal}`;
	return { stdout: result.stdout, failure };
}

const lastLine = (text: string) => text.trim().split('\n').at(-1);

function isController(value: unknown): value is HelperController {
	const item = value as HelperController;
	return (
		typeof item === 'object' &&
		item !== null &&
		typeof item.session_id === 'string' &&
		typeof item.hcom_name === 'string' &&
		typeof item.workspace === 'string' &&
		typeof item.questions_path === 'string' &&
		Array.isArray(item.questions) &&
		item.questions.every((question) => typeof question === 'object' && question !== null)
	);
}

export async function listControllers(config: BoardConfig): Promise<HelperList> {
	const listed = await run(config, ['list']);
	const { failure } = listed;
	const parsed = parseJsonOutput<{ controllers?: unknown; reason?: unknown }>(listed, '輔助工具的輸出不是 JSON');
	if (!parsed.ok) return parsed;
	const payload = parsed.value;
	// The helper prints one JSON object even when it fails; its reason is the useful one.
	const reason = typeof payload?.reason === 'string' ? payload.reason : failure;
	if (failure || !Array.isArray(payload?.controllers) || !payload.controllers.every(isController)) {
		return { ok: false, reason: reason ?? '輔助工具的輸出缺少主控清單' };
	}
	return { ok: true, controllers: payload.controllers };
}

/** The questions one question file holds now, whether or not its controller is still bound; null
 *  when the helper could not read it. */
export async function readQuestions(config: BoardConfig, questionsPath: string): Promise<HelperQuestion[] | null> {
	const read = await run(config, ['questions', `--questions=${questionsPath}`]);
	if (read.failure) return null;
	const parsed = parseJsonOutput<{ questions?: unknown } | null>(read, '');
	const questions = parsed.ok ? parsed.value?.questions : null;
	const usable = Array.isArray(questions) && questions.every((question) => typeof question === 'object' && question !== null);
	return usable ? questions : null;
}

/** One question file's answered questions, as `board answered` prints them. */
export interface AnsweredFile {
	/** Null when the controller's name makes no file name. */
	questions_path: string | null;
	/** The controller the file was asked for by, when it was not asked for by path. */
	workspace?: string;
	hcom_name?: string;
	questions: HelperQuestion[];
	/** Why this file or its archive could not be read; null when they could. */
	error: string | null;
}

type HelperAnswered = { ok: true; files: AnsweredFile[] } | { ok: false; reason: string };

const isAnsweredFile = (value: unknown): value is AnsweredFile => {
	const file = value as AnsweredFile;
	return (
		typeof file === 'object' &&
		file !== null &&
		(file.questions_path === null || typeof file.questions_path === 'string') &&
		(file.error === null || typeof file.error === 'string') &&
		Array.isArray(file.questions) &&
		file.questions.every((question) => typeof question === 'object' && question !== null)
	);
};

/** Question files to read answered questions from: by path, or by the workspace and name of a
 *  controller that is no longer bound, whose file the helper names. */
export interface AnsweredSources {
	paths: string[];
	controllers: { workspace: string; hcomName: string }[];
}

/** The files `board answered` reads for a controller that is not bound, from the file it named:
 *  the root `.lat` file and the `.lat/questions/` file of its name, both in the `.lat` that file is
 *  in and in the workspace's own `.lat`, each with its archive. Null when the name of the file does
 *  not follow either form. */
function answeredFiles(workspace: string, questionsPath: string): string[] | null {
	const name = basename(questionsPath, '.md');
	const inFolder = basename(dirname(questionsPath)) === 'questions';
	if (!questionsPath.endsWith('.md') || (!inFolder && !name.startsWith('questions-'))) return null;
	const safe = inFolder ? name : name.slice('questions-'.length);
	const lat = inFolder ? dirname(dirname(questionsPath)) : dirname(questionsPath);
	let own: string;
	try {
		own = realpathSync(workspace);
	} catch {
		own = resolve(workspace);
	}
	const lats = new Set([lat, join(own, '.lat')]);
	return [...lats].flatMap((dir) =>
		[join(dir, `questions-${safe}`), join(dir, 'questions', safe)].flatMap((stem) => [`${stem}.md`, `${stem}-archive.md`])
	);
}

const answeredKey = (controller: { workspace?: string; hcomName?: string; hcom_name?: string }) =>
	`${controller.workspace}\n${controller.hcomName ?? controller.hcom_name}`;

/** The answered questions each of these question files and its archive hold. With `cache`, a
 *  controller asked for by name whose files have not changed is not asked for again; what was
 *  printed for it last stands in. Files asked for by path, the bound controllers', are always read. */
export async function readAnswered(config: BoardConfig, { paths, controllers }: AnsweredSources, cache?: FileCache<AnsweredFile>): Promise<HelperAnswered> {
	const startedAt = Date.now();
	cache?.keepOnly(controllers.map(answeredKey));
	if (!paths.length && !controllers.length) return { ok: true, files: [] };
	const kept = new Map<string, AnsweredFile>();
	for (const controller of controllers) {
		const hit = cache?.get(answeredKey(controller), startedAt);
		if (hit) kept.set(answeredKey(controller), hit);
	}
	const asked = controllers.filter((controller) => !kept.has(answeredKey(controller)));
	if (!paths.length && !asked.length) return { ok: true, files: controllers.map((controller) => kept.get(answeredKey(controller))!) };
	const read = await run(config, [
		'answered',
		...paths.map((path) => `--questions=${path}`),
		...asked.flatMap((controller) => [`--workspace=${controller.workspace}`, `--hcom-name=${controller.hcomName}`])
	]);
	const { failure } = read;
	const parsed = parseJsonOutput<{ files?: unknown; reason?: unknown }>(read, '輔助工具的輸出不是 JSON');
	if (!parsed.ok) return parsed;
	const payload = parsed.value;
	if (failure || !Array.isArray(payload?.files) || !payload.files.every(isAnsweredFile)) {
		return { ok: false, reason: textOrNull(payload?.reason) ?? failure ?? '輔助工具的輸出缺少答過的題目' };
	}
	const files: AnsweredFile[] = payload.files;
	if (!cache) return { ok: true, files };
	// The files asked for by path come first, in order, then those asked for by name.
	const byPath = files.slice(0, paths.length);
	const byName = files.slice(paths.length);
	for (const file of byName) {
		if (file.workspace === undefined || file.questions_path === null || file.error !== null) continue;
		const sources = answeredFiles(file.workspace, file.questions_path);
		if (sources) cache.set(answeredKey(file), file, sources, startedAt);
	}
	if (!kept.size) return { ok: true, files };
	// In the order asked for, as one run of the helper for all of them prints them.
	const fresh = new Map(byName.map((file) => [answeredKey(file), file]));
	return { ok: true, files: [...byPath, ...controllers.flatMap((controller) => kept.get(answeredKey(controller)) ?? fresh.get(answeredKey(controller)) ?? [])] };
}

/** What `board answer` and `board notify` print: one JSON object with a status. */
interface HelperResult {
	status: string;
	reason: string | null;
	/** Only on a submitted answer: whether the controller was notified. */
	notified: boolean | null;
}

async function writeCommand(config: BoardConfig, args: string[]): Promise<HelperResult> {
	const written = await run(config, args);
	const parsed = parseJsonOutput<{ status?: unknown; reason?: unknown; notified?: unknown } | null>(written, '輔助工具的輸出不是預期的格式');
	const payload = parsed.ok ? parsed.value : null;
	if (typeof payload?.status !== 'string') {
		// Nothing usable was printed: a timeout, a usage error, or a helper that could not start.
		return { status: 'error', reason: written.failure ?? '輔助工具的輸出不是預期的格式', notified: null };
	}
	return {
		status: payload.status,
		reason: typeof payload.reason === 'string' ? payload.reason : null,
		notified: typeof payload.notified === 'boolean' ? payload.notified : null
	};
}

interface HelperAnswer {
	questionsPath: string;
	id: string;
	revision: number;
	sectionSha256: string;
	select: number[];
	text: string;
	note: string;
}

/** Write and submit one answer, as the Herdr panel does. */
export function answerQuestion(config: BoardConfig, answer: HelperAnswer): Promise<HelperResult> {
	// Values are joined to their option with `=`, so one that starts with a dash is still a value.
	const args = [
		'answer',
		`--questions=${answer.questionsPath}`,
		`--id=${answer.id}`,
		`--revision=${answer.revision}`,
		`--expected-section-sha256=${answer.sectionSha256}`,
		...answer.select.map((position) => `--select=${position}`)
	];
	if (answer.text.trim()) args.push(`--text=${answer.text}`);
	if (answer.note.trim()) args.push(`--note=${answer.note}`);
	return writeCommand(config, args);
}

/** Resend the pending notification of one question file. Rewrites no answer. */
export function notifyController(config: BoardConfig, questionsPath: string): Promise<HelperResult> {
	return writeCommand(config, ['notify', `--questions=${questionsPath}`]);
}

/** `missing` when the client has written no record for the session yet, as with one just started. */
type HelperTranscript = { ok: true; page: TranscriptPage; path: string } | { ok: false; reason: string; missing?: boolean };

const ITEM_KINDS = new Set(['user', 'assistant', 'tool']);
const isItem = (value: unknown): value is TranscriptItem =>
	typeof value === 'object' &&
	value !== null &&
	typeof (value as TranscriptItem).seq === 'number' &&
	ITEM_KINDS.has((value as TranscriptItem).kind);

/** One page of a controller's conversation, read by the helper from the client's own record:
 *  the latest page, or the one just before the `before` cursor. `path` is that record file; the
 *  board watches it and never shows it. Aborting the signal stops the helper. */
export async function readTranscript(
	config: BoardConfig,
	client: string,
	sessionId: string,
	before: number | null = null,
	signal?: AbortSignal
): Promise<HelperTranscript> {
	const args = ['transcript', `--client=${client}`, `--session-id=${sessionId}`];
	if (before !== null) args.push(`--before=${before}`);
	const read = await run(config, args, signal);
	const { failure } = read;
	const parsed = parseJsonOutput<Partial<TranscriptPage> & { status?: unknown; reason?: unknown; path?: unknown; permission?: unknown }>(
		read,
		'輔助工具的輸出不是 JSON'
	);
	if (!parsed.ok) return parsed;
	const payload = parsed.value;
	if (failure || payload?.status !== 'ok' || !Array.isArray(payload.items) || !payload.items.every(isItem) || typeof payload.path !== 'string') {
		const reason = typeof payload?.reason === 'string' ? payload.reason : failure;
		return { ok: false, reason: reason ?? '輔助工具的輸出缺少對話紀錄', ...(payload?.status === 'not_found' && { missing: true }) };
	}
	return {
		ok: true,
		path: payload.path,
		page: {
			items: payload.items,
			before: typeof payload.before === 'number' ? payload.before : null,
			skipped: typeof payload.skipped === 'number' ? payload.skipped : 0,
			current: currentFrom(payload.current),
			// A Codex record's, with the permission mode of either client's; an older helper prints none.
			usage: usageFrom({ ...payload.usage, permission: payload.permission })
		}
	};
}

const textOrNull = (value: unknown) => (typeof value === 'string' && value ? value : null);

/** The latest turn's settings as the helper printed them; null when there are none to show. */
function currentFrom(value: unknown): CurrentSettings | null {
	if (typeof value !== 'object' || value === null) return null;
	const given = value as Record<string, unknown>;
	const current = { model: textOrNull(given.model), effort: textOrNull(given.effort), time: textOrNull(given.time) };
	return current.model || current.effort ? current : null;
}

type LaunchArgs = { ok: true; args: string[] } | { ok: false; reason: string };

/** The arguments hcom stored for the launch of the agent with this session ID, read by the helper
 *  from hcom's own data; hcom repeats them on every resume. */
export async function readLaunchArgs(config: BoardConfig, sessionId: string, signal?: AbortSignal): Promise<LaunchArgs> {
	const read = await run(config, ['launch-args', `--session-id=${sessionId}`], signal);
	const parsed = parseJsonOutput<{ status?: unknown; reason?: unknown; args?: unknown } | null>(read, '輔助工具的輸出不是預期的格式');
	if (!parsed.ok) return parsed;
	const payload = parsed.value;
	const args = payload?.args;
	if (payload?.status === 'ok' && Array.isArray(args) && args.every((arg) => typeof arg === 'string')) return { ok: true, args };
	return { ok: false, reason: textOrNull(payload?.reason) ?? read.failure ?? '輔助工具的輸出不是預期的格式' };
}

/** Whether a Codex controller's launch fixes its model, from the arguments hcom stored for it.
 *  Aborting `signal` ends the helper reading them. */
export async function modelLock(
	config: BoardConfig,
	sessionId: string,
	signal?: AbortSignal
): Promise<{ lock: 'free' | 'fixed' | 'unknown'; reason: string | null }> {
	const read = await readLaunchArgs(config, sessionId, signal);
	if (!read.ok) return { lock: 'unknown', reason: read.reason };
	return { lock: fixedModel(read.args) ? 'fixed' : 'free', reason: null };
}

/** The model and effort of the controller's latest turn; null when they cannot be read. */
export async function readCurrent(config: BoardConfig, client: string, sessionId: string): Promise<CurrentSettings | null> {
	const read = await readTranscript(config, client, sessionId);
	return read.ok ? (read.page.current ?? null) : null;
}

/** Why some report file due could not be deleted; null when every one was, or was left for a busy
 *  lock. */
type PruneResult = { reason: string | null };

const isFailure = (value: unknown): value is { session_id: string; reason: string } =>
	typeof (value as { session_id?: unknown })?.session_id === 'string' && typeof (value as { reason?: unknown }).reason === 'string';

/** Delete these sessions' report files when their newest report was issued 30 days or more before
 *  `now`, through the helper: only it can take the lock the turn-end hook appends under. */
export async function pruneReports(config: BoardConfig, now: number, sessionIds: string[]): Promise<PruneResult> {
	const pruned = await run(config, [
		'prune-reports',
		`--reports-dir=${config.reportsDir}`,
		`--now=${new Date(now).toISOString()}`,
		...sessionIds.map((sessionId) => `--session-id=${sessionId}`)
	]);
	const parsed = parseJsonOutput<{ status?: unknown; reason?: unknown; deleted?: unknown; failed?: unknown } | null>(pruned, '輔助工具的輸出不是預期的格式');
	if (!parsed.ok) return { reason: parsed.reason };
	const payload = parsed.value;
	const { deleted, failed } = payload ?? {};
	if (payload?.status === 'ok' && Array.isArray(deleted) && deleted.every((id) => typeof id === 'string') && Array.isArray(failed) && failed.every(isFailure)) {
		return { reason: failed.map((item) => `${item.session_id}：${item.reason}`).join('；') || null };
	}
	return { reason: textOrNull(payload?.reason) ?? pruned.failure ?? '輔助工具的輸出不是預期的格式' };
}

/** A controller's ledger as read, with the ledger file to watch; `path` is null when its session
 *  record names none. */
export interface ReadLedger {
	view: LedgerView;
	path: string | null;
}

type HelperLedgers = { ok: true; ledgers: Map<string, ReadLedger> } | { ok: false; reason: string };

/** One controller's entry as `board ledger` prints it. */
export type LedgerEntry = { session_id: string; ledger_path?: unknown; status?: unknown; reason?: unknown; ledger?: unknown };

/** What a full read keeps of the ledgers of controllers that are not bound, and which are bound:
 *  those are always read again. */
export interface LedgerCache {
	store: FileCache<LedgerEntry>;
	bound: ReadonlySet<string>;
}

/** Row statuses whose times do not move with the clock. */
const SETTLED_ROWS = new Set(['done', 'cancelled', 'unassigned']);
/** Ticket step states that no longer change: a step still to come (a merge, a deploy) comes from
 *  git or the deploy history, not from the files the entry is checked against. */
const SETTLED_STEPS = new Set(['done', 'skipped']);

/** How long a ledger that can still change without a file changing is kept: its rows and tickets
 *  are counted to the time lat-ledger read it, and a ticket waiting for its merge or deploy learns
 *  of it from git, so it is read again after one to two minutes. */
const MOVING_LEDGER_MAX_AGE_MS = 2 * 60_000;

/** The files a read ledger came from, when what was printed can be kept: the session record in
 *  either place, the ledger, the problem log and each row's task card; and how long it may be kept,
 *  shorter for one that still moves. Null for one that cannot be kept: not read, gone already, or
 *  naming a task card by a relative path (the helper resolves it from its own folder). */
function ledgerFiles(workspace: string, sessionId: string, entry: LedgerEntry): { files: string[]; maxAgeMs?: number } | null {
	const kept = readFrom(entry);
	if (!kept) return null;
	const record = `${sessionId}.json`;
	const problemsPath = (entry.ledger as { problems_path: string }).problems_path;
	return { ...kept, files: [join(dirname(problemsPath), 'sessions', record), join(workspace, '.lat', 'sessions', record), ...kept.files] };
}

/** The files one read ledger came from (the ledger, the problem log and each row's task card) and
 *  how long it may be kept, as for `ledgerFiles`; null for one that cannot be kept. */
function readFrom(entry: { status?: unknown; ledger_path?: unknown; ledger?: unknown }): { files: string[]; maxAgeMs?: number } | null {
	const ledger = entry.ledger as { problems_path?: unknown; items?: unknown; tickets?: unknown } | undefined;
	if (entry.status !== 'ok' || typeof entry.ledger_path !== 'string' || !existsSync(entry.ledger_path)) return null;
	if (typeof ledger?.problems_path !== 'string' || !Array.isArray(ledger.items) || !Array.isArray(ledger.tickets)) return null;
	const items = ledger.items as { status?: unknown; card?: unknown }[];
	const cards = items.flatMap((item) => (typeof item?.card === 'string' && item.card ? [item.card] : []));
	if (!cards.every((card) => isAbsolute(card))) return null;
	const tickets = ledger.tickets as { running?: unknown; times?: unknown; steps?: unknown }[];
	const settled = (list: unknown, done: (value: { running?: unknown; state?: unknown }) => boolean) =>
		!Array.isArray(list) || list.every((value) => typeof value === 'object' && value !== null && done(value));
	const moving =
		!items.every((item) => typeof item?.status === 'string' && SETTLED_ROWS.has(item.status)) ||
		!tickets.every(
			(ticket) =>
				ticket?.running === false &&
				settled(ticket.times, (segment) => segment.running === false) &&
				settled(ticket.steps, (step) => typeof step.state === 'string' && SETTLED_STEPS.has(step.state))
		);
	const files = [entry.ledger_path, ledger.problems_path, ...cards];
	return moving ? { files, maxAgeMs: MOVING_LEDGER_MAX_AGE_MS } : { files };
}

/** These controllers' work ledgers, by session ID, in one run of the helper: it finds each one's
 *  ledger in its session record and reads it with `lat-ledger show --json`. The reads get half the
 *  helper's time, the rest left for it to start and print, so a ledger whose writer holds it fails
 *  alone. With `cache`, a controller that is not bound and whose files have not changed is not
 *  asked for again; what it printed last stands in. */
export async function readLedgers(config: BoardConfig, controllers: { workspace: string; sessionId: string }[], cache?: LedgerCache): Promise<HelperLedgers> {
	const startedAt = Date.now();
	const keyOf = (controller: { workspace: string; sessionId: string }) => `${controller.workspace}\n${controller.sessionId}`;
	cache?.store.keepOnly(controllers.map(keyOf));
	if (!controllers.length) return { ok: true, ledgers: new Map() };
	const kept = new Map<string, LedgerEntry>();
	if (cache) {
		for (const controller of controllers) {
			const hit = cache.bound.has(controller.sessionId) ? undefined : cache.store.get(keyOf(controller), startedAt);
			if (hit) kept.set(controller.sessionId, hit);
		}
	}
	const asked = controllers.filter((controller) => !kept.has(controller.sessionId));
	let read: LedgerEntry[] = [];
	if (asked.length) {
		const done = await run(config, [
			'ledger',
			`--seconds=${config.helperTimeoutMs / 2000}`,
			...asked.flatMap((controller) => [`--workspace=${controller.workspace}`, `--session-id=${controller.sessionId}`])
		]);
		const parsed = parseJsonOutput<{ ledgers?: unknown; reason?: unknown } | null>(done, '輔助工具的輸出不是 JSON');
		if (!parsed.ok) return parsed;
		const entries = parsed.value?.ledgers;
		const usable = (entry: unknown): entry is LedgerEntry => typeof (entry as { session_id?: unknown })?.session_id === 'string';
		if (done.failure || !Array.isArray(entries) || !entries.every(usable)) {
			return { ok: false, reason: textOrNull(parsed.value?.reason) ?? done.failure ?? '輔助工具的輸出缺少總表' };
		}
		read = entries;
		if (cache) {
			const workspaces = new Map(asked.map((controller) => [controller.sessionId, controller.workspace]));
			for (const entry of read) {
				const workspace = workspaces.get(entry.session_id);
				if (workspace === undefined || cache.bound.has(entry.session_id)) continue;
				const kept = ledgerFiles(workspace, entry.session_id, entry);
				if (kept) cache.store.set(keyOf({ workspace, sessionId: entry.session_id }), entry, kept.files, startedAt, kept.maxAgeMs);
			}
		}
	}
	// In the order asked for, as one run of the helper for all of them prints them.
	const fresh = new Map(read.map((entry) => [entry.session_id, entry]));
	const entries = kept.size ? controllers.flatMap((controller) => kept.get(controller.sessionId) ?? fresh.get(controller.sessionId) ?? []) : read;
	const views = await linkEvidence(entries.map(ledgerFrom));
	return {
		ok: true,
		ledgers: new Map(entries.map((entry, index) => [entry.session_id, { view: views[index], path: textOrNull(entry.ledger_path) }]))
	};
}

/** One earlier round as `board ledger-rounds` prints it. */
export type RoundEntry = { round: number; ledger_path: string; started_at?: unknown; ended_at?: unknown; status?: unknown; reason?: unknown; ledger?: unknown };

/** What the earlier rounds' reads keep: each ended round's ledger by its path, and which paths
 *  each controller's earlier rounds had at its last read. */
export interface RoundsCache {
	store: FileCache<RoundEntry>;
	paths: Map<string, string[]>;
}

/** A controller's earlier rounds, newest first, with this round's number and start: from its
 *  session record's history, each round's ledger read with `lat-ledger show --json`. A round's
 *  ledger whose files have not changed since it was read is not read again (the rule `readLedgers`
 *  keeps a ledger by). */
export async function readLedgerRounds(
	config: BoardConfig,
	controller: { workspace: string; sessionId: string },
	cache: RoundsCache
): Promise<{ ok: true; rounds: LedgerRounds } | { ok: false; reason: string }> {
	const startedAt = Date.now();
	const key = `${controller.workspace}\n${controller.sessionId}`;
	const known = new Map<string, RoundEntry>();
	for (const path of cache.paths.get(key) ?? []) {
		const hit = cache.store.get(path, startedAt);
		if (hit) known.set(path, hit);
	}
	const done = await run(config, [
		'ledger-rounds',
		`--workspace=${controller.workspace}`,
		`--session-id=${controller.sessionId}`,
		`--seconds=${config.helperTimeoutMs / 2000}`,
		...[...known.keys()].map((path) => `--known=${path}`)
	]);
	const parsed = parseJsonOutput<{ status?: unknown; reason?: unknown; current?: unknown; earlier?: unknown } | null>(done, '輔助工具的輸出不是 JSON');
	if (!parsed.ok) return parsed;
	const { current, earlier } = parsed.value ?? {};
	const usable = (entry: unknown): entry is RoundEntry =>
		typeof (entry as RoundEntry)?.round === 'number' && typeof (entry as RoundEntry).ledger_path === 'string';
	const round = (current as { round?: unknown } | undefined)?.round;
	if (parsed.value?.status !== 'ok' || typeof round !== 'number' || !Array.isArray(earlier) || !earlier.every(usable)) {
		return { ok: false, reason: textOrNull(parsed.value?.reason) ?? done.failure ?? '輔助工具的輸出缺少輪次' };
	}
	const entries = earlier.map((entry) => {
		const hit = entry.status === 'known' ? known.get(entry.ledger_path) : undefined;
		if (hit) return { ...hit, round: entry.round, started_at: entry.started_at, ended_at: entry.ended_at };
		if (entry.status === 'known') return { ...entry, status: 'error', reason: '這一輪的總表剛換過，下次重讀再試' };
		const kept = readFrom(entry);
		if (kept) cache.store.set(entry.ledger_path, entry, kept.files, startedAt, kept.maxAgeMs);
		return entry;
	});
	cache.paths.set(key, entries.map((entry) => entry.ledger_path));
	cache.store.keepOnly([...cache.paths.values()].flat());
	// Its own files to serve: the board's read of this round's ledgers keeps allowing theirs.
	const views = await linkEvidence(entries.map(ledgerFrom), `rounds\n${key}`);
	return {
		ok: true,
		rounds: {
			current: { round, startedAt: textOrNull((current as { started_at?: unknown }).started_at) },
			earlier: entries.map((entry, index) => ({ round: entry.round, startedAt: textOrNull(entry.started_at), endedAt: textOrNull(entry.ended_at), ledger: views[index] }))
		}
	};
}

const isPreauthSettings = (value: unknown): value is PreauthSettings => {
	const layer = (value as PreauthSettings | null)?.layers?.global;
	return (
		typeof layer === 'object' &&
		layer !== null &&
		typeof layer.path === 'string' &&
		typeof layer.sha256 === 'string' &&
		Array.isArray(layer.problems) &&
		typeof layer.actions === 'object' &&
		typeof layer.advisor === 'object'
	);
};

/** The pre-authorization files as the helper reads them; the project's only with a workspace. */
export async function readPreauth(config: BoardConfig, workspace: string | null): Promise<{ ok: true; settings: PreauthSettings } | { ok: false; reason: string }> {
	const read = await run(config, ['preauth-read', ...(workspace ? [`--workspace=${workspace}`] : [])]);
	const parsed = parseJsonOutput<{ reason?: unknown } | null>(read, '輔助工具的輸出不是 JSON');
	if (!parsed.ok) return parsed;
	if (read.failure || !isPreauthSettings(parsed.value)) return { ok: false, reason: textOrNull(parsed.value?.reason) ?? read.failure ?? '輔助工具的輸出缺少預先授權設定' };
	return { ok: true, settings: parsed.value };
}

/** What `board preauth-write` answers. `status` other than ok means the write did not stay. */
export interface PreauthWrite {
	status: string;
	reason: string | null;
	problems: string[];
	/** Only when the write could be neither logged nor undone: the file now, and how to put it back. */
	current: string | null;
	toUndo: string[];
	settings: PreauthSettings | null;
}

/** Write the changed keys to one layer, unless its file is no longer the one with this hash. */
export async function writePreauth(
	config: BoardConfig,
	write: { layer: 'global' | 'project'; workspace: string | null; sha256: string; changes: unknown }
): Promise<PreauthWrite> {
	const written = await run(config, [
		'preauth-write',
		`--layer=${write.layer}`,
		...(write.workspace ? [`--workspace=${write.workspace}`] : []),
		`--expected-sha256=${write.sha256}`,
		`--changes=${JSON.stringify(write.changes)}`
	]);
	const parsed = parseJsonOutput<{
		status?: unknown;
		reason?: unknown;
		problems?: unknown;
		current?: unknown;
		to_undo?: unknown;
		settings?: unknown;
	} | null>(written, '輔助工具的輸出不是預期的格式');
	const payload = parsed.ok ? parsed.value : null;
	const texts = (value: unknown) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);
	return {
		// A timeout may have stopped the helper before or after it wrote, so it is no success.
		status: typeof payload?.status === 'string' ? payload.status : 'error',
		reason: textOrNull(payload?.reason) ?? written.failure ?? (parsed.ok ? null : parsed.reason),
		problems: texts(payload?.problems),
		current: textOrNull(payload?.current),
		toUndo: texts(payload?.to_undo),
		settings: isPreauthSettings(payload?.settings) ? payload.settings : null
	};
}

type HelperUnattended = { ok: true; views: Map<string, { view: UnattendedView; files: string[] }> } | { ok: false; reason: string };

/** These controllers' unattended mode and grant, by session ID, in one run of the helper, with the
 *  files each depends on, for the board to watch. */
export async function readUnattended(config: BoardConfig, controllers: { workspace: string; sessionId: string }[]): Promise<HelperUnattended> {
	if (!controllers.length) return { ok: true, views: new Map() };
	const read = await run(config, [
		'unattended',
		`--seconds=${config.helperTimeoutMs / 2000}`,
		...controllers.flatMap((controller) => [`--workspace=${controller.workspace}`, `--session-id=${controller.sessionId}`])
	]);
	const parsed = parseJsonOutput<{ unattended?: unknown; reason?: unknown } | null>(read, '輔助工具的輸出不是 JSON');
	if (!parsed.ok) return parsed;
	const entries = parsed.value?.unattended;
	const usable = (entry: unknown): entry is { session_id: string; files?: unknown } => typeof (entry as { session_id?: unknown })?.session_id === 'string';
	if (read.failure || !Array.isArray(entries) || !entries.every(usable)) {
		return { ok: false, reason: textOrNull(parsed.value?.reason) ?? read.failure ?? '輔助工具的輸出缺少無人模式' };
	}
	const files = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
	return { ok: true, views: new Map(entries.map((entry) => [entry.session_id, { view: unattendedFrom(entry), files: files(entry.files) }])) };
}

/** What a write through lat-unattended answers: `ok`, or why not with the tool's own status. */
export type UnattendedWrite = { ok: true; value: Record<string, unknown> } | { ok: false; status: string; reason: string; problems: string[] };

async function unattendedCommand(config: BoardConfig, [command, ...args]: string[]): Promise<UnattendedWrite> {
	// The tool's own time ends a second before the board's for the helper, so its answer still comes back.
	const done = await run(config, [command, `--seconds=${Math.max(1, config.helperTimeoutMs / 1000 - 1)}`, ...args]);
	const parsed = parseJsonOutput<Record<string, unknown> | null>(done, '輔助工具的輸出不是預期的格式');
	const payload = parsed.ok ? parsed.value : null;
	if (payload?.status === 'ok') return { ok: true, value: payload };
	return {
		ok: false,
		// A timeout may have stopped the tool before or after it wrote, so it is no success.
		status: typeof payload?.status === 'string' ? payload.status : 'error',
		reason: textOrNull(payload?.reason) ?? done.failure ?? (parsed.ok ? '輔助工具的輸出不是預期的格式' : parsed.reason),
		problems: Array.isArray(payload?.problems) ? payload.problems.filter((item): item is string => typeof item === 'string') : []
	};
}

/** The global and these projects' unattended settings; a project is named by any folder in it. */
export async function readUnattendedSettings(config: BoardConfig, projects: string[]): Promise<{ ok: true; settings: UnattendedSettings } | { ok: false; reason: string }> {
	const read = await unattendedCommand(config, ['unattended-settings', ...projects.map((root) => `--project=${root}`)]);
	if (!read.ok) return { ok: false, reason: read.reason };
	const value = read.value as unknown as UnattendedSettings;
	if (typeof value.global?.sha256 !== 'string' || !Array.isArray(value.projects)) return { ok: false, reason: '輔助工具的輸出缺少無人模式設定' };
	return { ok: true, settings: value };
}

/** Write the changed keys of one layer's [unattended], unless its file is no longer the one read. */
export function writeUnattendedSettings(
	config: BoardConfig,
	write: { layer: 'global' | 'project'; project: string | null; sha256: string; changes: Record<string, unknown> }
): Promise<UnattendedWrite> {
	return unattendedCommand(config, [
		'unattended-settings-write',
		`--layer=${write.layer}`,
		...(write.project ? [`--project=${write.project}`] : []),
		`--expected-sha256=${write.sha256}`,
		`--changes=${JSON.stringify(write.changes)}`
	]);
}

/** Create, update or close one controller's grant through lat-unattended. */
export function changeUnattendedGrant(config: BoardConfig, controller: { workspace: string; sessionId: string }, args: string[]): Promise<UnattendedWrite> {
	return unattendedCommand(config, ['unattended-grant', `--workspace=${controller.workspace}`, `--session-id=${controller.sessionId}`, '--', ...args]);
}

/** One controller's whole review as `lat-unattended review show --json` prints it; `review` is null
 *  while the round has no review file yet. */
export async function readReview(config: BoardConfig, controller: { workspace: string; sessionId: string }): Promise<{ ok: true; review: Review | null } | { ok: false; reason: string }> {
	const done = await unattendedCommand(config, ['review', `--workspace=${controller.workspace}`, `--session-id=${controller.sessionId}`]);
	if (!done.ok) return { ok: false, reason: done.reason };
	if (done.value.path === null) return { ok: true, review: null };
	const review = reviewFrom(done.value);
	return review ? { ok: true, review } : { ok: false, reason: '輔助工具的輸出缺少回顧' };
}
