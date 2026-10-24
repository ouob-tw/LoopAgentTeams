import { json } from '@sveltejs/kit';
import type { AskPick } from '#lib/board/board-asks.ts';
import { answerAsk, answerPermission } from '#lib/server/board-asks.ts';
import { getBoard } from '#lib/server/board.ts';
import type { RequestHandler } from './$types';

const isPick = (value: unknown): value is AskPick => {
	const pick = value as Partial<AskPick> | null;
	return (
		Array.isArray(pick?.select) &&
		pick.select.every((position) => Number.isInteger(position) && position > 0) &&
		typeof pick.other === 'boolean' &&
		typeof pick.text === 'string'
	);
};

/** Answer a board ask, every question of it at once, or a permission request with `decision`
 *  (`allow`, or `deny` with an optional `reason`). Only the first answer to reach the shared folder
 *  counts; a later one, from another device too, answers 409 `taken`. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const { id, picks, decision, reason } = body ?? {};
	if (decision !== undefined) {
		if (typeof id !== 'string' || !id || (decision !== 'allow' && decision !== 'deny') || (reason !== undefined && typeof reason !== 'string')) {
			return json({ error: 'invalid_ask_answer' }, { status: 400 });
		}
		const result = await answerPermission(getBoard(), id, decision, reason ?? '');
		return json(result.body, { status: result.status });
	}
	if (typeof id !== 'string' || !id || !Array.isArray(picks) || !picks.every(isPick)) {
		return json({ error: 'invalid_ask_answer' }, { status: 400 });
	}
	const result = await answerAsk(getBoard(), id, picks);
	return json(result.body, { status: result.status });
};
