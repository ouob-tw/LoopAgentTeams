import { json } from '@sveltejs/kit';
import { interruptAgent } from '#lib/server/agent-control.ts';
import { getBoard } from '#lib/server/board.ts';
import type { RequestHandler } from './$types';

/** Interrupt an agent's turn with Esc. Every attempt answers with its sent-log entry. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const session = body?.session;
	if (typeof session !== 'string' || !session) return json({ error: 'invalid_session' }, { status: 400 });
	const result = await interruptAgent(getBoard(), session);
	return json(result.body, { status: result.status });
};
