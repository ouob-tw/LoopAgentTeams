// Text from controllers is shown as Markdown, never as live HTML.
import { expect, test } from 'bun:test';
import { formatTime } from '../src/lib/board/format.ts';
import { renderMarkdown } from '../src/lib/board/markdown.ts';

test('markdown is rendered, raw HTML is escaped and unsafe links are dropped', () => {
	expect(renderMarkdown('**粗體**\n第二行')).toBe('<p><strong>粗體</strong><br>\n第二行</p>\n');
	expect(renderMarkdown('<script>alert(1)</script>')).not.toContain('<script>');
	expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('href="javascript:');
	expect(renderMarkdown('[x](https://example.com)')).toContain('target="_blank" rel="noopener noreferrer"');
});

test('times are shown without the year', () => {
	expect(formatTime('2026-10-15T05:06:07Z')).not.toContain('2026');
});
