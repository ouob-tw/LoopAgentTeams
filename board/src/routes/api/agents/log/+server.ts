import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { readLines } from '#lib/server/sent-log.ts';
import { readAgentActions, readSwitches } from '#lib/server/sent-views.ts';
import type { RequestHandler } from './$types';

/** What was done to an agent from the board, newest first: its actions, and its model switches
 *  apart. Only while the tab lists it. */
export const GET: RequestHandler = async ({ url }) => {
	const sessionId = url.searchParams.get('session');
	if (!sessionId) return json({ error: 'missing_session' }, { status: 400 });
	const board = getBoard();
	if (!(await board.current()).agents.some((agent) => agent.id === sessionId)) return json({ error: 'unknown_agent' }, { status: 404 });
	const { stateDir, launchWaitMs } = board.config;
	const now = board.config.now();
	const lines = readLines(stateDir, now);
	return json({ entries: readAgentActions(lines, sessionId), switches: readSwitches(lines, sessionId, now, launchWaitMs) });
};
