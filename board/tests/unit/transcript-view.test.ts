// How the information page shows a conversation: operations folded between texts, one line per
// operation when opened, and pages joined without repeating or dropping a text.
import { expect, test } from 'bun:test';
import {
	segments,
	toolLine,
	toolsSummary,
	withEarlier,
	withLatest,
	type TranscriptItem,
	type TranscriptPage,
	type TranscriptTool
} from '../../src/lib/board/transcript.ts';

const say = (seq: number, kind: 'user' | 'assistant' = 'assistant'): TranscriptItem => ({ seq, kind, time: null, text: `第 ${seq} 段` });
const op = (seq: number, overrides: Partial<TranscriptTool> = {}): TranscriptTool => ({
	seq,
	kind: 'tool',
	time: null,
	name: 'Bash',
	label: '執行指令',
	detail: 'git status',
	error: false,
	...overrides
});
const page = (items: TranscriptItem[], before: number | null = null): TranscriptPage => ({ items, before, skipped: 0 });
const seqs = (items: TranscriptItem[]) => items.map((item) => item.seq);

test('the operations between two texts fold into one line that counts them', () => {
	const shown = segments([say(0, 'user'), op(1), op(2), op(3), say(4), op(5), say(6)]);
	expect(shown.map((segment) => segment.kind)).toEqual(['text', 'tools', 'text', 'tools', 'text']);
	const first = shown[1];
	expect(first.kind === 'tools' && toolsSummary(first.items)).toBe('⋯ 做了 3 個操作');
	expect(shown[3].kind === 'tools' && toolsSummary(shown[3].items)).toBe('⋯ 做了 1 個操作');
});

test('a group keeps its key as more operations arrive, so an opened group stays open', () => {
	const before = segments([say(0), op(1)]);
	const after = segments([say(0), op(1), op(2)]);
	expect(after[1].key).toBe(before[1].key);
});

test('an opened group shows one summary line per operation, a failed one marked', () => {
	expect(toolLine(op(1))).toBe('🔧 執行指令：git status');
	expect(toolLine(op(2, { name: 'Write', label: '寫檔', detail: 'src/a.ts', error: true }))).toBe('✗ 🔧 寫檔：src/a.ts');
	expect(toolLine(op(3, { name: 'TodoWrite', label: 'TodoWrite', detail: '' }))).toBe('🔧 TodoWrite');
	expect(toolLine(op(4, { name: 'hcom', label: '收到 hcom 通知', detail: '' }))).toBe('📨 收到 hcom 通知');
	expect(toolLine(op(5, { name: 'hook', label: 'hook 提示', detail: '' }))).toBe('🪝 hook 提示');
});

test('a newer latest page replaces only its own part, keeping earlier pages loaded', () => {
	let view = withLatest(null, page([say(10), op(11), say(12)], 10));
	view = withEarlier(view, page([say(0), op(1), say(5), op(6)]), 10);
	expect(seqs(view.items)).toEqual([0, 1, 5, 6, 10, 11, 12]);
	expect(view.before).toBeNull();

	// The same texts again plus what was added since, as the latest page now reads.
	view = withLatest(view, page([say(10), op(11), say(12), op(13), say(14)], 10));
	expect(seqs(view.items)).toEqual([0, 1, 5, 6, 10, 11, 12, 13, 14]);
	expect(view.before).toBeNull();

	// The latest page moved on past older texts it no longer holds; they stay as loaded.
	view = withLatest(view, page([say(12), op(13), say(14), say(15)], 12));
	expect(seqs(view.items)).toEqual([0, 1, 5, 6, 10, 11, 12, 13, 14, 15]);
});

test('when more changed than one page holds, only the new page is kept and older ones load again', () => {
	const view = withLatest(withLatest(null, page([say(0), say(1)])), page([say(90), say(91)], 90));
	expect(seqs(view.items)).toEqual([90, 91]);
	expect(view.before).toBe(90);
});

test('an earlier page never repeats what is already loaded', () => {
	const view = withEarlier(withLatest(null, page([say(5), say(6)], 5)), page([say(3), op(4), say(5)], 3), 5);
	expect(seqs(view.items)).toEqual([3, 4, 5, 6]);
	expect(view.before).toBe(3);
});

test('an earlier page that arrives after the latest page jumped ahead is dropped, leaving no gap', () => {
	const texts = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => say(from + index));
	// 50–99 loaded; 載入更早 asks for the page before 50.
	let view = withLatest(null, page(texts(50, 99), 50));
	const requested = view.before!;
	// Meanwhile so much was written that the latest page now starts at 151.
	view = withLatest(view, page(texts(151, 200), 151));
	expect(view.before).toBe(151);

	// The slow answer for the old cursor (0–49) comes back.
	const after = withEarlier(view, page(texts(0, 49)), requested);

	expect(seqs(after.items)).toEqual(seqs(texts(151, 200)));
	expect(after.before).toBe(151);
});
