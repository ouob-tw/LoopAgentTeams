import { json } from '@sveltejs/kit';
import { pauseAgent } from '#lib/server/agent-control.ts';
import { getBoard } from '#lib/server/board.ts';
import type { RequestHandler } from './$types';

/** Pause an agent's HCOM link, keeping its process and Herdr pane. Every attempt answers with its sent-log entry. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const session = body?.session;
	if (typeof session !== 'string' || !session) return json({ error: 'invalid_session' }, { status: 400 });
	const result = await pauseAgent(getBoard(), session);
	return json(result.body, { status: result.status });
};
