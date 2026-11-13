import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import type { RequestHandler } from './$types';

/** 沿用原紀錄: `{ marker }` is the project's own done marker; this period then counts as done. For
 *  moving a task in, never a button on the page. 201 with the record; 400 or 404 with `message`. */
export const POST: RequestHandler = async ({ params, request }) => {
	const body: { marker?: unknown } | null = await request.json().catch(() => null);
	const added = getBoard().automation.carry(params.id, body?.marker);
	return added.ok ? json(added.run, { status: 201 }) : json({ message: added.message }, { status: added.status });
};
