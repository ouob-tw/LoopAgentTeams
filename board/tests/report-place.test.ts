// Where an opened report sits in its controller's conversation.
import { expect, test } from 'bun:test';
import { reportPlace, type TranscriptItem, type TranscriptView } from '../src/lib/board/transcript.ts';

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

test('still unknown while earlier pages may hold it; found once they reach back far enough', () => {
	const recent = [text(10, '2026-10-17T09:58:00Z', '別的話')];
	expect(reportPlace(view(recent, 9), report)).toBeUndefined();
	const reachesBack = [text(5, '2026-10-17T09:00:00Z', '更早'), ...recent];
	expect(reportPlace(view(reachesBack, 4), report)).toBe(10);
});
