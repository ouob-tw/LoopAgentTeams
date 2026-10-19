import { json } from '@sveltejs/kit';
import { DEVICE_COOKIE } from '#lib/server/auth.ts';
import { getBoard } from '#lib/server/board.ts';
import { agentTranscriptSource } from '#lib/server/transcript.ts';
import { transcriptEvents } from '#lib/server/transcript-stream.ts';
import type { RequestHandler } from './$types';

/** Event stream for one open agent page: the latest page of the agent's conversation; see
 *  `transcriptEvents`. */
export const GET: RequestHandler = async ({ url, cookies, request }) => {
	const sessionId = url.searchParams.get('session');
	if (!sessionId) return json({ error: 'missing_session' }, { status: 400 });
	const board = getBoard();
	const source = await agentTranscriptSource(board, sessionId);
	if (!source) return json({ error: 'unknown_agent' }, { status: 404 });
	return transcriptEvents(board, source, cookies.get(DEVICE_COOKIE)!, request.signal);
};
