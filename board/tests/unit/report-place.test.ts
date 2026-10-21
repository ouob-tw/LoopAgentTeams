// Where an opened report sits in its controller's conversation.
import { expect, test } from 'bun:test';
import { questionPlace, reportPlace, type TranscriptItem, type TranscriptView } from '../../src/lib/board/transcript.ts';
import type { InboxQuestion } from '../../src/lib/board/types.ts';

const text = (seq: number, time: string | null, body: string, kind: 'user' | 'assistant' = 'assistant'): TranscriptItem => ({ seq, kind, time, text: body });
const view = (items: TranscriptItem[], before: number | null = null): TranscriptView => ({ items, before, skipped: 0 });
const report = { time: '2026-10-17T10:00:00Z', message: '  DONE: 做完了\n' };

test('the text equal to the report is taken, the one nearest its time when several are', () => {
	const items = [
		text(1, '2026-10-16T10:00:00Z', 'DONE: 做完了'),
		text(2, '2026-10-17T09:59:50Z', 'DONE: 做完了'),
		text(3, '2026-10-17T09:59:55Z', 'DONE: 做完了', 'user')
	];
	expect(reportPlace(view(items), report)).toBe(2);
});

test('without an equal text, the last assistant text in the five minutes before the report', () => {
	const items = [text(1, '2026-10-17T09:56:00Z', '別的話'), text(2, '2026-10-17T09:58:00Z', '最後一段'), text(3, '2026-10-17T10:01:00Z', '之後')];
	expect(reportPlace(view(items), report)).toBe(2);
	expect(reportPlace(view([text(1, '2026-10-17T09:50:00Z', '太早了')]), report)).toBeNull();
});

test('still unknown while earlier pages may hold an equal text; the near one once they reach an hour back', () => {
	const recent = [text(10, '2026-10-17T09:58:00Z', '別的話')];
	expect(reportPlace(view(recent, 9), report)).toBeUndefined();
	// Past the five minutes but not the hour: an equal text may still be further back.
	const pastNear = [text(8, '2026-10-17T09:30:00Z', '更早'), ...recent];
	expect(reportPlace(view(pastNear, 7), report)).toBeUndefined();
	const withEqual = [text(6, '2026-10-17T09:20:00Z', 'DONE: 做完了'), ...pastNear];
	expect(reportPlace(view(withEqual, 5), report)).toBe(6);
	const reachesHour = [text(5, '2026-10-17T08:50:00Z', '更早'), ...pastNear];
	expect(reportPlace(view(reachesHour, 4), report)).toBe(10);
});

const question = (time: string | null, askedIn: { time: string; message: string } | null = null) =>
	({ kind: 'question', key: 'q', time, question: { id: 'X-1', revision: 2 }, askedIn }) as unknown as InboxQuestion;
const asking = (seq: number, time: string, revision = 2) => text(seq, time, `說明。\n\nDECIDE: X-1 r${revision} · 標題`);

test('a question is at the latest text that asked its revision, never a near one', () => {
	const asked = question('2026-10-17T10:00:00Z');
	const ended = '2026-10-17T10:05:00Z';
	expect(questionPlace(view([asking(1, '2026-10-17T10:01:00Z'), asking(3, '2026-10-17T10:03:00Z')]), asked, ended)).toBe(3);
	// The r1 message, or one just before, is not it.
	const others = [asking(1, '2026-10-17T09:59:00Z', 1), text(2, '2026-10-17T10:01:00Z', '別的話')];
	expect(questionPlace(view(others), asked, ended)).toBeNull();
});

test('a question not found is pending until the turn that asked it ends, then searched back to when it was asked', () => {
	const asked = question('2026-10-17T10:00:00Z');
	const recent = [text(10, '2026-10-17T10:01:00Z', '別的話')];
	// No report since it was asked: its message is still to come, whatever is loaded.
	expect(questionPlace(view(recent, 9), asked, null)).toBe('pending');
	expect(questionPlace(view(recent, 9), asked, '2026-10-17T09:59:59Z')).toBe('pending');
	// Reported since: unknown while earlier pages may hold the message, null once they reach back.
	expect(questionPlace(view(recent, 9), asked, '2026-10-17T10:00:00Z')).toBeUndefined();
	expect(questionPlace(view([text(8, '2026-10-17T10:00:00Z', '更早'), ...recent], 7), asked, '2026-10-17T10:02:00Z')).toBeNull();
	expect(questionPlace(view(recent), asked, '2026-10-17T10:02:00Z')).toBeNull();
});

test('a question not known to have been asked when is searched back to its asking report, or to the start', () => {
	const recent = [text(10, '2026-10-17T10:01:00Z', '別的話')];
	expect(questionPlace(view(recent, 9), question(null), null)).toBeUndefined();
	expect(questionPlace(view(recent), question(null), null)).toBeNull();
	const reported = question(null, { time: '2026-10-17T10:01:00Z', message: 'DECIDE: X-1 r2 · 標題' });
	expect(questionPlace(view(recent, 9), reported, null)).toBeNull();
});
