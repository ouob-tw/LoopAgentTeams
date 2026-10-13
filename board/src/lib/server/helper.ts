// The only way the board reads and writes question files: the LAT panel helper's `board` commands.
import { execFile } from 'node:child_process';
import type { HelperController, HelperQuestion } from '../board/types.ts';
import type { BoardConfig } from './config.ts';

export type HelperList =
	| { ok: true; controllers: HelperController[] }
	| { ok: false; reason: string };

function run(config: BoardConfig, args: string[]): Promise<{ stdout: string; failure: string | null }> {
	const [command, ...prefix] = config.helperCommand;
	return new Promise((resolve) => {
		try {
			execFile(
				command,
				[...prefix, 'board', ...args],
				{ timeout: config.helperTimeoutMs, maxBuffer: 64 * 1024 * 1024 },
				(error, stdout, stderr) => {
					let failure: string | null = null;
					if (error) {
						// Exceeding the output limit also kills the helper, so `killed` alone is not a timeout.
						const timedOut = error.killed && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
						failure = timedOut
							? `輔助工具逾時（${config.helperTimeoutMs / 1000} 秒）`
							: stderr.trim().split('\n').at(-1) || error.message;
					}
					resolve({ stdout, failure });
				}
			);
		} catch (error) {
			// An argument that cannot be passed to a command at all, such as one holding a NUL character.
			resolve({ stdout: '', failure: (error as Error).message });
		}
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
