import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { denyPdRequest } from '#lib/server/pd.ts';
import type { RequestHandler } from './$types';

/** Deny one of pd's waiting requests with `pd deny <id>`, which needs no code. Approving needs the
 *  user's passkey (/api/pd/challenge and /api/pd/approve). Every open page then reads the list without it. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const id = body?.id;
	if (!Number.isInteger(id) || id < 1) return json({ error: '請求編號必須是正整數' }, { status: 400 });
	const board = getBoard();
	const reply = await denyPdRequest(board.config.pdCommand, id, board.config.pdTimeoutMs);
	await board.refreshPd();
	return json(reply.body, { status: reply.status });
};
