import { json } from '@sveltejs/kit';
import { resendAsk } from '#lib/server/board-asks.ts';
import { getBoard } from '#lib/server/board.ts';
import type { RequestHandler } from './$types';

/** Send again the late answer of a board ask whose message may not have gone (結果不明). Only one
 *  resend counts at a time; another device's answers 409 `taken`. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const id = body?.id;
	if (typeof id !== 'string' || !id) return json({ error: 'invalid_ask_resend' }, { status: 400 });
	const result = await resendAsk(getBoard(), id);
	return json(result.body, { status: result.status });
};
