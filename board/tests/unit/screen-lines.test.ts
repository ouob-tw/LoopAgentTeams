// The screen's colour codes read into styled runs for the page, and the blanks that only pad a line.
import { expect, test } from 'bun:test';
import { screenLines, trimmedLines } from '../../src/lib/board/screen.ts';

const ESC = '\x1b';

test('colour codes become styles; other control sequences are dropped; a style carries to the next line', () => {
	const lines = screenLines(`${ESC}[1;31mred${ESC}[0m plain ${ESC}[38;5;4mblue\r\nstill${ESC}[0m ${ESC}[7minv${ESC}[27m${ESC}]8;;http://x${ESC}\\link${ESC}[?25h`);
	expect(lines).toEqual([
		[
			{ text: 'red', style: 'color:var(--ansi-1);font-weight:700' },
			{ text: ' plain ', style: '' },
			{ text: 'blue', style: 'color:var(--ansi-4)' }
		],
		[
			{ text: 'still', style: 'color:var(--ansi-4)' },
			{ text: ' ', style: '' },
			{ text: 'inv', style: 'color:var(--screen-bg);background:var(--screen-fg)' },
			{ text: 'link', style: '' }
		]
	]);
	expect(screenLines(`${ESC}[38;2;10;20;30;48;5;196mx`)[0]).toEqual([{ text: 'x', style: 'color:rgb(10,20,30);background:rgb(255,0,0)' }]);
});

test('blanks that only pad a line go; those with a background colour stay', () => {
	const lines = screenLines(`${ESC}[2mEsc to cancel${' '.repeat(150)}${ESC}[0m   \r\n${ESC}[44m bar   ${ESC}[0m  `);
	expect(trimmedLines(lines)).toEqual([[{ text: 'Esc to cancel', style: 'opacity:.65' }], [{ text: ' bar   ', style: 'background:var(--ansi-4)' }]]);
});
