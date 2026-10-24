// The only way the board reads and writes question files, and reads a controller's conversation
// and work ledger: the LAT panel helper's `board` commands.
import { ledgerFrom, type LedgerView } from '../board/ledger.ts';
import type { HelperController, HelperQuestion } from '../board/types.ts';
import { fixedModel, type CurrentSettings } from '../board/models.ts';
import type { TranscriptItem, TranscriptPage } from '../board/transcript.ts';
import { usageFrom } from '../board/usage.ts';
import type { BoardConfig } from './config.ts';
import { parseJsonOutput, runCommand } from './external.ts';

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

/** The answered questions each of these question files and its archive hold. */
export async function readAnswered(config: BoardConfig, { paths, controllers }: AnsweredSources): Promise<HelperAnswered> {
	if (!paths.length && !controllers.length) return { ok: true, files: [] };
	const read = await run(config, [
		'answered',
		...paths.map((path) => `--questions=${path}`),
		...controllers.flatMap((controller) => [`--workspace=${controller.workspace}`, `--hcom-name=${controller.hcomName}`])
	]);
	const { failure } = read;
	const parsed = parseJsonOutput<{ files?: unknown; reason?: unknown }>(read, '輔助工具的輸出不是 JSON');
	if (!parsed.ok) return parsed;
	const payload = parsed.value;
	if (failure || !Array.isArray(payload?.files) || !payload.files.every(isAnsweredFile)) {
		return { ok: false, reason: textOrNull(payload?.reason) ?? failure ?? '輔助工具的輸出缺少答過的題目' };
	}
	return { ok: true, files: payload.files };
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

/** These controllers' work ledgers, by session ID, in one run of the helper: it finds each one's
 *  ledger in its session record and reads it with `lat-ledger show --json`. */
export async function readLedgers(config: BoardConfig, controllers: { workspace: string; sessionId: string }[]): Promise<HelperLedgers> {
	if (!controllers.length) return { ok: true, ledgers: new Map() };
	const read = await run(config, [
		'ledger',
		...controllers.flatMap((controller) => [`--workspace=${controller.workspace}`, `--session-id=${controller.sessionId}`])
	]);
	const parsed = parseJsonOutput<{ ledgers?: unknown; reason?: unknown } | null>(read, '輔助工具的輸出不是 JSON');
	if (!parsed.ok) return parsed;
	const entries = parsed.value?.ledgers;
	const usable = (entry: unknown): entry is { session_id: string; ledger_path?: unknown; status?: unknown; reason?: unknown; ledger?: unknown } =>
		typeof (entry as { session_id?: unknown })?.session_id === 'string';
	if (read.failure || !Array.isArray(entries) || !entries.every(usable)) {
		return { ok: false, reason: textOrNull(parsed.value?.reason) ?? read.failure ?? '輔助工具的輸出缺少總表' };
	}
	return {
		ok: true,
		ledgers: new Map(entries.map((entry) => [entry.session_id, { view: ledgerFrom(entry), path: textOrNull(entry.ledger_path) }]))
	};
}
