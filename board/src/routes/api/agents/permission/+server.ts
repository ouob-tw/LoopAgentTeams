import { json } from '@sveltejs/kit';
import { isClaudeMode, isCodexMode } from '#lib/board/permissions.ts';
import { getBoard } from '#lib/server/board.ts';
import { agentPermissionStatus, switchClaudePermission, switchCodexPermission } from '#lib/server/permission-switch.ts';
import type { RequestHandler } from './$types';

/** The agent's permission mode now, and the modes a switch offers it. */
export const GET: RequestHandler = async ({ url }) => {
	const sessionId = url.searchParams.get('session');
	if (!sessionId) return json({ error: 'missing_session' }, { status: 400 });
	const status = await agentPermissionStatus(getBoard(), sessionId);
	if (!status) return json({ error: 'unknown_agent' }, { status: 404 });
	return json(status);
};

/** Switch the agent's permission mode: a Claude mode by Shift+Tab, a Codex one by a resume. Every
 *  attempt answers with its sent-log entry. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const { session, mode } = body ?? {};
	if (typeof session !== 'string' || !session || (!isClaudeMode(mode) && !isCodexMode(mode))) return json({ error: 'invalid_permission' }, { status: 400 });
	const board = getBoard();
	const result = isClaudeMode(mode) ? await switchClaudePermission(board, session, mode) : await switchCodexPermission(board, session, mode);
	return json(result.body, { status: result.status });
};
