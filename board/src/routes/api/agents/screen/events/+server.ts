import { json } from '@sveltejs/kit';
import { DEVICE_COOKIE } from '#lib/server/auth.ts';
import { getBoard } from '#lib/server/board.ts';
import { screenEvents } from '#lib/server/transcript-stream.ts';
import type { RequestHandler } from './$types';

/** Event stream for an agent's open 終端分頁: the screen of the Herdr pane it is in; see
 *  `screenEvents`. Only for an agent Herdr lists now. */
export const GET: RequestHandler = async ({ url, cookies, request }) => {
	const sessionId = url.searchParams.get('session');
	if (!sessionId) return json({ error: 'missing_session' }, { status: 400 });
	const board = getBoard();
	const agent = (await board.current()).agents.find((candidate) => candidate.id === sessionId);
	if (!agent?.inHerdr) return json({ error: 'unknown_agent' }, { status: 404 });
	return screenEvents(board, sessionId, cookies.get(DEVICE_COOKIE)!, request.signal);
};
