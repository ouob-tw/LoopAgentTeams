import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { relinkAgent } from '#lib/server/relink.ts';
import type { RequestHandler } from './$types';

/** Restart an agent with no hcom hooks so it links. Every attempt answers with its sent-log entry. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const session = body?.session;
	if (typeof session !== 'string' || !session) return json({ error: 'invalid_session' }, { status: 400 });
	const result = await relinkAgent(getBoard(), session);
	return json(result.body, { status: result.status });
};
