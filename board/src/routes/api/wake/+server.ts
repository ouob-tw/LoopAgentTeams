import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { typedText } from '#lib/server/send.ts';
import { wakeController } from '#lib/server/wake.ts';
import type { RequestHandler } from './$types';

/** Wake a controller: type the text into its running client, or resume its conversation. Every
 *  attempt answers with its sent-log entry. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const { controllerId, text, model = null, effort = null } = body ?? {};
	const board = getBoard();
	if (
		(model !== null && typeof model !== 'string') ||
		(effort !== null && typeof effort !== 'string') ||
		typeof controllerId !== 'string' ||
		!controllerId ||
		typeof text !== 'string' ||
		!typedText(text).trim()
	) {
		return json({ error: 'invalid_wake' }, { status: 400 });
	}
	const result = await wakeController(board, { controllerId, text, model, effort });
	return json(result.body, { status: result.status });
};
