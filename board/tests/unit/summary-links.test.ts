import { expect, test } from 'bun:test';
import { summaryParts } from '../../src/lib/board/summary-links.ts';

const ISSUE = 'https://github.com/ouob-tw/LoopAgentTeams-work/issues/426';

test('a Markdown link to a web address becomes a link part; the text around it is kept as written', () => {
	expect(summaryParts(`看 [#426](${ISSUE}) 與 [#427](http://example.com/a?b=1&c=2) 完成`)).toEqual([
		{ text: '看 ' },
		{ text: '#426', href: ISSUE },
		{ text: ' 與 ' },
		{ text: '#427', href: 'http://example.com/a?b=1&c=2' },
		{ text: ' 完成' }
	]);
	expect(summaryParts(`[#1](${ISSUE})`)).toEqual([{ text: '#1', href: ISSUE }]);
});

test('text without a link stays one plain part, HTML characters and backticks untouched', () => {
	expect(summaryParts('a <b> & `c` **d**')).toEqual([{ text: 'a <b> & `c` **d**' }]);
	expect(summaryParts('')).toEqual([]);
});

test('a link to another scheme, or with no address, stays plain text', () => {
	for (const text of ['[x](javascript:alert)', '[x](data:text/html,hi)', '[x](ftp://host/a)', '[x]()', '[x](not a url)', '[x](/relative)']) {
		expect(summaryParts(text)).toEqual([{ text }]);
	}
	expect(summaryParts(`[bad](javascript:x) [ok](${ISSUE})`)).toEqual([{ text: '[bad](javascript:x) ' }, { text: 'ok', href: ISSUE }]);
});

test('link text that holds markup is returned as text for the page to escape', () => {
	expect(summaryParts(`[<img src=x onerror=1>](${ISSUE})`)).toEqual([{ text: '<img src=x onerror=1>', href: ISSUE }]);
});
