import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { resumeClosed } from '#lib/server/closed-agents.ts';
import type { RequestHandler } from './$types';

/** Bring back a closed agent of the 已關閉 section in a new Herdr tab. Every attempt is logged as
 *  the agent's action. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const session = body?.session;
	if (typeof session !== 'string' || !session) return json({ error: 'invalid_session' }, { status: 400 });
	const result = await resumeClosed(getBoard(), session);
	return json(result.body, { status: result.status });
};
