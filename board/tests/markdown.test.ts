// Text from controllers is shown as Markdown, never as live HTML.
import { expect, test } from 'bun:test';
import { formatTime } from '../src/lib/board/format.ts';
import { renderLinks, renderMarkdown } from '../src/lib/board/markdown.ts';

test('markdown is rendered, raw HTML is escaped and unsafe links are dropped', () => {
	expect(renderMarkdown('**粗體**\n第二行')).toBe('<p><strong>粗體</strong><br>\n第二行</p>\n');
	expect(renderMarkdown('<script>alert(1)</script>')).not.toContain('<script>');
	expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('href="javascript:');
	expect(renderMarkdown('[x](https://example.com)')).toContain('target="_blank" rel="noopener noreferrer"');
});

test('times are shown without the year', () => {
	expect(formatTime('2026-10-15T05:06:07Z')).not.toContain('2026');
});

test('a title gets links for its web addresses and nothing else', () => {
	expect(renderLinks('見 http://192.0.2.10:7110/ 看 *粗* _斜_')).toBe(
		'見 <a href="http://192.0.2.10:7110/" target="_blank" rel="noopener noreferrer">http://192.0.2.10:7110/</a> 看 *粗* _斜_'
	);
	expect(renderLinks('<b>x</b> & [a](javascript:alert(1))')).toBe('&lt;b&gt;x&lt;/b&gt; &amp; [a](javascript:alert(1))');
	expect(renderLinks('javascript:alert(1) file:///etc/passwd')).not.toContain('<a');
});

test('an option body as the helper gives it renders its paragraphs and nested lists', () => {
	const html = renderMarkdown('第一段。\n\n- 子項目\n  - 更深\n\n```\ncode\n```');
	expect(html).toBe(
		'<p>第一段。</p>\n<ul>\n<li>子項目\n<ul>\n<li>更深</li>\n</ul>\n</li>\n</ul>\n<pre><code>code\n</code></pre>\n'
	);
});
