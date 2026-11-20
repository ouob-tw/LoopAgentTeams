// A page whose script files are gone (the board was built again while it stayed open) or whose
// download broke off (the network changed) cannot go on: it is loaded again, once. A reload that
// fails the same way soon after shows the error instead, so a file that is really missing never
// reloads the page over and over.

/** A second failure within this long after a reload does not reload again. */
export const MODULE_RELOAD_WINDOW_MS = 60_000;
export const MODULE_RELOAD_KEY = 'lat-board:module-reload';

/** The messages browsers give a script module that could not be loaded. */
const MODULE_LOAD_FAILURES = [
	/^Failed to fetch dynamically imported module: /, // Chrome
	/^error loading dynamically imported module/, // Firefox
	/^Importing a module script failed\.$/, // Safari
	/^Unable to preload CSS for /, // Vite's preload of a style sheet
	/^Failed to load module script: / // a script the server answers with something else
];

export function isModuleLoadFailure(error: unknown): boolean {
	const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
	return MODULE_LOAD_FAILURES.some((pattern) => pattern.test(message));
}

/** Whether to reload the page for a failure now. Yes, and remembered for this tab, unless the last
 *  such reload was within the window; a tab whose storage cannot be used never reloads, as it
 *  could not tell a second time from the first. */
export function claimModuleReload(storage: Pick<Storage, 'getItem' | 'setItem'>, now: number): boolean {
	try {
		const last = Number(storage.getItem(MODULE_RELOAD_KEY));
		if (Number.isFinite(last) && last > 0 && now - last >= 0 && now - last < MODULE_RELOAD_WINDOW_MS) return false;
		storage.setItem(MODULE_RELOAD_KEY, String(now));
		return true;
	} catch {
		return false;
	}
}
