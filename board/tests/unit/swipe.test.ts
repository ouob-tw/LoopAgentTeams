// The numbers of the dock swipe: when a movement is a swipe or a scroll, how far or how fast lets go
// switch the panel, and that the panel follows the finger one to one.
import { expect, test } from 'bun:test';
import { SWIPE, settledPane, swipeDirection, swipeProgress } from '../../src/lib/board/swipe.ts';

test('the numbers are the ones the ticket names', () => {
	expect(SWIPE.directionPx).toBe(10);
	expect(SWIPE.commitFraction).toBe(0.25);
	expect(SWIPE.flingSpeed).toBe(0.3);
});

test('a direction is told within about 10px: sideways beats up and down only when it is the larger', () => {
	expect(swipeDirection(10, 0)).toBeNull();
	expect(swipeDirection(11, 0)).toBe('horizontal');
	expect(swipeDirection(-11, 4)).toBe('horizontal');
	expect(swipeDirection(0, 11)).toBe('vertical');
	expect(swipeDirection(8, 30)).toBe('vertical');
	expect(swipeDirection(12, 30)).toBe('vertical');
	expect(swipeDirection(30, 12)).toBe('horizontal');
	expect(swipeDirection(12, 12)).toBeNull();
});

test('the panel follows the finger one to one and stops at its two ends, with no damping', () => {
	const width = 400;
	expect(swipeProgress('bar', -100, width)).toBe(0.25);
	expect(swipeProgress('bar', -200, width)).toBe(0.5);
	expect(swipeProgress('keys', 100, width)).toBe(0.75);
	// Past an end it stays at the end, rather than going on slowly.
	expect(swipeProgress('bar', 80, width)).toBe(0);
	expect(swipeProgress('bar', -900, width)).toBe(1);
	expect(swipeProgress('keys', -50, width)).toBe(1);
	expect(swipeProgress('keys', 900, width)).toBe(0);
});

test('letting go past a quarter of the width, or quickly, switches; otherwise the panel goes back', () => {
	const width = 400;
	// Left from the command line, right from the keys.
	expect(settledPane('bar', -101, width, 0)).toBe('keys');
	expect(settledPane('bar', -100, width, 0)).toBe('keys');
	expect(settledPane('bar', -99, width, 0)).toBe('bar');
	expect(settledPane('keys', 100, width, 0)).toBe('bar');
	expect(settledPane('keys', 99, width, 0)).toBe('keys');
	// A quick flick switches however short, in the direction it was heading.
	expect(settledPane('bar', -20, width, -0.3)).toBe('keys');
	expect(settledPane('bar', -20, width, -0.29)).toBe('bar');
	expect(settledPane('keys', 20, width, 0.3)).toBe('bar');
	expect(settledPane('keys', 20, width, 0.29)).toBe('keys');
	// The wrong way does nothing, far or fast.
	expect(settledPane('bar', 300, width, 2)).toBe('bar');
	expect(settledPane('keys', -300, width, -2)).toBe('keys');
});
