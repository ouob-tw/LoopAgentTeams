import { json } from '@sveltejs/kit';
import { abandonAgentSwitch } from '#lib/server/agent-switch.ts';
import { getBoard } from '#lib/server/board.ts';
import type { RequestHandler } from './$types';

/** Give up an agent's open model switch as a whole, after the user confirmed it on the page. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const session = body?.session;
	if (typeof session !== 'string' || !session) return json({ error: 'invalid_session' }, { status: 400 });
	const result = await abandonAgentSwitch(getBoard(), session);
	return json(result.body, { status: result.status });
};
