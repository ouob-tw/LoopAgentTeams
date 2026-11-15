// An unread inbox report seen in a conversation for a while is read: the page visible and its
// card at least half on screen (half the visible height for a card taller than that), without a
// break. Each card counts on its own. A card marked unread while on screen is left alone until
// it has been off screen once.

/** How long a card has to be seen in one go. */
export const SEEN_MS = 6_000;
/** The part of the card, or of the visible height for a taller card, that has to be on screen. */
export const SEEN_SHARE = 0.5;

export type SeenCard = { key: string; element: HTMLElement; unread: boolean };

type Watched = {
	element: HTMLElement;
	unread: boolean;
	/** On screen enough, by the last measure. */
	inSight: boolean;
	/** Marked unread while on screen: not counted until it has left the screen. */
	held: boolean;
	/** Counted to the end and handed over; not counted again until it reads read or leaves. */
	handed: boolean;
	timer?: ReturnType<typeof setTimeout>;
};

/** Whether `element` is on screen enough, inside the box it scrolls in and the window. */
export function inSight(element: HTMLElement): boolean {
	const rect = element.getBoundingClientRect();
	if (rect.height <= 0) return false;
	let top = 0;
	let bottom = window.innerHeight;
	for (let box = element.parentElement; box; box = box.parentElement) {
		if (!/(auto|scroll|hidden)/.test(getComputedStyle(box).overflowY)) continue;
		const clip = box.getBoundingClientRect();
		top = Math.max(top, clip.top);
		bottom = Math.min(bottom, clip.bottom);
	}
	return shownEnough(rect, { top, bottom });
}

/** Whether a card spanning `card` shows enough of itself inside the visible box `port` (both as
 *  tops and bottoms on screen): half the card, or half the box for a card taller than it. */
export function shownEnough(card: { top: number; bottom: number }, port: { top: number; bottom: number }): boolean {
	const shown = Math.min(card.bottom, port.bottom) - Math.max(card.top, port.top);
	return shown > 0 && shown >= SEEN_SHARE * Math.min(card.bottom - card.top, port.bottom - port.top);
}

/** Watches the unread report cards it is given and calls `onseen` with the key of each one seen
 *  long enough. `sync` takes the cards on screen now, after each change; `stop` ends it all. */
export function watchSeen(onseen: (key: string) => void) {
	const cards = new Map<string, Watched>();

	const visible = () => document.visibilityState === 'visible';
	function count(key: string, card: Watched) {
		const counting = card.inSight && card.unread && !card.held && !card.handed && visible();
		if (!counting) {
			clearTimeout(card.timer);
			card.timer = undefined;
		} else if (card.timer === undefined) {
			card.timer = setTimeout(() => {
				card.timer = undefined;
				card.handed = true;
				onseen(key);
			}, SEEN_MS);
		}
	}
	function measure() {
		for (const [key, card] of cards) {
			const now = inSight(card.element);
			// Off screen ends what a mark-unread held, and lets a mark that failed be tried again.
			if (!now) card.held = card.handed = false;
			card.inSight = now;
			count(key, card);
		}
	}

	// Told when a card crosses a few steps of being shown; scrolling and resizing measure exactly.
	const observer = new IntersectionObserver(measure, { threshold: [0, 0.25, 0.5, 0.75, 1] });
	let frame = 0;
	const soon = () => {
		if (!frame) frame = requestAnimationFrame(() => ((frame = 0), measure()));
	};
	document.addEventListener('scroll', soon, { capture: true, passive: true });
	window.addEventListener('resize', soon);
	document.addEventListener('visibilitychange', measure);

	function drop(key: string) {
		const card = cards.get(key)!;
		clearTimeout(card.timer);
		observer.unobserve(card.element);
		cards.delete(key);
	}

	return {
		sync(next: SeenCard[]) {
			const elements = new Map(next.map((card) => [card.key, card.element]));
			for (const [key, card] of [...cards]) if (elements.get(key) !== card.element) drop(key);
			for (const { key, element, unread } of next) {
				const card = cards.get(key);
				if (!card) {
					cards.set(key, { element, unread, inSight: false, held: false, handed: false });
					observer.observe(element);
					continue;
				}
				// Marked unread with the card on screen: the user wants it back, so it is not read again here.
				if (unread && !card.unread && card.inSight) card.held = true;
				if (!unread) card.handed = false;
				card.unread = unread;
			}
			measure();
		},
		stop() {
			for (const key of [...cards.keys()]) drop(key);
			observer.disconnect();
			cancelAnimationFrame(frame);
			document.removeEventListener('scroll', soon, { capture: true });
			window.removeEventListener('resize', soon);
			document.removeEventListener('visibilitychange', measure);
		}
	};
}
