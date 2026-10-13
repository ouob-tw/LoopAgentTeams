// Sending a message to a controller: the text is typed into the controller's client input and
// submitted, the way the stall watcher nudges an agent. Never an HCOM message, so the controller
// treats it as the user typing in that tab. One attempt, no retry, no other channel.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ENDED_REASON, type SendResponse, type SentMessage } from '../board/messages.ts';
import type { Board } from './board.ts';
import type { BoardConfig } from './config.ts';
import { listControllers } from './helper.ts';
import { appendSent } from './sent-log.ts';

/**
 * The text as it is typed: the command writes it to the terminal unchanged and then sends a
 * carriage return to submit. A line feed inside the text is a new line in the client's input box;
 * a carriage return would submit early and split the message, so none may be left in it.
 * Nothing else is changed.
 */
export function typedText(text: string): string {
	return text.replace(/\r\n?/g, '\n');
}

/** Runs the input command once; resolves with why it failed, or null when it succeeded. */
function inject(config: BoardConfig, hcomName: string, text: string): Promise<string | null> {
	const [command, ...prefix] = config.injectCommand;
	const timeout = config.injectTimeoutMs;
	const failed = (detail: string) => `輸入到 @${hcomName} 的分頁失敗：${detail}`;
	return new Promise((resolve) => {
		const done = (error: (Error & { killed?: boolean }) | null, stdout: string, stderr: string) => {
			if (!error) return resolve(null);
			if (error.killed) {
				return resolve(`輸入指令逾時（${timeout / 1000} 秒），文字可能已經打進輸入框但沒有送出。`);
			}
			// The command prints its reason on standard output; standard error may only hold notices.
			resolve(failed(stdout.trim().split('\n')[0] || stderr.trim().split('\n').at(-1) || error.message));
		};
		try {
			execFile(command, [...prefix, hcomName, text, '--enter'], { timeout }, done);
		} catch (error) {
			// Text that cannot be a command argument at all, such as one holding a NUL character.
			resolve(failed((error as Error).message));
		}
	});
}

// Two messages typed into one input box at the same time would mix, so the sends to one
// controller run one after another. Nothing is held back for later: each is attempted once.
const lastSend = new Map<string, Promise<unknown>>();

export function sendMessage(
	board: Board,
	controllerId: string,
	rawText: string
): Promise<{ status: number; body: SendResponse }> {
	const attempted = attempt.bind(null, board, controllerId, rawText);
	const result = (lastSend.get(controllerId) ?? Promise.resolve()).then(attempted, attempted);
	lastSend.set(controllerId, result);
	const forget = () => {
		if (lastSend.get(controllerId) === result) lastSend.delete(controllerId);
	};
	result.then(forget, forget);
	return result;
}

async function attempt(board: Board, controllerId: string, rawText: string) {
	const text = typedText(rawText);
	// Ask the binding registry now: the target must still be bound at this moment, whatever the
	// board's last snapshot says. A registry that cannot be read confirms nothing.
	const registry = await listControllers(board.config);
	const binding = registry.ok ? registry.controllers.find((candidate) => candidate.session_id === controllerId) : undefined;
	let hcomName = binding?.hcom_name ?? '';

	let status = 409;
	let reason: string | null;
	if (!registry.ok) {
		reason = `無法確認主控是否仍啟用，沒有送出：${registry.reason}`;
	} else if (!binding) {
		// The pages may still show it as running; the re-read also tells them otherwise.
		const known = (await board.refresh()).controllers.find((candidate) => candidate.id === controllerId);
		hcomName = known?.hcomName ?? '';
		reason = known ? ENDED_REASON : '看板目前的資料裡沒有這個主控，沒有送出。';
	} else if (/^--\S*$/.test(text)) {
		// The command takes its options from anywhere on its command line.
		reason = `「${text}」會被輸入指令當成選項而不是文字，沒有送出。`;
	} else {
		reason = await inject(board.config, hcomName, text);
		status = reason ? 502 : 200;
	}

	const entry: SentMessage = {
		id: randomUUID(),
		kind: 'message',
		time: new Date().toISOString(),
		controllerId,
		hcomName,
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
