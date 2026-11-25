// Links to the board's own address that would open a new window. Installed as an app on Android,
// Chrome hands such a window back to the app itself, which replaces the running board screen with
// one that holds only the link's page: closing it (X or Back) then closes the whole app (#725).
// So in the installed app these links open in the same window and Back returns to the board; in a
// browser tab, and for any other site's link, nothing changes. They never open a new window there.
//
// The board loads itself again when the user comes back, so first:
// - what is typed and not sent is written down (every state that holds text registers a keeper,
//   `keepsText`; text in any other box on the page is written down from the page), and put back
//   when the board starts again. If it cannot be written down the user stays and is told.
// - what cannot be put back (picked options, files waiting to be sent, a recording) is asked about:
//   the default is to stay; only "放棄並開啟" lets it go, and the text is kept all the same.
// - where the user was reading (#735): the message the link is in and how far down the screen it
//   was is written down, and after the board loads again and draws that message the page is scrolled
//   until it is where it was, however many messages came meanwhile.
import { TEXT_BOXES } from './build-update.ts';

export const KEPT_TEXT_KEY = 'lat-board:kept-text';

type KeptStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
interface Kept {
	at: number;
	/** Text of the boxes on the page, by what names a box. */
	texts: Record<string, string>;
	/** What the keepers wrote, by their name. */
	states: Record<string, unknown>;
}

/** A state that holds text no box on the page may show (an answer of a card not on screen, a reply
 *  box not open): it writes it down and puts it back, in this page and the one after the load. */
export interface TextKeeper {
	name: string;
	/** What to write down, or null when there is no text. Must be JSON. */
	save(): unknown | null;
	restore(data: unknown): void;
}
/** A state that cannot be put back. */
export interface Loose {
	/** What the user sees named in the prompt, shown only while `present()`. */
	label: string;
	present(): boolean;
	/** Let it go; false when that cannot be done reliably (the user then stays). */
	discard(): boolean;
}

const keepers = new Map<string, TextKeeper>();
const loose = new Set<Loose>();

function read(storage: () => KeptStorage, now = Date.now()): Kept | null {
	try {
		const kept = JSON.parse(storage().getItem(KEPT_TEXT_KEY) ?? 'null') as Kept | null;
		if (!kept) return null;
		return { at: kept.at, texts: kept.texts ?? {}, states: kept.states ?? {} };
	} catch {
		return null;
	}
}

function write(storage: () => KeptStorage, kept: Kept): void {
	if (Object.keys(kept.texts).length || Object.keys(kept.states).length) storage().setItem(KEPT_TEXT_KEY, JSON.stringify(kept));
	else storage().removeItem(KEPT_TEXT_KEY);
}

/** Register a keeper; what was written down for it before the last load is put back now. */
export function keepsText(keeper: TextKeeper, storage: () => KeptStorage = () => sessionStorage, now = Date.now()): () => void {
	keepers.set(keeper.name, keeper);
	try {
		const kept = read(storage, now);
		if (kept && keeper.name in kept.states) {
			const data = kept.states[keeper.name];
			delete kept.states[keeper.name];
			write(storage, kept);
			keeper.restore(data);
		}
	} catch {
		// Storage not available: nothing was written down.
	}
	return () => void keepers.delete(keeper.name);
}

/** Register a state that cannot be put back. Returns the function that removes it. */
export function holdsLoose(state: Loose): () => void {
	loose.add(state);
	return () => void loose.delete(state);
}

/** Whether the board runs as an installed app: the standard media query, or iOS's own flag. */
export function inInstalledApp(win: Window = window): boolean {
	const forced = (win as { __latStandalone?: boolean }).__latStandalone;
	if (typeof forced === 'boolean') return forced;
	return win.matchMedia?.('(display-mode: standalone)').matches === true || (win.navigator as { standalone?: boolean }).standalone === true;
}

