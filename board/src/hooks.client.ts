import type { HandleClientError } from '@sveltejs/kit/hooks';

// Errors in the browser never reach the server by themselves: the page shows "Internal Error" and
// the journal says nothing. Each one is sent to the board's log; the server decides what of it is
// safe to keep (see client-errors.ts) and how many. A report that cannot be sent is dropped.
const MAX_STACK = 8_000;

function report(kind: string, error: unknown) {
	const failure = error instanceof Error ? error : null;
	const body = JSON.stringify({
		kind,
		type: failure?.name ?? typeof error,
		message: failure ? failure.message : String(error),
		stack: failure?.stack?.slice(0, MAX_STACK) ?? null,
		// Without the query and fragment, which may hold anything.
		url: location.origin + location.pathname
	});
	fetch('/api/client-error', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
}

window.addEventListener('error', (event) => report('error', event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => report('unhandledrejection', event.reason));

/** Only what the page's own code threw: not-found and the like are not failures. */
export const handleError: HandleClientError = ({ kind, error }) => {
	if (kind === 'unknown') report('handleError', error);
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
