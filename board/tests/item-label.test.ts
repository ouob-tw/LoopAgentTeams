import { expect, test } from 'bun:test';
import { itemLabel, type InboxItem } from '../src/lib/board/types.ts';

test('each inbox item kind has its own label: 待決 for questions, 求助 for HELP, 完成 for DONE', () => {
	const label = (item: object) => itemLabel(item as InboxItem);
	expect(label({ kind: 'question' })).toBe('待決');
	expect(label({ kind: 'report', tag: 'HELP' })).toBe('求助');
	expect(label({ kind: 'report', tag: 'DONE' })).toBe('完成');
});
