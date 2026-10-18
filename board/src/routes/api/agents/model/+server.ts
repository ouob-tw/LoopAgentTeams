import { json } from '@sveltejs/kit';
import { agentModelStatus, switchAgentModel } from '#lib/server/agent-switch.ts';
import { getBoard } from '#lib/server/board.ts';
import type { RequestHandler } from './$types';

/** What a switch of this agent's model and effort may offer. A browser that goes away ends the
 *  helper read. */
export const GET: RequestHandler = async ({ url, request }) => {
	const sessionId = url.searchParams.get('session');
	if (!sessionId) return json({ error: 'missing_session' }, { status: 400 });
	const status = await agentModelStatus(getBoard(), sessionId, request.signal);
	if (!status) return json({ error: 'unknown_agent' }, { status: 404 });
	return json(status);
};

/** Switch an agent's model and effort, or continue its open switch. Every attempt answers with its
 *  sent-log entry. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const { session, model, effort } = body ?? {};
	if (
		typeof session !== 'string' ||
		!session ||
		(model !== null && typeof model !== 'string') ||
		(effort !== null && typeof effort !== 'string')
	) {
		return json({ error: 'invalid_switch' }, { status: 400 });
	}
	const result = await switchAgentModel(getBoard(), session, { model, effort });
	return json(result.body, { status: result.status });
};
