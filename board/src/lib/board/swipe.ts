// The phone's dock switches between the command line and the 按鍵面板 by a sideways swipe. The numbers
// that make it light to use live here, so the page and its tests read the same ones.

export const SWIPE = {
	/** A pointer moving this far sideways, further than it moved up or down, is a swipe; the other way round, a scroll. */
	directionPx: 10,
	/** Let go past this share of the dock's width and the other panel stays. */
	commitFraction: 0.25,
	/** Or let go moving this fast in px per ms, however short the way. */
	flingSpeed: 0.3,
	/** A speed counts the movement of this many ms before letting go. */
	flingWindowMs: 100
} as const;

export type Pane = 'bar' | 'keys';

/** What the first movement of a pointer means: null while it is still too small to tell. */
export function swipeDirection(dx: number, dy: number): 'horizontal' | 'vertical' | null {
	const across = Math.abs(dx);
	const down = Math.abs(dy);
	if (across > SWIPE.directionPx && across > down) return 'horizontal';
	if (down > SWIPE.directionPx && down > across) return 'vertical';
	return null;
}

/** Which panel shows once a swipe that began on `from` is let go, after moving `dx` px sideways
 *  (left is negative) over a dock `width` wide, at `speed` px/ms (left negative). The command line
 *  gives way to the keys by going left, the keys to the command line by going right. */
export function settledPane(from: Pane, dx: number, width: number, speed: number): Pane {
	const toKeys = from === 'bar' ? dx <= -SWIPE.commitFraction * width || speed <= -SWIPE.flingSpeed : false;
	const toBar = from === 'keys' ? dx >= SWIPE.commitFraction * width || speed >= SWIPE.flingSpeed : false;
	if (from === 'bar') return toKeys ? 'keys' : 'bar';
	return toBar ? 'bar' : 'keys';
}

/** How far across the keys are, 0 for the command line to 1 for the keys, for a swipe that began on `from`
 *  and has moved `dx` px: one to one with the finger, stopping at the two ends. */
export function swipeProgress(from: Pane, dx: number, width: number): number {
	if (width <= 0) return from === 'keys' ? 1 : 0;
	return Math.min(1, Math.max(0, (from === 'keys' ? 1 : 0) - dx / width));
}
