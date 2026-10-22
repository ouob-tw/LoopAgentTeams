import { json } from '@sveltejs/kit';
import { appendChunk } from '#lib/server/uploads.ts';
import type { RequestHandler } from './$types';

/** Append one piece of an attachment, sent as the request body, at `?offset=`. */
export const PUT: RequestHandler = async ({ params, request, url }) => {
	const offset = Number(url.searchParams.get('offset'));
	if (!Number.isInteger(offset) || offset < 0) return json({ error: 'invalid_offset' }, { status: 400 });
	const result = appendChunk(params.id, offset, new Uint8Array(await request.arrayBuffer()));
	return json(result.body, { status: result.status });
};
