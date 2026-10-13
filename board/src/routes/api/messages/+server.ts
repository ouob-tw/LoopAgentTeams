import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { sendMessage, typedText } from '#lib/server/send.ts';
import { readSent } from '#lib/server/sent-log.ts';
import type { RequestHandler } from './$types';

/** Type a message into a controller's client. Every attempt answers with its sent-log entry. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const { controllerId, text } = body ?? {};
	if (typeof controllerId !== 'string' || !controllerId || typeof text !== 'string' || !typedText(text).trim()) {
		return json({ error: 'invalid_message' }, { status: 400 });
	}
	const result = await sendMessage(getBoard(), controllerId, text);
	return json(result.body, { status: result.status });
};

/** What was sent to one controller, newest first. */
export const GET: RequestHandler = ({ url }) => {
	const controllerId = url.searchParams.get('controller');
	if (!controllerId) return json({ error: 'missing_controller' }, { status: 400 });
	const board = getBoard();
	return json({ entries: readSent(board.config.stateDir, controllerId), logError: board.sentLogError() });
};
