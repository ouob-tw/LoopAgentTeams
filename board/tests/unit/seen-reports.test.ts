// The half-on-screen rule of a report card seen in a conversation (seen-reports.ts).
import { expect, test } from 'bun:test';
import { shownEnough } from '../../src/lib/board/seen-reports.ts';

const port = { top: 0, bottom: 800 };

test('a card counts once half of it is on screen, not before', () => {
	// 200 px tall, its top 80 / 99 / 100 / 120 px above the bottom: 40%, 49.5%, 50%, 60% shown.
	expect(shownEnough({ top: 720, bottom: 920 }, port)).toBe(false);
	expect(shownEnough({ top: 701, bottom: 901 }, port)).toBe(false);
	expect(shownEnough({ top: 700, bottom: 900 }, port)).toBe(true);
	expect(shownEnough({ top: 680, bottom: 880 }, port)).toBe(true);
	// Cut by the top edge the same way.
	expect(shownEnough({ top: -120, bottom: 80 }, port)).toBe(false);
	expect(shownEnough({ top: -100, bottom: 100 }, port)).toBe(true);
	expect(shownEnough({ top: 100, bottom: 300 }, port)).toBe(true);
	expect(shownEnough({ top: 900, bottom: 1100 }, port)).toBe(false);
});

test('a card taller than the visible box counts once it fills half the box, though under half of it shows', () => {
	// 3000 px tall: 400 px shown is half the box but only 13% of the card.
	expect(shownEnough({ top: 400, bottom: 3400 }, port)).toBe(true);
	expect(shownEnough({ top: 401, bottom: 3401 }, port)).toBe(false);
	expect(shownEnough({ top: -1000, bottom: 2000 }, port)).toBe(true);
	// The box is the scrolling box's part of the window, not the window.
	expect(shownEnough({ top: 500, bottom: 3500 }, { top: 200, bottom: 700 })).toBe(false);
	expect(shownEnough({ top: 450, bottom: 3450 }, { top: 200, bottom: 700 })).toBe(true);
});
