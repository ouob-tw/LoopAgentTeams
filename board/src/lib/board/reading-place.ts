// Keeps what the user reads in a conversation where it is on screen while the parts around it
// change height: a message pushed at the top, a reply turning into its translation, a picture
// loading. The browser's own scroll anchoring keeps the first thing at the top of the visible area
// still, so a card there or between it and the middle growing still pushes the text being read
// down. Kept instead: what is at the middle of the visible area, down to its innermost element
// there; when that card's text was replaced, as a translated reply's is, the card after it or the
// one before. A click or key in the conversation keeps what it was on, until the user scrolls.
// Nothing is kept while the top of the conversation is in view, so a new message shows at the top
// as before.

/** Elements from a card down to the innermost one kept, each with its top on screen. */
type Chain = { element: Element; top: number }[];

export interface ReadingPlace {
	/** Take what is on screen now as the place to keep, after scrolling there on purpose. */
	retake(): void;
	stop(): void;
}

/** Keep the reading place of `list`, whose cards are its `ol`'s items, scrolling in `scroller`
 *  (null: the page). While `paused` says so, nothing is moved, and the place is taken again. */
export function keepReadingPlace(list: HTMLElement, scroller: () => HTMLElement | null, paused: () => boolean): ReadingPlace {
	/** What may be kept, first choice first. */
	let chains: Chain[] = [];

	const port = () => {
		const box = scroller();
		return box ? { top: box.getBoundingClientRect().top, height: box.clientHeight } : { top: 0, height: window.innerHeight };
	};
	const crosses = (element: Element, line: number) => {
		const rect = element.getBoundingClientRect();
		return rect.height > 0 && rect.top <= line && rect.bottom > line;
	};
	/** `card` and the elements inside it down to `inner`, or, without one, to the innermost one
	 *  that crosses `line`. */
	const chain = (card: Element, line: number, inner?: Element): Chain => {
		const found: Element[] = [card];
		if (inner) {
			for (let at: Element | null = inner; at && at !== card; at = at.parentElement) found.splice(1, 0, at);
		} else {
			for (let at: Element | undefined = card; (at = [...at.children].find((child) => crosses(child, line))); ) found.push(at);
		}
		return found.map((element) => ({ element, top: element.getBoundingClientRect().top }));
	};

	/** The card at the middle of the visible area, then the ones after and before it; none while
	 *  the conversation's top is in view. */
	function take(inner?: Element) {
		chains = [];
		const { top, height } = port();
		if (list.getBoundingClientRect().top >= top) return;
		const cards = [...list.querySelectorAll(':scope ol > li')];
		if (inner) {
			const card = cards.find((card) => card.contains(inner));
			if (card) chains = [chain(card, 0, inner)];
			return;
		}
		const line = top + height / 2;
		const at = cards.findIndex((card) => card.getBoundingClientRect().bottom > line);
		if (at < 0) return;
		chains = [chain(cards[at], line)];
		for (const near of [cards[at + 1], cards[at - 1]]) if (near) chains.push(chain(near, line, near));
	}

	const shown = (element: Element) => element.isConnected && list.contains(element);
	/** Scroll back by what the kept element moved: the first choice whose elements are all still
	 *  shown, else the first card still shown. */
	function hold() {
		if (paused()) return take();
		const whole = chains.find((chain) => chain.every(({ element }) => shown(element)));
		const kept = whole?.at(-1) ?? chains.map((chain) => chain[0]).find(({ element }) => shown(element));
		if (kept) {
			const moved = kept.element.getBoundingClientRect().top - kept.top;
			if (Math.abs(moved) >= 0.5) (scroller() ?? window).scrollBy(0, moved);
		}
		take();
	}

	const scrolled = (event: Event) => {
		const box = scroller();
		if (event.target === (box ?? document)) take();
	};
	/** A click or key in the conversation keeps what it was on in place: an opened fold opens downwards. */
	const acted = (event: Event) => {
		if (event.target instanceof Element && list.contains(event.target)) take(event.target);
	};
	addEventListener('scroll', scrolled, { capture: true, passive: true });
	addEventListener('pointerdown', acted, { capture: true, passive: true });
	addEventListener('keydown', acted, { capture: true, passive: true });
	// Size changes are told after layout and before the frame is drawn: the move is never seen.
	const observer = new ResizeObserver(hold);
	observer.observe(list);
	take();

	return {
		retake: () => take(),
		stop() {
			observer.disconnect();
			removeEventListener('scroll', scrolled, true);
			removeEventListener('pointerdown', acted, true);
			removeEventListener('keydown', acted, true);
		}
	};
}