/** Whether the address is on this page's own origin. */
export function isSameOrigin(href: string, win: Window = window): boolean {
	try {
		return new URL(href, win.location.href).origin === win.location.origin;
	} catch {
		return false;
	}
}

/** The page's boxes the keepers do not own (`data-kept` marks the ones they do: a second copy of
 *  their text would be put back where it was cleared or sent). What names a box across two loads of the page: its id (or label) and its place among the boxes
 *  of that name. */
function boxKeys(doc: Document): [string, HTMLElement][] {
	const seen = new Map<string, number>();
	return [...doc.querySelectorAll<HTMLElement>(TEXT_BOXES)].filter((box) => !box.hasAttribute('data-kept')).map((box) => {
		// An id names the box for good (the review item's, the answer's); a label or placeholder
		// can be shared by several boxes.
		const name = box.id ? `#${box.id}` : (box.getAttribute('aria-label') ?? box.getAttribute('name') ?? box.getAttribute('placeholder') ?? '');
		const base = `${box.tagName.toLowerCase()}|${name}`;
		const at = seen.get(base) ?? 0;
		seen.set(base, at + 1);
		return [`${base}|${at}`, box];
	});
}

function textOf(box: HTMLElement): string {
	return box instanceof HTMLInputElement || box instanceof HTMLTextAreaElement ? box.value : (box.textContent ?? '');
}

/** Write down all unsent text: the keepers' and the page's boxes'. What is still waiting for its
 *  box or state to appear (from an earlier trip) stays, unless that box is on the page now: what it
 *  shows is the user's last word. False when it could not be written down. */
export function keepTypedText(doc: Document, storage: () => KeptStorage = () => sessionStorage, now = Date.now()): boolean {
	try {
		const texts: Record<string, string> = {};
		const present = new Set<string>();
		for (const [key, box] of boxKeys(doc)) {
			present.add(key);
			if ((box as HTMLInputElement).disabled || (box as HTMLInputElement).readOnly || box.hasAttribute('data-reload-safe')) continue;
			const text = textOf(box);
			if (text.trim()) texts[key] = text;
		}
		const waiting = read(storage, now);
		const states: Record<string, unknown> = { ...waiting?.states };
		for (const keeper of keepers.values()) {
			const data = keeper.save();
			if (data === null || data === undefined) delete states[keeper.name];
			else states[keeper.name] = data;
		}
		const merged = { ...Object.fromEntries(Object.entries(waiting?.texts ?? {}).filter(([key]) => !present.has(key))), ...texts };
		write(storage, { at: now, texts: merged, states });
		return true;
	} catch {
		return false;
	}
}

/** Put the text of the page's boxes written down by `keepTypedText` back into the empty boxes, as
 *  the page draws them (a box a click opens gets its text when it opens), for as long as it is
 *  kept. */
export function restoreTypedText(doc: Document, storage: () => KeptStorage = () => sessionStorage, now = Date.now()): void {
	const saved = read(storage, now);
	if (!saved) return;
	let texts = { ...saved.texts };
	if (!Object.keys(texts).length) return;
	const fill = () => {
		let changed = false;
		for (const [key, box] of boxKeys(doc)) {
			if (!(key in texts) || textOf(box).trim()) continue;
			if (box instanceof HTMLInputElement || box instanceof HTMLTextAreaElement) box.value = texts[key]!;
			else box.textContent = texts[key]!;
			// So the page's own state (a bound value) takes it as typed.
			box.dispatchEvent(new Event('input', { bubbles: true }));
			delete texts[key];
			changed = true;
		}
		if (!Object.keys(texts).length) stop();
		else if (changed) persist();
	};
	/** What is put back is not put back again by a later load; the keepers' part and the expiry stay. */
	const persist = () => {
		try {
			const now = read(storage);
			if (now) write(storage, { at: now.at, texts, states: now.states });
		} catch {
			// Nothing more to do.
		}
	};
	let frame = 0;
	const observer = new MutationObserver(() => {
		if (!frame) frame = requestAnimationFrame(() => ((frame = 0), fill()));
	});
	function stop() {
		observer.disconnect();
		texts = {};
		persist();
	}
	observer.observe(doc.body, { childList: true, subtree: true });
	fill();
}

