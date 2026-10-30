// Sending a message to a controller: the text is typed into the controller's client input and
// submitted, the way the stall watcher nudges an agent. Never an HCOM message, so the controller
// treats it as the user typing in that tab. One attempt, no retry, no other channel. A controller
// whose HCOM link is paused is typed into through Herdr instead, as an agent hcom does not reach.
import { randomUUID } from 'node:crypto';
import { CLOSED_REASON, ENDED_REASON, UNKNOWN_CONTROLLER_REASON, type SendResponse, type SentMessage } from '../board/messages.ts';
import type { Board } from './board.ts';
import type { BoardConfig } from './config.ts';
import { runCommand } from './external.ts';
import { listControllers } from './helper.ts';
import { agentCommand } from './herdr.ts';
import { isClosed, isPaused } from './model.ts';
import { appendSent } from './sent-log.ts';
import { everyController } from '../board/types.ts';

/**
 * The text as it is typed: the command writes it to the terminal unchanged and then sends a
 * carriage return to submit. A line feed inside the text is a new line in the client's input box;
 * a carriage return would submit early and split the message, so none may be left in it.
 * Nothing else is changed.
 */
export function typedText(text: string): string {
	return text.replace(/\r\n?/g, '\n');
}

/**
 * What a Codex controller is given for a message that starts with `/lat`: Codex mentions a skill
 * with `$lat`, and `/lat` means nothing to it. Only a leading `/lat` followed by white space or the
 * end is changed; `/latest` and a `/lat` inside the text are not. Every other client gets the text
 * as it is. Every message the board types into a controller goes through here.
 */
export function forClient(client: string, text: string): string {
	return client === 'codex' ? text.replace(/^\/lat(?=\s|$)/, '$$lat') : text;
}

// The input command reads these as its own flags when one is a whole argument, wherever it stands
// (there is no way to mark an argument as text: after `--` the `--` itself is typed too). `--enter`
// is dropped, `--help` and `-h` print usage and type nothing, `--name` takes the next argument and
// `--go` is swallowed. Any other text, option-like or not, is typed as given.
const OWN_FLAGS = new Set(['--help', '-h', '--name', '--go', '--enter']);

/**
 * The input command's argument lists, in order, that together type the text and submit once. The
 * text is one argument and one call, except text that is exactly one of the command's own flags:
 * its first character goes first, then the rest with the submit, so the client's input box ends up
 * holding the very same characters.
 */
export function injectCalls(text: string): string[][] {
	if (!OWN_FLAGS.has(text)) return [[text, '--enter']];
	return [[text.slice(0, 1)], [text.slice(1), '--enter']];
}

/** Runs one call of the input command; resolves with why it failed, or null when it succeeded. */
async function runInject(config: BoardConfig, hcomName: string, args: string[]): Promise<string | null> {
	const timeout = config.injectTimeoutMs;
	// The command prints its reason on standard output; standard error may only hold notices.
	const run = await runCommand(config.injectCommand, [hcomName, ...args], { timeoutMs: timeout, failureFrom: 'stdout-first' });
	if (run.failure === null) return null;
	if (run.timedOut) return `輸入指令逾時（${timeout / 1000} 秒），文字可能已經打進輸入框但沒有送出。`;
	return `輸入到 @${hcomName} 的分頁失敗：${run.failure}`;
}

/** Types the text into the controller's input box and submits it. One attempt per call, and no
 *  call after one that failed. Resolves with why it failed, or null when it succeeded. */
export async function inject(config: BoardConfig, hcomName: string, text: string): Promise<string | null> {
	for (const args of injectCalls(text)) {
		const reason = await runInject(config, hcomName, args);
		if (reason) return reason;
	}
	return null;
}

// Two messages typed into one input box at the same time would mix, and two wakes could resume
// one conversation twice, so the sends and wakes of one controller run one after another. Nothing
// is held back for later: each is attempted once.
const lastSend = new Map<string, Promise<unknown>>();

/** Run `attempted` after everything already queued for this controller has finished. */
export function queued<T>(controllerId: string, attempted: () => Promise<T>): Promise<T> {
	const result = (lastSend.get(controllerId) ?? Promise.resolve()).then(attempted, attempted);
	lastSend.set(controllerId, result);
	const forget = () => {
		if (lastSend.get(controllerId) === result) lastSend.delete(controllerId);
	};
	result.then(forget, forget);
	return result;
}

export function sendMessage(
	board: Board,
	controllerId: string,
	rawText: string
): Promise<{ status: number; body: SendResponse }> {
	return queued(controllerId, () => attempt(board, controllerId, rawText));
}

/** Whether the controller's client is gone from hcom's list. The last read may have listed hcom
 *  before the controller was bound or came back, so it is refused only on a read begun now. */
async function closedNow(board: Board, controllerId: string): Promise<boolean> {
	if (!isClosed(await board.sources(), controllerId)) return false;
	await board.refresh();
	return isClosed(await board.sources(), controllerId);
}

async function attempt(board: Board, controllerId: string, rawText: string) {
	const client = everyController(await board.current()).find((candidate) => candidate.id === controllerId)?.client ?? '';
	const text = forClient(client, typedText(rawText));
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
		reason = known ? ENDED_REASON : UNKNOWN_CONTROLLER_REASON;
	} else if (await closedNow(board, controllerId)) {
		// Its client is gone from hcom's list: there is no input box to type into; the page wakes it.
		reason = CLOSED_REASON;
	} else if (isPaused(await board.sources(), controllerId)) {
		const sources = await board.sources();
		const pane = sources.agents.find((agent) => agent.id === controllerId)?.herdr.pane || binding.herdr_pane;
		const act = await agentCommand(board.config, ['prompt', pane, text]);
		reason = act.ok ? null : `HCOM 通訊暫停中，改由 Herdr 輸入也沒有送出：${act.reason}`;
		status = reason ? 502 : 200;
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
