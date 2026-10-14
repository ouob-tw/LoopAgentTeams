// The only way the board reads and writes question files, and reads a controller's conversation:
// the LAT panel helper's `board` commands.
import { spawn, type ChildProcess } from 'node:child_process';
import type { HelperController, HelperQuestion } from '../board/types.ts';
import type { TranscriptItem, TranscriptPage } from '../board/transcript.ts';
import type { BoardConfig } from './config.ts';

export type HelperList =
	| { ok: true; controllers: HelperController[] }
	| { ok: false; reason: string };

const MAX_OUTPUT = 64 * 1024 * 1024;

/** Run one `board` command. Aborting `signal` ends the helper and everything it started: the
 *  helper command is a wrapper (`uv run`) whose Python child would otherwise keep running. */
function run(config: BoardConfig, args: string[], signal?: AbortSignal): Promise<{ stdout: string; failure: string | null }> {
	const [command, ...prefix] = config.helperCommand;
	return new Promise((resolve) => {
		let child: ChildProcess;
		try {
			// Only an abortable run leads its own process group, so the whole group can be ended.
			child = spawn(command, [...prefix, 'board', ...args], { detached: signal !== undefined, stdio: ['ignore', 'pipe', 'pipe'] });
		} catch (error) {
			// An argument that cannot be passed to a command at all, such as one holding a NUL character.
			return resolve({ stdout: '', failure: (error as Error).message });
		}
		const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
		const bytes = { stdout: 0, stderr: 0 };
		let failure: string | null = null;
		/** End the helper: its whole group when it leads one. */
		const kill = () => {
			try {
				if (signal) process.kill(-child.pid!, 'SIGKILL');
				else child.kill();
			} catch {
				// Already gone.
			}
		};
		const fail = (reason: string) => {
			failure ??= reason;
			kill();
		};
		const text = (stream: 'stdout' | 'stderr') => Buffer.concat(output[stream]).toString('utf8');
		for (const stream of ['stdout', 'stderr'] as const) {
			child[stream]!.on('data', (chunk: Buffer) => {
				if (bytes[stream] > MAX_OUTPUT) return;
				bytes[stream] += chunk.length;
				if (bytes[stream] <= MAX_OUTPUT) return void output[stream].push(chunk);
				// As before: the last line of what stderr had said, or which stream ran over.
				fail(text('stderr').trim().split('\n').at(-1) || `${stream} maxBuffer length exceeded`);
			});
		}
		const timer = setTimeout(() => fail(`輔助工具逾時（${config.helperTimeoutMs / 1000} 秒）`), config.helperTimeoutMs);
		const stop = () => fail('已取消');
		child.on('error', (error) => {
			// A helper that could not start may never close.
			clearTimeout(timer);
			resolve({ stdout: text('stdout'), failure: failure ?? error.message });
		});
		child.on('close', (code, killedBy) => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', stop);
			if (code !== 0 && !failure) {
				failure = text('stderr').trim().split('\n').at(-1) || `輔助工具結束碼 ${code ?? killedBy}`;
			}
			resolve({ stdout: text('stdout'), failure });
		});
		if (!signal || child.pid === undefined) return;
		if (signal.aborted) stop();
		else signal.addEventListener('abort', stop, { once: true });
	});
}

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
	const { stdout, failure } = await run(config, ['list']);
	let payload: { controllers?: unknown; reason?: unknown };
	try {
		payload = JSON.parse(stdout);
	} catch {
		return { ok: false, reason: failure ?? '輔助工具的輸出不是 JSON' };
	}
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
	const { stdout, failure } = await run(config, ['questions', `--questions=${questionsPath}`]);
	if (failure) return null;
	try {
		const questions = JSON.parse(stdout)?.questions;
		const usable = Array.isArray(questions) && questions.every((question) => typeof question === 'object' && question !== null);
		return usable ? questions : null;
	} catch {
		return null;
	}
}

/** What `board answer` and `board notify` print: one JSON object with a status. */
export interface HelperResult {
	status: string;
	reason: string | null;
	/** Only on a submitted answer: whether the controller was notified. */
	notified: boolean | null;
}

async function writeCommand(config: BoardConfig, args: string[]): Promise<HelperResult> {
	const { stdout, failure } = await run(config, args);
	let payload: { status?: unknown; reason?: unknown; notified?: unknown } | null;
	try {
		payload = JSON.parse(stdout);
	} catch {
		payload = null;
	}
	if (typeof payload?.status !== 'string') {
		// Nothing usable was printed: a timeout, a usage error, or a helper that could not start.
		return { status: 'error', reason: failure ?? '輔助工具的輸出不是預期的格式', notified: null };
	}
	return {
		status: payload.status,
		reason: typeof payload.reason === 'string' ? payload.reason : null,
		notified: typeof payload.notified === 'boolean' ? payload.notified : null
	};
}

export interface HelperAnswer {
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

export type HelperTranscript = { ok: true; page: TranscriptPage; path: string } | { ok: false; reason: string };

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
	const { stdout, failure } = await run(config, args, signal);
	let payload: Partial<TranscriptPage> & { status?: unknown; reason?: unknown; path?: unknown };
	try {
		payload = JSON.parse(stdout);
	} catch {
		return { ok: false, reason: failure ?? '輔助工具的輸出不是 JSON' };
	}
	if (failure || payload?.status !== 'ok' || !Array.isArray(payload.items) || !payload.items.every(isItem) || typeof payload.path !== 'string') {
		const reason = typeof payload?.reason === 'string' ? payload.reason : failure;
		return { ok: false, reason: reason ?? '輔助工具的輸出缺少對話紀錄' };
	}
	return {
		ok: true,
		path: payload.path,
		page: {
			items: payload.items,
			before: typeof payload.before === 'number' ? payload.before : null,
			skipped: typeof payload.skipped === 'number' ? payload.skipped : 0
		}
	};
}
