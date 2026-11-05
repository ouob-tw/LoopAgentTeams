import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { recover } from '#lib/server/screen.ts';
import type { RequestHandler } from './$types';

/** Read an agent's screen again for a key request whose answer never came back, so the page that
 *  sent it gets its 恢復畫面 (`recover`). Nothing is typed. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const { session, recovery } = body ?? {};
	if (typeof session !== 'string' || !session || typeof recovery !== 'string' || !recovery || recovery.length > 100) {
		return json({ error: 'invalid_recovery' }, { status: 400 });
	}
	const board = getBoard();
	if (!(await board.current()).agents.some((candidate) => candidate.id === session)) return json({ error: 'unknown_agent' }, { status: 404 });
	recover(board, session, recovery);
	return json({ ok: true });
};
