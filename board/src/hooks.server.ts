import { isHttpError, isRedirect, json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import type { Handle, HandleServerError, ServerInit } from '@sveltejs/kit/hooks';
import { randomUUID } from 'node:crypto';
import { DEVICE_COOKIE } from '#lib/server/auth.ts';
import { getBoard } from '#lib/server/board.ts';
import { actingAs } from '#lib/server/acting.ts';
import { clientAddress, viaHttps } from '#lib/server/client-address.ts';
import { findDevice, markSeen } from '#lib/server/devices.ts';
import { securityHeaders } from '#lib/server/security-headers.ts';
import { testDeviceRefusal } from '#lib/server/test-device.ts';
import { exceptionFields, log, withRequestId } from '#lib/server/log.ts';
import { redact, secretsOf } from '#lib/server/redact.ts';

export const init: ServerInit = () => {
	const board = getBoard();
	void board.refresh();
	// Open event streams would otherwise hold the server open after a stop signal.
	for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => board.close());
};

// Everything except the login screens and their endpoints needs a logged-in device.
const OPEN_PATHS = new Set(['/login', '/api/login', '/login/test', '/api/login/test']);

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

/** The response with the security headers. The built server's connection guard
 *  (instrumentation.server.ts) set them already, but a header SvelteKit writes replaces it: here a
 *  route's own policy (an attached file's sandbox) is joined with the board's. */
function secured(response: Response, https: boolean): Response {
	const apply = (headers: Headers) => {
		for (const [name, value] of securityHeaders(https, headers.get('content-security-policy'))) headers.set(name, value);
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
	// The built server refused it before anything was served (instrumentation.server.ts); `vite dev`
	// has no such guard, so the check is made here too.
	if (!config.allowedSources.has(peer)) {
		log('WARNING', 'board.http', 'source_refused', { ...where(event), peer });
		return secured(new Response('Forbidden', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } }), https);
	}
	event.locals.clientAddress = clientAddress(peer, event.request.headers.get('x-forwarded-for'), config.trustedProxies);
	event.locals.https = https;
	return secured(await handleAllowed({ event, resolve }), https);
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
			if (device) markSeen(board.config.stateDir, device, now);
			event.locals.device = device;

			const path = event.url.pathname;
			if (!device && !OPEN_PATHS.has(path)) {
				if (path.startsWith('/api/')) return json({ error: 'unpaired' }, { status: 401 });
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