/** Asks the user what the page cannot put back: `labels` are the items present (named in the
 *  prompt), `blocked` the reason the text could not be written down. Answers whether to go on. */
export type Prompter = (ask: { labels: string[]; blocked: boolean }) => Promise<boolean>;
let prompter: Prompter = async () => false;
/** The prompt the page shows (LeavePrompt.svelte); without one the user always stays. */
export function setPrompter(next: Prompter): void {
	prompter = next;
}

interface Leave {
	win?: Window;
	storage?: () => KeptStorage;
	ask?: Prompter;
	/** The element the user used to leave (the link): the place to come back to is the message it is in. */
	from?: Element | null;
}

export const KEPT_PLACE_KEY = 'lat-board:kept-place';
/** How long after leaving the place is still put back. */
const PLACE_LIFE_MS = 30 * 60_000;
/** How long after the page starts the place is held, unless the user scrolls first. */
const PLACE_HOLD_MS = 6_000;
/** What names a message on the page across two loads, nearest to the link first. */
const ANCHORS = ['data-content', 'data-report-key', 'data-seq', 'data-item'];
const USER_INPUT = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

interface Place {
	at: number;
	/** The address of the page, so another page's load does not use it. */
	page: string;
	/** Selector of the message the link was in, or null when it was in none. */
	anchor: string | null;
	/** Selector of the box that scrolled, or null when the page itself did. */
	scroller: string | null;
	/** Where the message's top was on the screen; without a message, how far the box was scrolled. */
	top: number;
}

function scrollerOf(element: Element, win: Window): HTMLElement | null {
	for (let at = element.parentElement; at; at = at.parentElement) {
		if (/(auto|scroll)/.test(win.getComputedStyle(at).overflowY) && at.scrollHeight > at.clientHeight) return at;
	}
	return null;
}

function selectorOf(element: Element | null): string | null {
	if (!element) return null;
	if (element.id) return `#${CSS.escape(element.id)}`;
	const [first] = element.classList;
	return first ? `.${CSS.escape(first)}` : null;
}

/** Write down where `from` is on the page. Never stops the leaving: without a place the board
 *  simply opens at the top as before. */
export function keepPlace(win: Window, from: Element | null | undefined, storage: () => KeptStorage = () => sessionStorage, now = Date.now()): void {
	try {
		const link = from ?? win.document.activeElement;
		if (!link || link === win.document.body) return;
		let anchor: Element | null = null;
		let selector: string | null = null;
		for (let at: Element | null = link; at && !selector; at = at.parentElement) {
			const name = ANCHORS.find((attribute) => at!.hasAttribute(attribute));
			if (name) [anchor, selector] = [at, `[${name}="${CSS.escape(at.getAttribute(name)!)}"]`];
		}
		const scroller = scrollerOf(anchor ?? link, win);
		const place: Place = {
			at: now,
			page: win.location.pathname + win.location.search,
			anchor: selector,
			scroller: selectorOf(scroller),
			top: anchor ? anchor.getBoundingClientRect().top : (scroller?.scrollTop ?? win.scrollY)
		};
		storage().setItem(KEPT_PLACE_KEY, JSON.stringify(place));
	} catch {
		// Storage not available: the board opens at the top.
	}
}

/** Put the written-down place back: scroll until the message is where it was on screen, again each
 *  time the page changes (messages came, a card grew), until the user scrolls or touches the page,
 *  or the page has had its time. */
