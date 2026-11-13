import { error, json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import type { RequestHandler } from './$types';

/** 暫停 (`paused: true`) or 恢復 (`paused: false`): a paused task is not started by the schedule. */
export const POST: RequestHandler = async ({ params, request }) => {
	const body: { paused?: unknown } | null = await request.json().catch(() => null);
	if (typeof body?.paused !== 'boolean') error(400, 'paused 必須是 true 或 false');
	const task = getBoard().automation.setPaused(params.id, body.paused);
	if (!task) error(404, '這個任務已不存在');
	return json(task);
};
