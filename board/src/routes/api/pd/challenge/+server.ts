import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { pdChallenge } from '#lib/server/pd.ts';
import type { RequestHandler } from './$types';

/** pd's one-time passkey challenge for one waiting request, from `pd passkey challenge <id>`: the
 *  page signs it with the user's passkey and posts the assertion to /api/pd/approve. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const id = body?.id;
	if (!Number.isInteger(id) || id < 1) return json({ error: '請求編號必須是正整數' }, { status: 400 });
	const board = getBoard();
	const reply = await pdChallenge(board.config.pdCommand, id, board.config.pdTimeoutMs);
	return json(reply.body, { status: reply.status });
};
