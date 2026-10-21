// A conversation's texts are rendered as Markdown once each: a push that brings one new text
// renders that one, not every text loaded before it.
import { expect, test } from 'bun:test';
import { RenderedMarkdown, renderMarkdown } from '../src/lib/board/markdown.ts';
import { withLatest, type TranscriptItem, type TranscriptView } from '../src/lib/board/transcript.ts';

const text = (seq: number, words = `第 ${seq} 則`): TranscriptItem => ({ seq, kind: 'assistant', time: null, text: words });

/** Render every text of the view, as the conversation list does on each push. */
const renderAll = (view: TranscriptView, markdown: RenderedMarkdown) =>
	view.items.map((item) => (item.kind === 'tool' ? '' : markdown.html(item.seq, item.text)));

test('a push adding one text renders only that text', () => {
	let rendered = 0;
	const markdown = new RenderedMarkdown((source) => (rendered++, renderMarkdown(source)));
	const first = Array.from({ length: 50 }, (_, index) => text(index + 1));
	let view = withLatest(null, { items: first, before: null, skipped: 0 });
	const html = renderAll(view, markdown);
	expect(rendered).toBe(50);

	view = withLatest(view, { items: [...first, text(51)], before: null, skipped: 0 });
	const again = renderAll(view, markdown);
	expect(rendered).toBe(51);
	expect(again.slice(0, 50)).toEqual(html);
	expect(again[50]).toBe(renderMarkdown('第 51 則'));
});

test('a text whose words changed under the same seq is rendered again; clearing forgets every one', () => {
	let rendered = 0;
	const markdown = new RenderedMarkdown((source) => (rendered++, renderMarkdown(source)));
	expect(markdown.html(1, '**a**')).toBe(renderMarkdown('**a**'));
	expect(markdown.html(1, '**a**')).toBe(renderMarkdown('**a**'));
	expect(rendered).toBe(1);
	expect(markdown.html(1, '**b**')).toBe(renderMarkdown('**b**'));
	expect(rendered).toBe(2);
	markdown.clear();
	markdown.html(1, '**b**');
	expect(rendered).toBe(3);
});

test('a push that brings nothing new keeps the same view, so nothing is worked out again', () => {
	const items = Array.from({ length: 5 }, (_, index) => text(index + 1));
	const view = withLatest(null, { items, before: null, skipped: 0 });
	// The usage alone changed: the same items again, as new objects.
	expect(withLatest(view, { items: structuredClone(items), before: null, skipped: 0, usage: null })).toBe(view);
	expect(withLatest(view, { items: [...items, text(6)], before: null, skipped: 0 })).not.toBe(view);
	expect(withLatest(view, { items: [...items.slice(0, 4), text(5, '改過')], before: null, skipped: 0 })).not.toBe(view);
	expect(withLatest(view, { items, before: null, skipped: 1 })).not.toBe(view);
	// An empty conversation pushed again stays the same view too.
	const empty = withLatest(null, { items: [], before: null, skipped: 0 });
	expect(withLatest(empty, { items: [], before: null, skipped: 0 })).toBe(empty);
});
