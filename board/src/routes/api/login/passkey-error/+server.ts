import { json } from '@sveltejs/kit';
import { BROWSER_FLOWS, logBrowserRefusal, MAX_PASSKEY_ERROR_CHARS, type BrowserFlow } from '#lib/server/auth-log.ts';
import { createClientErrorLimit } from '#lib/server/client-errors.ts';
import type { RequestHandler } from './$types';

/** Reports from one address in a minute; the rest are dropped. */
const limit = createClientErrorLimit();

/** The browser refused to make or use a passkey: the page reports where it was and the error's
 *  name, and only those go in the log. Open to pages not logged in (the login page), so only a
 *  same-origin JSON request of a few hundred bytes is taken, and an address gets only so many lines
 *  a minute. */
export const POST: RequestHandler = async (event) => {
	const { request, locals } = event;
	// A cross-site page can send a form or plain text without asking, but not JSON.
	if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'json_only' }, { status: 415 });
	const site = request.headers.get('sec-fetch-site');
	if (site && site !== 'same-origin') return json({ error: 'cross_site' }, { status: 403 });
	if (Number(request.headers.get('content-length')) > MAX_PASSKEY_ERROR_CHARS) return json({ error: 'too_large' }, { status: 413 });
	const text = await request.text();
	if (text.length > MAX_PASSKEY_ERROR_CHARS) return json({ error: 'too_large' }, { status: 413 });
	let report: { flow?: unknown; name?: unknown } | null = null;
	try {
		report = JSON.parse(text);
	} catch {
		// Answered below.
	}
	const flow = report?.flow;
	if (typeof flow !== 'string' || !Object.hasOwn(BROWSER_FLOWS, flow)) return json({ error: 'invalid_report' }, { status: 400 });
	if (!limit.admit(locals.clientAddress)) return json({ error: 'rate_limited' }, { status: 429 });
	logBrowserRefusal(event, flow as BrowserFlow, report!.name);
	return new Response(null, { status: 204 });
};
