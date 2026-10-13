// Sending a message to a controller: the text is typed into the controller's client input and
// submitted, the way the stall watcher nudges an agent. Never an HCOM message, so the controller
// treats it as the user typing in that tab. One attempt, no retry, no other channel.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ENDED_REASON, type SendResponse, type SentMessage } from '../board/messages.ts';
import type { Board } from './board.ts';
import { appendSent } from './sent-log.ts';

type Env = Record<string, string | undefined>;

/** The input command; the board appends `<HCOM name> <text> --enter`. */
function injectCommand(env: Env): string[] {
	if (!env.LAT_BOARD_INJECT_COMMAND) return ['hcom', 'term', 'inject'];
	const parsed: unknown = JSON.parse(env.LAT_BOARD_INJECT_COMMAND);
	if (!Array.isArray(parsed) || !parsed.length || parsed.some((part) => typeof part !== 'string')) {
		throw new Error('LAT_BOARD_INJECT_COMMAND must be a JSON array of strings');
	}
	return parsed;
}

function injectTimeoutMs(env: Env): number {
	const seconds = Number(env.LAT_BOARD_INJECT_TIMEOUT_SECONDS);
	// The command itself waits up to 2 seconds for the client to show the text before submitting.
	return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 15_000;
}

/**
 * The text as it is typed: the command writes it to the terminal unchanged and then sends a
 * carriage return to submit. A line feed inside the text is a new line in the client's input box;
 * a carriage return would submit early and split the message, so none may be left in it.
 */
export function typedText(text: string): string {
	return text.replace(/\r\n?/g, '\n').trimEnd();
}

/** Runs the input command once; resolves with why it failed, or null when it succeeded. */
function inject(hcomName: string, text: string, env: Env): Promise<string | null> {
	const [command, ...prefix] = injectCommand(env);
	const timeout = injectTimeoutMs(env);
	return new Promise((resolve) => {
		execFile(command, [...prefix, hcomName, text, '--enter'], { timeout }, (error, stdout, stderr) => {
			if (!error) return resolve(null);
			if (error.killed) {
				return resolve(`輸入指令逾時（${timeout / 1000} 秒），文字可能已經打進輸入框但沒有送出。`);
			}
			// The command prints its reason on standard output; standard error may only hold notices.
			const detail = stdout.trim().split('\n')[0] || stderr.trim().split('\n').at(-1) || error.message;
			resolve(`輸入到 @${hcomName} 的分頁失敗：${detail}`);
		});
	});
}

// Two messages typed into one input box at the same time would mix, so sends run one at a time.
let queue: Promise<unknown> = Promise.resolve();

export function sendMessage(
	board: Board,
	controllerId: string,
	rawText: string,
	env: Env = process.env
): Promise<{ status: number; body: SendResponse }> {
	const result = queue.then(() => attempt(board, controllerId, rawText, env));
	queue = result.catch(() => {});
	return result;
}

async function attempt(board: Board, controllerId: string, rawText: string, env: Env) {
	const text = typedText(rawText);
	// Re-read the sources first: the target must still be bound now, not when the page last heard.
	const snapshot = await board.refresh();
	const controller = snapshot.controllers.find((candidate) => candidate.id === controllerId);

	let status = 409;
	let reason: string | null;
	if (!controller) {
		reason = snapshot.errors.length
			? `無法確認主控是否仍啟用，沒有送出：${snapshot.errors.join('；')}`
			: '看板目前的資料裡沒有這個主控，沒有送出。';
	} else if (controller.status === 'ended') {
		reason = ENDED_REASON;
	} else if (/^--\S*$/.test(text)) {
		// The command takes its options from anywhere on its command line.
		reason = `「${text}」會被輸入指令當成選項而不是文字，沒有送出。`;
	} else {
		reason = await inject(controller.hcomName, text, env);
		status = reason ? 502 : 200;
	}

	const entry: SentMessage = {
		id: randomUUID(),
		kind: 'message',
		time: new Date().toISOString(),
		controllerId,
		hcomName: controller?.hcomName ?? '',
		text,
		ok: reason === null,
		error: reason
	};
	let logError: string | null = null;
	try {
		appendSent(board.config.stateDir, entry);
	} catch (error) {
		// The message was sent or refused either way; that outcome is what the page must show.
		logError = (error as Error).message;
	}
	return { status, body: { ok: entry.ok, reason, entry, logError } };
}
