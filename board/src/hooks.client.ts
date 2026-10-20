import type { HandleClientError } from '@sveltejs/kit/hooks';

// Errors in the browser never reach the server by themselves: the page shows "Internal Error" and
// the journal says nothing. Each one is sent to the board's log; the server limits how many it keeps.
// A report that cannot be sent is dropped.
const MAX_STACK = 8_000;

function report(kind: string, error: unknown) {
	const failure = error instanceof Error ? error : null;
	const body = JSON.stringify({
		kind,
		message: failure ? `${failure.name}: ${failure.message}` : String(error),
		stack: failure?.stack?.slice(0, MAX_STACK) ?? null,
		url: location.href
	});
	fetch('/api/client-error', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
}

window.addEventListener('error', (event) => report('error', event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => report('unhandledrejection', event.reason));

/** Only what the page's own code threw: not-found and the like are not failures. */
export const handleError: HandleClientError = ({ kind, error }) => {
	if (kind === 'unknown') report('handleError', error);
};
