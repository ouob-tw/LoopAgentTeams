// Which chat message asked a panel question, from the cases shared with the Herdr side panel.
import { expect, test } from 'bun:test';
import fixture from '../fixtures/question-message-match.json';
import { askedTogether, askingNote, askingReport, askingTexts, justRecorded, withAnswered } from '../../src/lib/board/question-message.ts';
import type { InboxItem, InboxQuestion } from '../../src/lib/board/types.ts';

for (const entry of fixture.cases) {
	test(entry.name, () => {
		const found = askingReport(entry.session_id, entry.question, entry.reports);
		expect(found).toBe(entry.expected === null ? null : entry.reports[entry.expected]);
	});
	// The same message read from the controller's own conversation, in its order, before any report.
	test(`conversation: ${entry.name}`, () => {
		const own = entry.reports
			.map((report, index) => ({ report, index }))
			.filter(({ report }) => report.session_id === entry.session_id)
			.toSorted((a, b) => Date.parse(a.report.time) - Date.parse(b.report.time));
		const texts = own.map(({ report, index }) => ({ seq: index, time: report.time, text: report.message }));
		const { id, revision, asked_at } = entry.question;
		const question = { kind: 'question', key: 'q', time: asked_at, question: { id, revision } } as unknown as InboxQuestion;
		const found = [...askingTexts(texts, [question])].map(([seq, asked]) => [seq, asked.length]);
		expect(found).toEqual(entry.expected === null ? [] : [[entry.expected, 1]]);
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

test("a conversation's texts each show the inbox questions they asked, in the order they name them", () => {
	const at = (seq: number, text: string, time: string | null = null) => ({ seq, time, text });
	const [a, b, c] = [asked('A-1', 1), asked('B-1', 2), asked('C-1', 1)];
	const texts = [
		at(1, message.message),
		at(2, '後來又問一次。\n\nHELP: C-1 r1 · 一題'),
		at(4, '只是提到 C-1 r1。'),
		at(6, '再問一次。\n\nHELP: C-1 r1 · 一題')
	];
	// A question goes to the latest text that asked it; a question no text asked is in none.
	expect([...askingTexts(texts, [a, c, b, asked('D-1', 1)])]).toEqual([
		[1, [b, a]],
		[6, [c]]
	]);
	// Not in the inbox: the text asked nothing that is shown.
	expect(askingTexts(texts, []).size).toBe(0);
});

test('a question both in the inbox and answered is listed once, as the inbox has it', () => {
	const inbox = asked('A-1', 1);
	const recorded = { ...asked('A-1', 1), unsent: false } as InboxQuestion;
	const other = asked('B-1', 2);
	expect(withAnswered([inbox], [recorded, other])).toEqual([inbox, other]);
	expect(askedTogether(inbox, withAnswered([inbox], [recorded, other])).map((entry) => entry.key)).toEqual(['q:s1:B-1', 'q:s1:A-1']);
});

test('a question that left the inbox as recorded stays, recorded, until the answered list is read again', () => {
	const sent = { ...asked('A-1', 1), unsent: false, question: { id: 'A-1', revision: 1, status: 'submitted', answer: 'A. 甲' } } as unknown as InboxQuestion;
	const other = asked('B-1', 2, message, 's2');
	const removed = asked('C-1', 1);
	const kept = asked('D-1', 1);
	const left = justRecorded([sent, other, removed, kept], { inbox: [kept], recordedKeys: [sent.key, other.key] }, 's1');
	// Only this controller's, only the recorded ones: a question removed for another reason goes.
	expect(left.map((item) => [item.key, item.question.status, item.question.answer])).toEqual([[sent.key, 'recorded', 'A. 甲']]);
	expect(justRecorded([sent], { inbox: [sent], recordedKeys: [] }, 's1')).toEqual([]);
});

test('an asking message shows what it says above its tag line, and nothing when it is only the tag line', () => {
	expect(askingNote('我看完了。\n\n- 第一點\n- 第二點\n\nDECIDE: A-1 r1 · 一題 · 回答面板上的題目\n')).toBe('我看完了。\n\n- 第一點\n- 第二點');
	expect(askingNote('HELP: A-1 r1 · 卡住了')).toBe('');
	expect(askingNote('  \n\nDECIDE: A-1 r1, B-1 r2\n\n')).toBe('');
});
