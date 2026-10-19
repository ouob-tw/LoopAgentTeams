import { json } from '@sveltejs/kit';
import { DEVICE_COOKIE } from '#lib/server/auth.ts';
import { getBoard } from '#lib/server/board.ts';
import { transcriptSource } from '#lib/server/transcript.ts';
import { transcriptEvents } from '#lib/server/transcript-stream.ts';
import type { RequestHandler } from './$types';

/** Event stream for one open information page: the latest page of the controller's conversation;
 *  see `transcriptEvents`. */
export const GET: RequestHandler = async ({ url, cookies, request }) => {
	const controllerId = url.searchParams.get('controller');
	if (!controllerId) return json({ error: 'missing_controller' }, { status: 400 });
	const board = getBoard();
	const source = await transcriptSource(board, controllerId);
	if (!source) return json({ error: 'unknown_controller' }, { status: 404 });
	return transcriptEvents(board, source, cookies.get(DEVICE_COOKIE)!, request.signal);
};
