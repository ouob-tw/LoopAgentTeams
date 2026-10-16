// Messages the user sends to a controller from the board: the shared shapes, and the two rules
// the page applies before anything is sent (who a command line is for, what Enter does).
import { isEnded, STATUS_LABEL, type Controller } from './types.ts';

/** One line of the board's sent log: an attempt to type a message into a controller's client. */
export interface SentMessage {
	id: string;
	kind: 'message';
	time: string;
	/** The controller's session ID. */
	controllerId: string;
	hcomName: string;
	text: string;
	ok: boolean;
	/** Why it was not delivered; null when it was. */
	error: string | null;
}

/** What `POST /api/messages` answers for every attempt it made or refused. */
export interface SendResponse {
	ok: boolean;
	reason: string | null;
	entry: SentMessage;
	/** Set when the attempt could not be written to the sent log. */
	logError: string | null;
}

export const ENDED_REASON = '這個主控已結束，無法傳話。';
export const CLOSED_REASON = '這個主控已關閉，無法傳話。';
export const UNKNOWN_CONTROLLER_REASON = '看板目前的資料裡沒有這個主控，沒有送出。';

/**
 * Enter makes a new line (and only the button sends) on the narrow layout, or when the main input
 * is touch and no pointer can hover. A laptop with a touch screen has a mouse or trackpad as its
 * main pointer, so Enter sends there.
 */
export const ENTER_NEWLINE_QUERY = '(max-width: 760px), ((pointer: coarse) and (any-hover: none))';

type EnterKey = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'isComposing' | 'keyCode'>;

/** Whether this key press sends the message instead of being typed. */
export function sendsOnEnter(event: EnterKey, enterMakesNewline: boolean): boolean {
	// 229 is what browsers report for a key the input method is still handling; Safari reports the
	// Enter that confirms a candidate that way with `isComposing` already false.
	if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return false;
	return !enterMakesNewline && !event.shiftKey;
}

type Target = Pick<Controller, 'id' | 'hcomName' | 'status'>;

export type Command<T extends Target> = { ok: true; controller: T; text: string } | { ok: false; reason: string };

/**
 * Who a command line is for: a leading `@name` picks that controller, otherwise the one that is
 * open. Never falls back to another controller. An ended or closed controller is refused unless
 * the caller `wakes` it instead of sending.
 */
export function parseCommand<T extends Target>(input: string, controllers: T[], open: T | undefined, wakes = false): Command<T> {
	const addressed = /^@(\S*)\s*([\s\S]*)$/.exec(input.trimStart());
	let controller = open;
	let text = input;
	if (addressed) {
		const name = addressed[1];
		const matches = controllers.filter((candidate) => candidate.hcomName === name);
		// A name can be reused after a controller ended; the one still running is the one meant.
		controller = matches.find((candidate) => !isEnded(candidate.status)) ?? matches[0];
		if (!controller) return { ok: false, reason: `找不到主控 @${name}，沒有送出。` };
		text = addressed[2];
	}
	if (!controller) return { ok: false, reason: '請用 @名稱 指定主控，或先點開一個主控。' };
	if (isEnded(controller.status) && !wakes) {
		return { ok: false, reason: `@${controller.hcomName} ${STATUS_LABEL[controller.status]}，無法傳話。` };
	}
	if (!text.trim()) return { ok: false, reason: '請輸入要傳的訊息。' };
	return { ok: true, controller, text };
}
