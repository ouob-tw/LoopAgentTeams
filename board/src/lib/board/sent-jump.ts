// The jump from a sent-log entry to the message it typed into the conversation: which entries
// went into the conversation and as what text, and where that text is among the user's messages.
import type { SentEntry } from './answers.ts';
import { latCommand } from './launch.ts';
import type { TranscriptView } from './transcript.ts';

/** What to look for in a controller's conversation: the text typed in, from when it was sent. */
export interface SentLook {
	/** When it was sent, in ms. */
	at: number;
	text: string;
}

/** How long before its sent time a message may be recorded: the clocks of the board and the client
 *  differ a little. */
export const SENT_BEFORE_MS = 60_000;
/** How long after: a busy client records a typed message only when its turn ends. */
export const SENT_AFTER_MS = 30 * 60_000;

/** What an entry typed into the conversation, as it was typed; null for one that typed nothing in:
 *  an answer (written to the question file), a model switch, an interrupt, or a message or wake
 *  that was not delivered. */
export function sentLook(entry: SentEntry): SentLook | null {
	const at = Date.parse(entry.time);
	if (entry.kind === 'message') return entry.ok ? { at, text: entry.text } : null;
	if (entry.kind === 'wake') return entry.text && entry.outcome !== 'failed' && entry.outcome !== 'refused' ? { at, text: entry.text } : null;
	if (entry.kind === 'launch') return entry.role === 'agent' ? (entry.text ? { at, text: entry.text } : null) : { at, text: latCommand(entry.client, entry.text) };
	return null;
}

/** The text with its white space evened out: the client drops a trailing space, and line ends
 *  may differ. */
const plain = (text: string) => text.trim().replace(/\s+/g, ' ');

/**
 * Where the sent text is in the conversation, as the user message's `seq`: a message with the
 * same text recorded from a minute before it was sent to half an hour after, the nearest in time.
 * Undefined while the pages loaded do not reach back that far, even with one found: an earlier
 * one may be nearer. Null once they do and none fits.
 */
export function sentPlace(view: TranscriptView, look: SentLook): number | null | undefined {
	const first = view.items[0]?.time;
	if (view.before !== null && !(first && Date.parse(first) < look.at - SENT_BEFORE_MS)) return undefined;
	const text = plain(look.text);
	let best: { seq: number; distance: number } | null = null;
	for (const item of view.items) {
		if (item.kind !== 'user' || !item.time) continue;
		const time = Date.parse(item.time);
		if (time < look.at - SENT_BEFORE_MS || time > look.at + SENT_AFTER_MS || plain(item.text) !== text) continue;
		const distance = Math.abs(time - look.at);
		if (!best || distance < best.distance) best = { seq: item.seq, distance };
	}
	return best?.seq ?? null;
}

/** Why the sent text was not found in a conversation read far enough back. */
export function sentMissText(view: TranscriptView, look: SentLook): string {
	const latest = view.items.findLast((item) => item.time)?.time;
	if (!latest || Date.parse(latest) < look.at) return '送出後對話紀錄還沒有新內容，可能還沒送達';
	return '送出後半小時內沒有文字相同的一句，主控收到的文字可能不同';
}
