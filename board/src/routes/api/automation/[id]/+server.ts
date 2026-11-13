import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import type { RequestHandler } from './$types';

/** Replace a task's settings; it stays paused or not as it was. Errors as for adding one. */
export const PUT: RequestHandler = async ({ params, request }) => {
	const saved = getBoard().automation.update(params.id, await request.json().catch(() => null));
	return saved.ok ? json(saved.task) : json({ errors: saved.errors }, { status: saved.status });
};
