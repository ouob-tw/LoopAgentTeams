// A page left open across a deploy keeps running the old build's code against the new server,
// which may send it data that code cannot read. SvelteKit notices a new version, but only acts on
// it at a full navigation, and the board's page never does one. So the page asks the server which
// build it serves (now and then, when the tab is shown again and when the live feed comes back:
// a deploy restarts the server) and loads itself again once it runs another build: at once when
// nothing would be lost, else as soon as the text is sent or cleared, the answer draft or files
// sent or dropped, the recording ended, the dialog closed or the drag let go. It loads itself again
// only once for a build, so a page that still differs after that (a server that announces a build
// before it serves it) does not reload over and over; the next restart allows one more.

/** How often an open page asks which build the server serves. */
export const BUILD_CHECK_MS = 60_000;
/** While a reload waits for a safe moment, how often it looks again: a box the page clears
 *  itself after sending fires no event. */
export const SAFE_RETRY_MS = 1_000;
export const BUILD_RELOAD_KEY = 'lat-board:build-reload';
/** SvelteKit's own file naming the build the server serves (see `kit.version`). */
export const VERSION_PATH = '/_app/version.json';

type TabStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Whether to load the page again for the server's build `target` now. Yes, and remembered for
 *  this tab, unless it already did for that build; a tab whose storage cannot be used never
 *  reloads, as it could not tell a second time from the first. */
export function claimBuildReload(storage: () => TabStorage, target: string): boolean {
	try {
		const tab = storage();
		if (tab.getItem(BUILD_RELOAD_KEY) === target) return false;
		tab.setItem(BUILD_RELOAD_KEY, target);
		return true;
	} catch {
		return false;
	}
}

/** The build the server serves now; null when it cannot be read (the server is down, say). */
export async function servedBuild(read: typeof fetch = fetch): Promise<string | null> {
	try {
		const response = await read(VERSION_PATH, { cache: 'no-store' });
		if (!response.ok) return null;
		const body: unknown = await response.json();
		const version = body && typeof body === 'object' ? (body as { version?: unknown }).version : null;
		return typeof version === 'string' && version ? version : null;
	} catch {
		return null;
	}
}

/** Checks of what the page holds that a reload would lose and no text box shows (answer drafts,
 *  attached files, a recording), each added by the state that holds it. */
const holders = new Set<() => boolean>();

/** Add a check of whether this state holds unsent work now; a reload waits while any says so. */
export function holdsUnsent(check: () => boolean): void {
	holders.add(check);
}

/** Text boxes whose content a reload would lose. One marked `data-reload-safe` shows a value the
 *  page has saved already, and holds the reload only while it is being typed in. */
const TEXT_BOXES = 'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="url"], input[type="email"], input[type="tel"], [contenteditable]:not([contenteditable="false"])';
/** What a reload would close under the user's hands. */
const DIALOGS = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';

/** Why a reload has to wait now, or null when nothing would be lost. */
export function reloadBlocker(document: Document, pressed: boolean): 'text' | 'unsent' | 'dialog' | 'drag' | null {
	if (pressed) return 'drag';
	if (document.querySelector(DIALOGS)) return 'dialog';
	if ([...holders].some((holds) => holds())) return 'unsent';
	for (const box of document.querySelectorAll<HTMLElement>(TEXT_BOXES)) {
		if ((box as HTMLInputElement).disabled || (box as HTMLInputElement).readOnly) continue;
		if (box.hasAttribute('data-reload-safe') && box !== document.activeElement) continue;
		const text = box instanceof HTMLInputElement || box instanceof HTMLTextAreaElement ? box.value : box.textContent;
		if (text?.trim()) return 'text';
	}
	return null;
}

interface WatchOptions {
	/** The build this page runs (`version` from `$app/env`). */
	own: string;
	storage?: () => TabStorage;
	reload?: () => void;
	read?: typeof fetch;
	checkMs?: number;
}

let watch: { check(): Promise<void>; own: string; storage: () => TabStorage; read: typeof fetch } | undefined;

/** Allow one more reload for whatever build the server serves (see `checkBuild`). */
function forgetReload(storage: () => TabStorage): void {
	try {
		storage().setItem(BUILD_RELOAD_KEY, '');
	} catch {
		// Storage that cannot be used never reloads anyway.
	}
}

/** Start watching for a new build; once per page, in the browser (hooks.client.ts). */
export function watchBuild({ own, storage = () => sessionStorage, reload = () => location.reload(), read = fetch, checkMs = BUILD_CHECK_MS }: WatchOptions): void {
	if (watch) return;
	/** The newer build the page waits to load, once it is safe. */
	let target: string | null = null;
	let pressed = false;
	let retry: ReturnType<typeof setTimeout> | undefined;

	const attempt = () => {
		clearTimeout(retry);
		if (!target) return;
		if (reloadBlocker(document, pressed)) {
			retry = setTimeout(attempt, SAFE_RETRY_MS);
			return;
		}
		const claimed = claimBuildReload(storage, target);
		// Loaded again for it already and still not on it: stays as it is.
		target = null;
		if (claimed) reload();
	};
	const soon = () => setTimeout(attempt, 0);

	watch = {
		own,
		storage,
		read,
		async check() {
			const served = await servedBuild(read);
			if (!served || served === own || served === target) return;
			target = served;
			attempt();
		}
	};
	setInterval(() => void watch!.check(), checkMs);
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') void watch!.check();
	});
	// Capturing: a component that stops an event still lets the page notice it.
	addEventListener('pointerdown', () => (pressed = true), true);
	// A press let go outside the window ends without a pointerup here.
	for (const name of ['pointerup', 'pointercancel', 'dragend', 'blur'])
		addEventListener(name, () => {
			pressed = false;
			soon();
		}, true);
	for (const name of ['input', 'change', 'submit', 'close', 'keyup', 'focusout']) addEventListener(name, soon, true);
}

/** Ask the server which build it serves now; nothing before `watchBuild`. After a server restart
 *  (the live feed came back) one more reload is allowed: the build the page loaded again for may
 *  have been announced before the server that serves it was started. */
export function checkBuild({ restarted = false }: { restarted?: boolean } = {}): void {
	if (!watch) return;
	if (restarted) forgetReload(watch.storage);
	void watch.check();
}

/** For a page that failed: whether it runs another build than the server's and may load itself
 *  again for it now (once per build, shared with the watch). The page is already broken, so
 *  nothing is waited for. */
export async function claimReloadForFailure(): Promise<boolean> {
	if (!watch) return false;
	const served = await servedBuild(watch.read);
	return !!served && served !== watch.own && claimBuildReload(watch.storage, served);
}
