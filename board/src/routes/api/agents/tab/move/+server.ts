import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { moveAgentTab } from '#lib/server/tab-control.ts';
import { tabTarget } from '../target.ts';
import type { RequestHandler } from './$types';

/** Move a Herdr tab to where another tab of its workspace is. Every attempt answers with its
 *  sent-log entry; dropping a tab on itself is not one. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const target = tabTarget(body);
	const before = body?.before;
	if (!target || typeof before !== 'string' || !before || before === target.tab) return json({ error: 'invalid_move' }, { status: 400 });
	const result = await moveAgentTab(getBoard(), target, before);
	return json(result.body, { status: result.status });
};
