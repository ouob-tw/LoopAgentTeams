import { error, json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import type { RequestHandler } from './$types';

/** Mark one inbox report read. The new state reaches every device through the event stream. */
export const POST: RequestHandler = async ({ request }) => {
	const body: { key?: unknown } | null = await request.json().catch(() => null);
	if (typeof body?.key !== 'string') error(400, '缺少回報的 key');

	const result = await getBoard().markRead(body.key);
	if (result === 'unknown') error(404, '找不到這筆回報');
	if (result === 'archived') error(409, '這筆回報已封存');
	return json({ result });
};
