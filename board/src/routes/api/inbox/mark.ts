import { error, json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';

/** Mark one inbox report read or unread. The new state reaches every device through the event stream. */
export async function markReport(request: Request, read: boolean): Promise<Response> {
	const body: { key?: unknown } | null = await request.json().catch(() => null);
	if (typeof body?.key !== 'string') error(400, '缺少回報的 key');

	const result = await getBoard().mark(body.key, read);
	if (result === 'unknown') error(404, '找不到這筆回報');
	if (result === 'archived') error(409, '這筆回報已封存');
	return json({ result });
}
