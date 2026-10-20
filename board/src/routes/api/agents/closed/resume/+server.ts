import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { resumeClosed } from '#lib/server/closed-agents.ts';
import type { RequestHandler } from './$types';

/** Bring back a closed agent of the 已關閉 section in a new Herdr tab; a controller with the wake's
 *  options (`text`, `newRound`, `model`, `effort`; a plain agent takes none). Every attempt is
 *  logged as the agent's action. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const { session, text = '', newRound = false, model = null, effort = null } = body ?? {};
	if (
		typeof session !== 'string' ||
		!session ||
		typeof text !== 'string' ||
		typeof newRound !== 'boolean' ||
		(model !== null && typeof model !== 'string') ||
		(effort !== null && typeof effort !== 'string')
	) {
		return json({ error: 'invalid_session' }, { status: 400 });
	}
	const result = await resumeClosed(getBoard(), session, { text, newRound, model, effort });
	return json(result.body, { status: result.status });
};
