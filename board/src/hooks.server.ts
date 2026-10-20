import { json, redirect } from '@sveltejs/kit';
import type { Handle, HandleServerError, ServerInit } from '@sveltejs/kit/hooks';
import { randomUUID } from 'node:crypto';
import { DEVICE_COOKIE } from '#lib/server/auth.ts';
import { getBoard } from '#lib/server/board.ts';
import { findDevice } from '#lib/server/devices.ts';
import { exceptionFields, log, withRequestId } from '#lib/server/log.ts';

export const init: ServerInit = () => {
	const board = getBoard();
	void board.refresh();
	// Open event streams would otherwise hold the server open after a stop signal.
	for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => board.close());
};

// Everything except the login screen and its one endpoint needs a logged-in device.
const OPEN_PATHS = new Set(['/login', '/api/login']);

// The user's own stylesheet: the last thing in the head, so it comes after every built-in style and
// nothing is painted without it. It is not part of the page's own markup: browser extensions add
// and move nodes next to stylesheets before the page takes over, which breaks taking over markup
// that contains one. The server answers with an empty sheet when there is none.
const USER_STYLE = '<link rel="stylesheet" href="/user.css" />';

// A caller's own request id is kept when it looks like one.
const REQUEST_ID = /^[\w.:-]{1,128}$/;

// What a failed response's reason may not repeat: the user's text in the request (answers,
// messages, the password). Node's errors about an argument that cannot be passed to a command
// quote that argument after "Received", possibly cut short, so that part is dropped as a whole.
const CONTENT_FIELDS = ['text', 'note', 'password'] as const;
const OMITTED = '[omitted]';
const MAX_REASON = 2000;

async function contentOf(request: Request | null): Promise<string[]> {
	const body: Record<string, unknown> | null = request ? await request.json().catch(() => null) : null;
	if (!body || typeof body !== 'object') return [];
	return CONTENT_FIELDS.map((field) => body[field]).filter((value): value is string => typeof value === 'string' && !!value.trim());
}

function scrubbed(reason: unknown, content: string[]): string | undefined {
	if (typeof reason !== 'string' || !reason) return undefined;
	let text = reason.replace(/(\. Received ).*$/s, `$1${OMITTED}`);
	for (const value of content) text = text.split(value).join(OMITTED);
	return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON)}…` : text;
}

/** One line for a response with a server-side status: its reasons as the page was told them. */
async function logFailure(event: Parameters<Handle>[0]['event'], response: Response, request: Request | null) {
	const reasons: Record<string, string | undefined> = {};
	if (response.headers.get('content-type')?.includes('application/json')) {
		const body: Record<string, unknown> | null = await response.clone().json().catch(() => null);
		const content = await contentOf(request);
		for (const field of ['reason', 'error', 'logError'] as const) reasons[field] = scrubbed(body?.[field], content);
		// SvelteKit's own error body; `message` is the log line's event name.
		reasons.detail = scrubbed(body?.message, content);
	}
	log('ERROR', 'board.http', 'http_error', { method: event.request.method, path: event.url.pathname, status: response.status, ...reasons });
}

export const handle: Handle = ({ event, resolve }) => {
	const given = event.request.headers.get('x-request-id');
	return withRequestId(given && REQUEST_ID.test(given) ? given : randomUUID(), async () => {
		const token = event.cookies.get(DEVICE_COOKIE);
		const device = token ? findDevice(getBoard().config.stateDir, token) : null;
		event.locals.device = device;

		const path = event.url.pathname;
		if (!device && !OPEN_PATHS.has(path)) {
			if (path.startsWith('/api/')) return json({ error: 'unpaired' }, { status: 401 });
			redirect(303, '/login');
		}
		if (device && path === '/login') redirect(303, '/');
		// Read only when the response fails, to keep the user's text out of its reason.
		const request = event.request.headers.get('content-type')?.includes('application/json') ? event.request.clone() : null;
		// Only a logged-in device can fetch the stylesheet, so only its pages refer to it.
		const response = await resolve(event, {
			transformPageChunk: ({ html }) => html.replace('%lat.user-style%', device ? USER_STYLE : '')
		});
		if (response.status >= 500) await logFailure(event, response, request);
		return response;
	});
};

/** An exception nothing caught: where it happened and its whole stack. Errors the board or
 *  SvelteKit raise on purpose, such as not-found, are not logged here. */
export const handleError: HandleServerError = ({ kind, error, event }) => {
	if (kind !== 'unknown') return;
	log('ERROR', 'board.http', 'unhandled_error', { method: event.request.method, path: event.url.pathname, ...exceptionFields(error) });
};
