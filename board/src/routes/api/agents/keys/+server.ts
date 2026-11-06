import { json } from '@sveltejs/kit';
import { sendKeysToAgent } from '#lib/server/agent-control.ts';
import { getBoard } from '#lib/server/board.ts';
import { NAMED_KEY, type KeyInput } from '#lib/board/screen.ts';
import type { RequestHandler } from './$types';

/** How many inputs one request may carry, and how long one text may be. */
const MAX_INPUTS = 200;
const MAX_TEXT = 10_000;

const isInput = (value: unknown): value is KeyInput => {
	const input = value as Record<string, unknown> | null;
	if (typeof input !== 'object' || input === null || Object.keys(input).length !== 1) return false;
	if (typeof input.key === 'string') return NAMED_KEY.test(input.key);
	return typeof input.text === 'string' && input.text.length > 0 && input.text.length <= MAX_TEXT;
};

/** Type key presses and text from the 終端分頁 into an agent's pane, in order; `recovery` names
 *  this request's 恢復畫面 should not all be typed in. Answers how each fared, with its operation
 *  record entry. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const { session, keys, recovery } = body ?? {};
	if (typeof session !== 'string' || !session || typeof recovery !== 'string' || !recovery || recovery.length > 100) {
		return json({ error: 'invalid_keys' }, { status: 400 });
	}
	if (!Array.isArray(keys) || !keys.length || keys.length > MAX_INPUTS || !keys.every(isInput)) return json({ error: 'invalid_keys' }, { status: 400 });
	const board = getBoard();
	const result = await sendKeysToAgent(board, session, keys, recovery);
	board.pollSoon();
	return json(result.body, { status: result.status });
};
