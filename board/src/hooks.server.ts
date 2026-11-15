import { isHttpError, isRedirect, json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import type { Handle, HandleServerError, ServerInit } from '@sveltejs/kit/hooks';
import { randomUUID } from 'node:crypto';
import { DEVICE_COOKIE } from '#lib/server/auth.ts';
import { getBoard } from '#lib/server/board.ts';
import { actingAs } from '#lib/server/acting.ts';
import { clientAddress, viaHttps } from '#lib/server/client-address.ts';
import { findDevice, markSeen, saveSeen } from '#lib/server/devices.ts';
import { isDemoPath, securityHeaders } from '#lib/server/security-headers.ts';
import { testDeviceRefusal } from '#lib/server/test-device.ts';
import { exceptionFields, log, withRequestId } from '#lib/server/log.ts';
import { redact, secretsOf } from '#lib/server/redact.ts';

export const init: ServerInit = () => {
	const board = getBoard();
	void board.refresh();
	// Open event streams would otherwise hold the server open after a stop signal. The devices' last
	// requests of the past minute are written down so a restart does not shorten their idle time.
	for (const signal of ['SIGINT', 'SIGTERM'] as const)
		process.once(signal, () => {
			board.close();
			try {
				saveSeen(board.config.stateDir);
			} catch (error) {
				log('ERROR', 'board.devices', 'last_seen_unsaved', exceptionFields(error));
			}
		});
};

// Everything except the login screens and their endpoints needs a logged-in device.
const OPEN_PATHS = new Set([
	'/login',
	'/api/login',
	'/api/login/totp',
	'/api/login/passkey',
	'/api/login/passkey/options',
	'/api/login/enroll',
	'/api/login/enroll/options',
	'/api/login/passwordless',
	'/api/login/passwordless/options',
	'/api/login/passkey-error',
	'/login/test',
	'/api/login/test'
]);

// The user's own stylesheet: the last thing in the head, so it comes after every built-in style and
// nothing is painted without it. It is not part of the page's own markup: browser extensions add
// and move nodes next to stylesheets before the page takes over, which breaks taking over markup
// that contains one. The server answers with an empty sheet when there is none.
const USER_STYLE = '<link rel="stylesheet" href="/user.css" />';

// A caller's own request id is kept when it looks like one.
const REQUEST_ID = /^[\w.:-]{1,128}$/;
const MAX_REASON = 2000;

/** Take the user's text and token out of what a log line repeats; see redact.ts. The request body
 *  is read only when a line needs it, from a copy, whatever its content type. */
function redactorFor(event: RequestEvent): (text: string) => Promise<string> {
	const token = event.cookies.get(DEVICE_COOKIE);
	const copy = event.request.body ? event.request.clone() : null;
	let secrets: Promise<string[]> | undefined;
	return async (text) => redact(text, await (secrets ??= (copy ? copy.text().catch(() => null) : Promise.resolve(null)).then((body) => secretsOf(body, token))));
}

function requestIdOf(event: RequestEvent): string {
	const given = event.request.headers.get('x-request-id');
	return given && REQUEST_ID.test(given) ? given : randomUUID();
}

const where = (event: RequestEvent) => ({ method: event.request.method, path: event.url.pathname });

async function reason(event: RequestEvent, value: unknown): Promise<string | undefined> {
	if (typeof value !== 'string' || !value) return undefined;
	const text = await event.locals.redact(value);
	return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON)}…` : text;
}

/** One line for a response with a server-side status: its reasons as the page was told them. */
async function logFailure(event: RequestEvent, response: Response) {
	const body: Record<string, unknown> | null = response.headers.get('content-type')?.includes('application/json')
		? await response.clone().json().catch(() => null)
		: null;
	log('ERROR', 'board.http', 'http_error', {
		...where(event),
		status: response.status,
		reason: await reason(event, body?.reason),
		error: await reason(event, body?.error),
		logError: await reason(event, body?.logError),
		// SvelteKit's own error body; `message` is the log line's event name.
		detail: await reason(event, body?.message)
	});
}

const seeOther = (location: string) => new Response(null, { status: 303, headers: { location } });

/**
 * A page opened from outside the board (an installed app started from the home screen, a link in
 * another app or site) arrives without the login cookie, which is SameSite=Strict. Such a request
 * gets a page that loads the same address again from itself: that load is same-origin, so the
 * browser sends the cookie. The page holds no data and names no address: it loads its own full
 * address, so it cannot send the browser anywhere else (a path alone would, read as `//host/...`).
 * The fragment is left out, since loading an address with one would only scroll. A same-origin
 * request without the cookie, and one without these headers (an old browser, curl), goes to the
 * login screen as before, so this happens at most once.
 */
function openedFromOutside(request: Request): boolean {
	const site = request.headers.get('sec-fetch-site');
	return request.headers.get('sec-fetch-mode') === 'navigate' && site !== null && site !== 'same-origin';
}

const RELOAD_PAGE = '<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>LAT</title><script>location.replace(location.href.split("#")[0])</script>';
/** Reload pages answered: under /demo too, one goes out without the demo sandbox, which would make
 *  its reload a cross-site one that again comes without the cookie. It is the board's own markup. */
