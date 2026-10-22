import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { startUpload } from '#lib/server/uploads.ts';
import type { RequestHandler } from './$types';

/** Reserve a file for an attachment of the given name and size; its pieces follow. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const result = startUpload(getBoard().config, body?.name, body?.size);
	return json(result.body, { status: result.status });
};
