import { json } from '@sveltejs/kit';
import { createClientErrorLimit, logClientError, MAX_CLIENT_ERROR_CHARS } from '#lib/server/client-errors.ts';
import type { RequestHandler } from './$types';

const limit = createClientErrorLimit();

/** An error a page hit in the browser. Only a logged-in device gets here (see hooks.server.ts). */
export const POST: RequestHandler = async ({ request, locals }) => {
	const device = locals.device!;
	const text = await request.text();
	if (text.length > MAX_CLIENT_ERROR_CHARS) return json({ error: 'too_large' }, { status: 413 });
	let report: unknown = null;
	try {
		report = JSON.parse(text);
	} catch {
		// Answered below.
	}
	if (!report || typeof report !== 'object') return json({ error: 'invalid_client_error' }, { status: 400 });
	if (!limit.admit(device.id)) return json({ error: 'rate_limited' }, { status: 429 });
	logClientError(device.id, report as Record<string, unknown>, request.headers.get('user-agent'));
	return new Response(null, { status: 204 });
};
