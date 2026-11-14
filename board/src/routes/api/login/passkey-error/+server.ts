import { json } from '@sveltejs/kit';
import { ALL_PASSKEY_ERRORS_PER_MINUTE, BROWSER_FLOWS, logBrowserRefusal, MAX_PASSKEY_ERROR_CHARS } from '#lib/server/auth-log.ts';
import { createClientErrorLimit } from '#lib/server/client-errors.ts';
import type { PasskeyFlow } from '#lib/board/passkey-here.ts';
import type { RequestHandler } from './$types';

/** Reports from one address in a minute (the limit is keyed by address here, not by device). */
const perAddress = createClientErrorLimit();
/** Reports from every address together in this minute. */
let all = { start: 0, count: 0 };

function admitAny(now: number): boolean {
	if (now - all.start >= 60_000) all = { start: now, count: 0 };
	return ++all.count <= ALL_PASSKEY_ERRORS_PER_MINUTE;
}

/** The body as text, or null when it is longer than the limit; past the limit it is read and
 *  dropped (adapter-node stops it at its own body limit), as ending the stream early would reset
 *  the connection under the answer. */
async function boundedText(request: Request): Promise<string | null> {
	if (!request.body) return '';
	const decoder = new TextDecoder();
	let text: string | null = '';
	for await (const chunk of request.body) {
		if (text === null) continue;
		text += decoder.decode(chunk, { stream: true });
		if (text.length > MAX_PASSKEY_ERROR_CHARS) text = null;
	}
	return text === null ? null : text + decoder.decode();
}

/** The browser refused to make or use a passkey: the page reports where it was and the error's
 *  name, and only those go in the log. Open to pages not logged in (the login page), so only a
 *  same-origin JSON request of at most 1 KB is taken, and only so many lines a minute are written. */
export const POST: RequestHandler = async (event) => {
	const { request, locals } = event;
	// A cross-site page can send a form or plain text without asking, but not JSON.
	if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'json_only' }, { status: 415 });
	const site = request.headers.get('sec-fetch-site');
	if (site && site !== 'same-origin') return json({ error: 'cross_site' }, { status: 403 });
	if (Number(request.headers.get('content-length')) > MAX_PASSKEY_ERROR_CHARS) return json({ error: 'too_large' }, { status: 413 });
	const text = await boundedText(request);
	if (text === null) return json({ error: 'too_large' }, { status: 413 });
	let report: { flow?: unknown; name?: unknown } | null = null;
	try {
		report = JSON.parse(text);
	} catch {
		// Answered below.
	}
	const flow = report?.flow;
	if (typeof flow !== 'string' || !Object.hasOwn(BROWSER_FLOWS, flow)) return json({ error: 'invalid_report' }, { status: 400 });
	if (!perAddress.admit(locals.clientAddress) || !admitAny(Date.now())) return json({ error: 'rate_limited' }, { status: 429 });
	logBrowserRefusal(event, flow as PasskeyFlow, report!.name);
	return new Response(null, { status: 204 });
};