export function restorePlace(win: Window, storage: () => KeptStorage = () => sessionStorage, now = Date.now()): void {
	let place: Place | null = null;
	try {
		place = JSON.parse(storage().getItem(KEPT_PLACE_KEY) ?? 'null') as Place | null;
		storage().removeItem(KEPT_PLACE_KEY);
	} catch {
		return;
	}
	if (!place || now - place.at > PLACE_LIFE_MS || place.page !== win.location.pathname + win.location.search) return;
	const doc = win.document;
	const kept = place;
	let frame = 0;
	const align = () => {
		frame = 0;
		const box = kept.scroller ? doc.querySelector<HTMLElement>(kept.scroller) : null;
		const element = kept.anchor ? doc.querySelector(kept.anchor) : null;
		if (element) {
			const moved = element.getBoundingClientRect().top - kept.top;
			if (Math.abs(moved) >= 1) (box ?? win).scrollBy(0, moved);
		} else if (!kept.anchor) {
			// No message to find: the distance scrolled, once the page is long enough.
			const to = kept.top;
			if (box && box.scrollHeight - box.clientHeight >= to) box.scrollTop = to;
			else if (!box && doc.documentElement.scrollHeight - win.innerHeight >= to) win.scrollTo(0, to);
		}
	};
	const schedule = () => {
		if (!frame) frame = win.requestAnimationFrame(align);
	};
	const mutations = new MutationObserver(schedule);
	const sizes = new ResizeObserver(schedule);
	const stop = () => {
		mutations.disconnect();
		sizes.disconnect();
		win.removeEventListener('scroll', schedule, true);
		for (const type of USER_INPUT) win.removeEventListener(type, stop, true);
		win.clearTimeout(timer);
	};
	const timer = win.setTimeout(stop, PLACE_HOLD_MS);
	mutations.observe(doc.body, { childList: true, subtree: true });
	sizes.observe(doc.body);
	// The page's own scrolling while it starts (to the end of a conversation) is put right too.
	win.addEventListener('scroll', schedule, { capture: true, passive: true });
	for (const type of USER_INPUT) win.addEventListener(type, stop, { capture: true, passive: true });
	align();
}

/** Leave for a board address in this window. Unsent text goes along as written down; what cannot be
 *  put back asks first, and the user stays unless they say so. Resolves whether the page left. */
export async function leaveTo(href: string, { win = window, storage, ask = prompter, from }: Leave = {}): Promise<boolean> {
	const present = [...loose].filter((state) => state.present());
	if (present.length && !(await ask({ labels: [...new Set(present.map((state) => state.label))], blocked: false }))) return false;
	for (const state of present) {
		// Only the ones still there: a state another answer let go of is not asked about again.
		if (state.present() && !state.discard()) {
			await ask({ labels: [state.label], blocked: true });
			return false;
		}
	}
	if (!keepTypedText(win.document, storage)) {
		await ask({ labels: [], blocked: true });
		return false;
	}
	keepPlace(win, from, storage);
	win.location.assign(href);
	return true;
}

/** Open a board address in a new window, or, in the installed app, in this one (`leaveTo`). */
export function openOwn(href: string, options: Leave = {}): void {
	const win = options.win ?? window;
	if (inInstalledApp(win) && isSameOrigin(href, win)) void leaveTo(href, options);
	else win.open(href, '_blank', 'noopener');
}

/** The click on a link that would open a new window to the board's own address, in the installed
 *  app: open it here instead. Anything else is left to the browser. */
export function leaveOnClick(event: MouseEvent, options: Leave = {}): void {
	const win = options.win ?? window;
	if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
	const link = (event.target as Element | null)?.closest?.<HTMLAnchorElement>('a[href]');
	if (!link || link.target !== '_blank' || link.hasAttribute('download')) return;
	if (!inInstalledApp(win) || !isSameOrigin(link.href, win)) return;
	event.preventDefault();
	void leaveTo(link.href, { ...options, from: link });
}

/** Start: put back what was written down, and watch the clicks. */
export function watchLinks(win: Window = window): void {
	if (inInstalledApp(win)) {
		restoreTypedText(win.document);
		restorePlace(win);
	}
	win.document.addEventListener('click', (event) => leaveOnClick(event, { win }));
}
