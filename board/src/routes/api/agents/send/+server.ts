import { json } from '@sveltejs/kit';
import { sendToAgent } from '#lib/server/agent-control.ts';
import { getBoard } from '#lib/server/board.ts';
import { typedText } from '#lib/server/send.ts';
import type { RequestHandler } from './$types';

/** Type text into an agent's input box. Every attempt answers with its sent-log entry. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const { session, text } = body ?? {};
	if (typeof session !== 'string' || !session || typeof text !== 'string' || !typedText(text).trim()) {
		return json({ error: 'invalid_message' }, { status: 400 });
	}
	const board = getBoard();
	const result = await sendToAgent(board, session, text);
	board.pollSoon();
	return json(result.body, { status: result.status });
};
