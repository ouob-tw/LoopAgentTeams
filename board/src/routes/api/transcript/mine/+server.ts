import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { readMyMessages } from '#lib/server/my-messages.ts';
import { transcriptSource } from '#lib/server/transcript.ts';
import type { RequestHandler } from './$types';

/** What the user said in a controller's whole conversation, newest first. */
export const GET: RequestHandler = async ({ url }) => {
	const controllerId = url.searchParams.get('controller');
	if (!controllerId) return json({ error: 'missing_controller' }, { status: 400 });
	const board = getBoard();
	const source = await transcriptSource(board, controllerId);
	if (!source) return json({ error: 'unknown_controller' }, { status: 404 });
	return json(await readMyMessages(board.config, source.client, source.sessionId));
};
