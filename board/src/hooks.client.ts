// Chrome keeps ten frames of a stack by default, all of them Svelte's own when a page fails deep
// inside it: the page's component that started it was never in the report. Set before anything
// else runs here; as many as the server keeps (MAX_FRAMES in client-errors.ts).
Error.stackTraceLimit = 50;

import { version } from '$app/env';
import { page } from '$app/state';
import type { HandleClientError } from '@sveltejs/kit/hooks';
import { claimReloadForFailure, watchBuild } from '#lib/board/build-update.ts';
import { watchLinks } from '#lib/board/link-open.ts';
import { claimModuleReload, isModuleLoadFailure } from '#lib/board/module-reload.ts';

// A page left open across a deploy loads the new build once it is safe (build-update.ts).
watchBuild({ own: version });
// Links to the board's own address open in this window when installed as an app (link-open.ts).
watchLinks();

// Errors in the browser never reach the server by themselves: the page shows "Internal Error" and
// the journal says nothing. Each one is sent to the board's log; the server decides what of it is
// safe to keep (see client-errors.ts) and how many. A report that cannot be sent is dropped.
const MAX_STACK = 8_000;

/** The page's SvelteKit route id (`/`, `/login`): a name in the code, never the address. */
function routeId(): string | null {
	try {
		return page.route.id;
	} catch {
		return null;
	}
}

function report(kind: string, error: unknown, route = routeId()) {
	const failure = error instanceof Error ? error : null;
	const body = JSON.stringify({
		kind,
		type: failure?.name ?? typeof error,
		message: failure ? failure.message : String(error),
		stack: failure?.stack?.slice(0, MAX_STACK) ?? null,
		// Without the query and fragment, which may hold anything.
		url: location.origin + location.pathname,
		route,
		// The build this page runs: the server logs only whether it is its own.
		version
	});
	// Not through api.ts: a report must never reload the page, not even for a device logged out.
	fetch('/api/client-error', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
}

/** A script file that could not be loaded: the page is loaded again, once (module-reload.ts). */
function reloadAfter(error: unknown): void {
	if (isModuleLoadFailure(error) && claimModuleReload(() => sessionStorage, Date.now())) location.reload();
}

window.addEventListener('error', (event) => {
	report('error', event.error ?? event.message);
	reloadAfter(event.error ?? event.message);
});
window.addEventListener('unhandledrejection', (event) => {
	report('unhandledrejection', event.reason);
	reloadAfter(event.reason);
});
// Vite's own preloading of a page's scripts and styles; the failure is the reload's to handle,
// unless a reload did not help just before, when it goes on as an error.
window.addEventListener('vite:preloadError', (event) => {
	report('preloadError', (event as Event & { payload?: unknown }).payload);
	if (!claimModuleReload(() => sessionStorage, Date.now())) return;
	event.preventDefault();
	location.reload();
});

/** Only what the page's own code threw: not-found and the like are not failures. */
export const handleError: HandleClientError = async ({ kind, error, event }) => {
	if (kind !== 'unknown') return;
	// A navigation's target route; the first page's own failure has none yet.
	report('handleError', error, event.route.id ?? routeId());
	reloadAfter(error);
	// Old code that cannot read the new server's data: the new build, once, rather than the error page.
	if (await claimReloadForFailure()) location.reload();
};

// A page the browser keeps for its back button keeps its live feeds open, and over HTTP/1.1 a
// browser opens at most six connections to the board: two or three such pages leave none for the
// page in view. Kept pages stop loading; one brought back is loaded again, its feeds with it.
window.addEventListener('pagehide', (event) => {
	if (event.persisted) window.stop();
});
window.addEventListener('pageshow', (event) => {
	if (event.persisted) location.reload();
});