const reloads = new WeakSet<Response>();
const reloadFromHere = () => {
	const page = new Response(RELOAD_PAGE, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
	reloads.add(page);
	return page;
};

/** The response with the security headers. The built server's connection guard
 *  (instrumentation.server.ts) set them already, but a header SvelteKit writes replaces it: here a
 *  route's own policy (an attached file's sandbox) is joined with the board's, and every answer
 *  under /demo, the login redirect included, gets the demo headers. */
function secured(response: Response, https: boolean, demo: boolean): Response {
	const apply = (headers: Headers) => {
		for (const [name, value] of securityHeaders(https, headers.get('content-security-policy'), demo)) headers.set(name, value);
	};
	try {
		apply(response.headers);
		return response;
	} catch {
		// A response whose headers cannot change, such as one passed on from fetch.
		const copy = new Response(response.body, response);
		apply(copy.headers);
		return copy;
	}
}

export const handle: Handle = async ({ event, resolve }) => {
	const { config } = getBoard();
	// The connection's own address, whatever ADDRESS_HEADER says; `vite dev` has no Node request.
	const peer = event.platform?.req?.socket.remoteAddress ?? event.getClientAddress();
	const https = viaHttps(peer, event.request.headers.get('x-forwarded-proto'), config.trustedProxies);
	const demo = isDemoPath(event.url.pathname);
	// The built server refused it before anything was served (instrumentation.server.ts); `vite dev`
	// has no such guard, so the check is made here too.
	if (!config.allowedSources.has(peer)) {
		log('WARNING', 'board.http', 'source_refused', { ...where(event), peer });
		return secured(new Response('Forbidden', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } }), https, demo);
	}
	event.locals.clientAddress = clientAddress(peer, event.request.headers.get('x-forwarded-for'), config.trustedProxies);
	event.locals.https = https;
	const response = await handleAllowed({ event, resolve });
	return secured(response, https, demo && !reloads.has(response));
};

const handleAllowed: Handle = ({ event, resolve }) => {
	event.locals.requestId = requestIdOf(event);
	event.locals.redact = redactorFor(event);
	return withRequestId(event.locals.requestId, async () => {
		let response: Response;
		try {
			const token = event.cookies.get(DEVICE_COOKIE);
			const board = getBoard();
			const now = board.config.now();
			const device = token ? findDevice(board.config.stateDir, token, now) : null;
			if (device) {
				try {
					markSeen(board.config.stateDir, device, now);
				} catch (error) {
					// The time is kept in memory and written again a minute later; the request goes on.
					log('ERROR', 'board.devices', 'last_seen_unsaved', exceptionFields(error));
				}
			}
			event.locals.device = device;

			const path = event.url.pathname;
			if (!device && !OPEN_PATHS.has(path)) {
				if (path.startsWith('/api/')) return json({ error: 'unpaired' }, { status: 401 });
				if (openedFromOutside(event.request)) return reloadFromHere();
				return seeOther('/login');
			}
			if (device && path === '/login') return seeOther('/');
			// A test device's change is checked against what it may do before any route runs.
			const refusal = device && (await testDeviceRefusal(board.config, device, event.request.method, event.route.id, event.request));
			if (refusal) return refusal;
			// Only a logged-in device can fetch the stylesheet, so only its pages refer to it.
			response = await actingAs(device, () =>
				resolve(event, {
					transformPageChunk: ({ html }) => html.replace('%lat.user-style%', device ? USER_STYLE : '')
				})
			);
		} catch (error) {
			// Thrown here, before or around resolving: SvelteKit answers with a 500 (or the error's own
			// status) after this, where nothing else sees it.
			const status = isRedirect(error) ? 0 : isHttpError(error) ? error.status : 500;
			if (status >= 500) log('ERROR', 'board.http', 'http_error', { ...where(event), status });
			throw error;
		}
		if (response.status >= 500) await logFailure(event, response);
		return response;
	});
};

/** An exception nothing caught: where it happened and its whole stack. Errors the board or
 *  SvelteKit raise on purpose, such as not-found, are not logged here. It may run after `handle`
 *  has returned, so the request id comes from the request itself. */
export const handleError: HandleServerError = async ({ kind, error, event }) => {
	if (kind !== 'unknown') return;
	// SvelteKit can fail before `handle` runs, such as loading a route's module: then nothing else
	// logs the 500 it answers with.
	const early = event.locals.requestId === undefined;
	event.locals.requestId ??= requestIdOf(event);
	event.locals.redact ??= redactorFor(event);
	const { exc_type, exc_message, traceback } = exceptionFields(error);
	const fields = {
		...where(event),
		exc_type,
		exc_message: await event.locals.redact(exc_message),
		traceback: traceback && (await event.locals.redact(traceback))
	};
	withRequestId(event.locals.requestId, () => {
		log('ERROR', 'board.http', 'unhandled_error', fields);
		if (early) log('ERROR', 'board.http', 'http_error', { ...where(event), status: 500 });
	});
};
