// Which chat message asked a panel question, from the cases shared with the Herdr side panel.
import { expect, test } from 'bun:test';
import fixture from './fixtures/question-message-match.json';
import { askedTogether, askingReport } from '../src/lib/board/question-message.ts';
import type { InboxItem, InboxQuestion } from '../src/lib/board/types.ts';

for (const entry of fixture.cases) {
	test(entry.name, () => {
		const found = askingReport(entry.session_id, entry.question, entry.reports);
		expect(found).toBe(entry.expected === null ? null : entry.reports[entry.expected]);
	});
}

const message = { time: '2026-10-18T10:00:00Z', message: '說明。\n\nDECIDE: B-1 r2, A-1 r1 · 兩題 · 回答面板上的題目' };
const asked = (id: string, revision: number, askedIn = message, controllerId = 's1') =>
	({ kind: 'question', key: `q:${controllerId}:${id}`, controllerId, question: { id, revision }, askedIn }) as unknown as InboxQuestion;

test('the questions one message asked come together in its order; others of the inbox do not', () => {
	const [a, b] = [asked('A-1', 1), asked('B-1', 2)];
	const inbox: InboxItem[] = [
		a,
		asked('C-1', 1, { ...message, time: '2026-10-18T09:00:00Z' }),
		asked('B-1', 2, message, 's2'),
		b,
		{ kind: 'report', key: 'r:1' } as InboxItem
	];
	expect(askedTogether(a, inbox)).toEqual([b, a]);
	expect(askedTogether(b, inbox)).toEqual([b, a]);
	// Alone in its message, or in none found: only itself.
	expect(askedTogether(a, [a])).toEqual([a]);
	const lone = asked('D-1', 1, null as never);
	expect(askedTogether(lone, [lone, a])).toEqual([lone]);
});
