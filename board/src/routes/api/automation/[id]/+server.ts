import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import type { RequestHandler } from './$types';

/** Replace a task's settings; it stays paused or not as it was. Errors as for adding one. */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const saved = getBoard().automation.update(params.id, await request.json().catch(() => null), locals.device ? { deviceId: locals.device.id } : undefined);
	return saved.ok ? json(saved.task) : json({ errors: saved.errors }, { status: saved.status });
};

/** 刪除任務: 204 once the task and its records are gone; 409 while a run of it is unfinished. */
export const DELETE: RequestHandler = ({ params }) => {
	const removed = getBoard().automation.remove(params.id);
	return removed.ok ? new Response(null, { status: 204 }) : json({ message: removed.message }, { status: removed.status });
};
