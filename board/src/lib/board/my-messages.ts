// 「我說過的話」: the user's own messages of a whole conversation, one short line each, newest
// first, shared by the server that collects them and the page that lists them.
import { splitAttachments } from './attachments.ts';
import type { TranscriptItem } from './transcript.ts';

/** One message the user said: where it is in the conversation, when, and its first line. */
export interface MyMessage {
	seq: number;
	time: string | null;
	line: string;
}

/** What the server answers for the list. `complete` is false while the older part of a long
 *  conversation is still being read: what is listed is the newest of it, and asking again gives more. */
export type MyMessagesUpdate = { ok: true; messages: MyMessage[]; complete: boolean } | { ok: false; reason: string };

/** The longest first line kept; the page cuts it to its width. */
export const LINE_LIMIT = 200;

/** A message's first line with something in it, cut to LINE_LIMIT characters. A message that is
 *  only attachments shows as that. */
export function firstLine(text: string): string {
	const body = splitAttachments(text);
	const line = body.body.split('\n').find((candidate) => candidate.trim())?.trim();
	return Array.from(line ?? (body.paths.length ? '（附件）' : '')).slice(0, LINE_LIMIT).join('');
}

/** The user's messages among the items, newest first. */
export function myMessages(items: readonly TranscriptItem[]): MyMessage[] {
	const found: MyMessage[] = [];
	for (const item of items) if (item.kind === 'user') found.push({ seq: item.seq, time: item.time, line: firstLine(item.text) });
	return found.sort((a, b) => b.seq - a.seq);
}
