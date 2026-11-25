// Links to the board's own address that would open a new window. Installed as an app on Android,
// Chrome hands such a window back to the app itself, which replaces the running board screen with
// one that holds only the link's page: closing it (X or Back) then closes the whole app (#725).
// So in the installed app these links open in the same window and Back returns to the board; in a
// browser tab, and for any other site's link, nothing changes.
//
// The board loads itself again when the user comes back, so what is typed and not sent is written
// down first and put back (as the new-build reload waits for it, build-update.ts). Where something
// cannot be put back (an open dialog, answer choices, attached files, a recording) the link keeps
// opening a new window.
import { TEXT_BOXES, unsavableBlocker } from './build-update.ts';

export const KEPT_TEXT_KEY = 'lat-board:kept-text';
/** A written-down text is put back only if the user comes back within this long. */
export const KEPT_TEXT_MS = 30 * 60_000;

type KeptStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

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

/** What names a box across two loads of the page: its kind, its label and its place among the
 *  boxes of that name. */
function boxKeys(doc: Document): [string, HTMLElement][] {
	const seen = new Map<string, number>();
	return [...doc.querySelectorAll<HTMLElement>(TEXT_BOXES)].map((box) => {
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

/** Write down what is typed and not sent. False when the page holds something that cannot be put
 *  back, or the text cannot be written down: the page must then not be left this way. */
export function keepTypedText(doc: Document, storage: () => KeptStorage = () => sessionStorage, now = Date.now()): boolean {
	if (unsavableBlocker(doc)) return false;
	const texts: Record<string, string> = {};
	const present = new Set<string>();
	for (const [key, box] of boxKeys(doc)) {
		present.add(key);
		if ((box as HTMLInputElement).disabled || (box as HTMLInputElement).readOnly || box.hasAttribute('data-reload-safe')) continue;
		const text = textOf(box);
		if (text.trim()) texts[key] = text;
	}
	try {
		// Text still waiting for its box to open (a reply box) stays, unless its box is on the page
		// now: what the box shows is then the user's last word.
		const waiting = readKept(storage, now);
		const merged = { ...Object.fromEntries(Object.entries(waiting?.texts ?? {}).filter(([key]) => !present.has(key))), ...texts };
		if (Object.keys(merged).length) storage().setItem(KEPT_TEXT_KEY, JSON.stringify({ at: waiting && Object.keys(texts).length === 0 ? waiting.at : now, texts: merged }));
		else storage().removeItem(KEPT_TEXT_KEY);
		return true;
	} catch {
		return false;
	}
}

function readKept(storage: () => KeptStorage, now: number): { at: number; texts: Record<string, string> } | null {
	const saved = JSON.parse(storage().getItem(KEPT_TEXT_KEY) ?? 'null') as { at: number; texts: Record<string, string> } | null;
	return saved && now - saved.at <= KEPT_TEXT_MS ? saved : null;
}

/** Put the text written down by `keepTypedText` back into the empty boxes of the page, as the page
 *  draws them (a box a click opens, such as a review reply, gets its text when it opens), for as
 *  long as the text is kept. */
export function restoreTypedText(doc: Document, storage: () => KeptStorage = () => sessionStorage, now = Date.now()): void {
	let texts: Record<string, string>;
	let saved: { at: number; texts: Record<string, string> } | null;
	try {
		saved = JSON.parse(storage().getItem(KEPT_TEXT_KEY) ?? 'null') as { at: number; texts: Record<string, string> } | null;
		if (!saved || now - saved.at > KEPT_TEXT_MS) {
			storage().removeItem(KEPT_TEXT_KEY);
			return;
		}
		texts = { ...saved.texts };
	} catch {
		return;
	}
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
		else if (changed) {
			// What is put back is not put back again by a later load, the expiry stays.
			try {
				storage().setItem(KEPT_TEXT_KEY, JSON.stringify({ at: saved!.at, texts }));
			} catch {
				// Nothing more to do.
			}
		}
	};
	let frame = 0;
	const observer = new MutationObserver(() => {
		if (!frame) frame = requestAnimationFrame(() => ((frame = 0), fill()));
	});
	function stop() {
		observer.disconnect();
		try {
			storage().removeItem(KEPT_TEXT_KEY);
		} catch {
			// Nothing more to do.
		}
	}
	observer.observe(doc.body, { childList: true, subtree: true });
	setTimeout(stop, Math.max(0, saved!.at + KEPT_TEXT_MS - now));
	fill();
}

interface Leave {
	win?: Window;
	storage?: () => KeptStorage;
}

/** Open a board address in a new window, or, in the installed app, in this one. Returns whether
 *  the page is being left in this window. */
export function openOwn(href: string, { win = window, storage }: Leave = {}): boolean {
	if (inInstalledApp(win) && isSameOrigin(href, win) && keepTypedText(win.document, storage)) {
		win.location.assign(href);
		return true;
	}
	win.open(href, '_blank', 'noopener');
	return false;
}

/** The click on a link that would open a new window to the board's own address, in the installed
 *  app: make it open here. Anything else is left to the browser. */
export function leaveOnClick(event: MouseEvent, { win = window, storage }: Leave = {}): void {
	if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
	const link = (event.target as Element | null)?.closest?.<HTMLAnchorElement>('a[href]');
	if (!link || link.target !== '_blank' || link.hasAttribute('download')) return;
	if (!inInstalledApp(win) || !isSameOrigin(link.href, win)) return;
	if (!keepTypedText(win.document, storage)) return;
	event.preventDefault();
	win.location.assign(link.href);
}

/** Start: put back what was written down, and watch the clicks. */
export function watchLinks(win: Window = window): void {
	if (inInstalledApp(win)) restoreTypedText(win.document);
	win.document.addEventListener('click', (event) => leaveOnClick(event, { win }));
}
