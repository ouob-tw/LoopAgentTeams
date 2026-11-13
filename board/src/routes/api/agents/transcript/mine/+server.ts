import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { readMyMessages } from '#lib/server/my-messages.ts';
import { agentTranscriptSource } from '#lib/server/transcript.ts';
import type { RequestHandler } from './$types';

/** What the user said in an agent's whole conversation, newest first. */
export const GET: RequestHandler = async ({ url }) => {
	const sessionId = url.searchParams.get('session');
	if (!sessionId) return json({ error: 'missing_session' }, { status: 400 });
	const board = getBoard();
	const source = await agentTranscriptSource(board, sessionId);
	if (!source) return json({ error: 'unknown_agent' }, { status: 404 });
	return json(await readMyMessages(board.config, source.client, source.sessionId));
};
