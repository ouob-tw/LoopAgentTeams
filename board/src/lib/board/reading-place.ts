// Keeps what the user reads in a conversation where it is on screen while the parts around it
// change height: a message pushed at the top, a reply turning into its translation, a picture
// loading. The browser's own scroll anchoring keeps the first thing at the top of the visible area
// still, so a card there or between it and the middle growing still pushes the text being read
// down. Kept instead: what is at the middle of the visible area, down to its innermost element
// there; when that card's text was replaced, as a translated reply's is, the card after it or the
// one before. A click or key in a card keeps what it was on through the change it makes, an opened
// fold opening downwards. Nothing is kept while the top of the conversation is in view, so a new
// message shows at the top as before. What changes above the conversation is left to the browser.

/** How far into the conversation, in CSS pixels, still counts as at its top. */
const AT_TOP = 4;

/** What the user does that ends keeping a card scrolled to on purpose; a click or key in a card
 *  keeps what it was on instead. */
const USER_INPUT = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

/** Elements from a card down to the innermost one kept, each with its top on screen. */
type Chain = { element: Element; top: number }[];

export interface ReadingPlace {
	/** Take what is on screen now as the place to keep, after scrolling there on purpose: `card`
	 *  when given, else what is at the middle. */
	retake(card?: Element | null): void;
	stop(): void;
}

/** Keep the reading place of `list`, whose cards are its `ol`'s items, scrolling in `scroller`
 *  (null: the page). While `paused` says so, nothing is moved, and the place is taken again. */
export function keepReadingPlace(list: HTMLElement, scroller: () => HTMLElement | null, paused: () => boolean): ReadingPlace {
	/** What may be kept, first choice first. */
	let chains: Chain[] = [];
	/** The card scrolled to on purpose, kept until the user scrolls or clicks: the scroll that
	 *  placed it may be told only after. */
	let pinned: Element | null = null;
	/** How far the conversation was scrolled when the place was taken. */
	let takenAt = 0;
	const position = () => scroller()?.scrollTop ?? window.scrollY;

	/** The visible area: its top on screen and its height. */
	const visibleArea = () => {
		const box = scroller();
		return box ? { top: box.getBoundingClientRect().top, height: box.clientHeight } : { top: 0, height: window.innerHeight };
	};
	/** How far `element` is from `line`: 0 when it crosses it; none when it takes no room. */
	const distance = (element: Element, line: number) => {
		const rect = element.getBoundingClientRect();
		if (rect.height <= 0) return Infinity;
		return rect.top > line ? rect.top - line : rect.bottom <= line ? line - rect.bottom : 0;
	};
	/** Of the elements inside `element`, the one nearest `line`. */
	const nearest = (element: Element, line: number) =>
		[...element.children].reduce<Element | undefined>((best, child) => (best && distance(best, line) <= distance(child, line) ? best : child), undefined);
	/** `card` and the elements inside it down to `inner`, or, without one, to the innermost one
	 *  at `line`, or nearest it: a card whose text was replaced is told by it. */
	const chain = (card: Element, line: number, inner?: Element): Chain => {
		const found: Element[] = [card];
		if (inner) {
			for (let at: Element | null = inner; at && at !== card; at = at.parentElement) found.splice(1, 0, at);
		} else {
			for (let at: Element | undefined = card; (at = nearest(at, line)) && distance(at, line) < Infinity; ) found.push(at);
		}
		return found.map((element) => ({ element, top: element.getBoundingClientRect().top }));
	};

	/** The card at the middle of the visible area, then the ones after and before it; none while
	 *  the conversation's top is in view. */
	function take(inner?: Element) {
		chains = [];
		takenAt = position();
		const { top, height } = visibleArea();
		// A few pixels into the conversation is still its top.
		if (list.getBoundingClientRect().top >= top - AT_TOP) return;
		// The cards only, not the numbered lists inside replies.
		const cards = [...list.querySelectorAll(':scope > ol > li')];
		if (!inner && pinned?.isConnected && list.contains(pinned)) inner = pinned;
		const card = inner && cards.find((card) => card.contains(inner));
		if (card) {
			chains = [chain(card, 0, inner)];
			return;
		}
		const line = top + height / 2;
		const index = cards.findIndex((card) => card.getBoundingClientRect().bottom > line);
		if (index < 0) return;
		chains = [chain(cards[index], line)];
		for (const near of [cards[index + 1], cards[index - 1]]) if (near) chains.push(chain(near, line, near));
	}

	const shown = (element: Element) => element.isConnected && list.contains(element);
	/** What is kept: the innermost element of the first choice whose elements are all still
	 *  shown, else the first card still shown. */
	const kept = () =>
		chains.find((chain) => chain.every(({ element }) => shown(element)))?.at(-1) ?? chains.map((chain) => chain[0]).find(({ element }) => shown(element));
	/** Scroll back by what the kept element moved on screen. */
	function restore() {
		if (paused()) return take();
		const place = kept();
		const moved = place ? place.element.getBoundingClientRect().top - place.top : 0;
		if (Math.abs(moved) >= 0.5) (scroller() ?? window).scrollBy(0, moved);
		take();
	}

	/** A scroll by the user is a new place to keep. One told after the page changed, before its
	 *  size change is (the browser keeping what is at the top in place, or this scrolling back
	 *  before another change came), is not: the kept element moved within the conversation, and is
	 *  scrolled back instead. */
	const scrolled = (event: Event) => {
		if (event.target !== (scroller() ?? document)) return;
		const place = kept();
		const shifted = place ? place.element.getBoundingClientRect().top + position() - (place.top + takenAt) : 0;
		if (Math.abs(shifted) >= 0.5) restore();
		else take();
	};
	/** The user scrolling, clicking or typing ends keeping a card scrolled to on purpose. A click or
	 *  key in a card keeps what it was on in place until the next change: an opened fold opens
	 *  downwards. */
	const acted = (event: Event) => {
		pinned = null;
		if (event.target instanceof Element && list.contains(event.target)) take(event.target);
	};
	addEventListener('scroll', scrolled, { capture: true, passive: true });
	for (const type of USER_INPUT) addEventListener(type, acted, { capture: true, passive: true });
	// Size changes are told after layout and before the frame is drawn: the move is never seen.
	const observer = new ResizeObserver(restore);
	observer.observe(list);
	take();

	return {
		retake(card) {
			pinned = card ?? null;
			take();
		},
		stop() {
			observer.disconnect();
			removeEventListener('scroll', scrolled, true);
			for (const type of USER_INPUT) removeEventListener(type, acted, true);
		}
	};
}
