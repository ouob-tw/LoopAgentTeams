import { expect, test } from 'bun:test';
import { itemLabel, type InboxItem } from '../../src/lib/board/types.ts';

test('each inbox item kind has its own label: 待決 for questions, 已回答 once answered, 求助 for HELP, 完成 for DONE', () => {
	const label = (item: object) => itemLabel(item as InboxItem);
	expect(label({ kind: 'question', question: { status: 'pending' } })).toBe('待決');
	expect(label({ kind: 'question', question: { status: 'submitted' } })).toBe('待決');
	expect(label({ kind: 'question', question: { status: 'recorded' } })).toBe('已回答');
	expect(label({ kind: 'report', tag: 'HELP' })).toBe('求助');
	expect(label({ kind: 'report', tag: 'DONE' })).toBe('完成');
});
