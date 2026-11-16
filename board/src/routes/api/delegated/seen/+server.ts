import { error, json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { log, exceptionFields } from '#lib/server/log.ts';
import type { RequestHandler } from './$types';

/** Mark one delegated decision card opened. The new state reaches every device through the event
 *  stream; a mark that cannot be kept answers 500, and the page keeps the card. */
export const POST: RequestHandler = async ({ request }) => {
	const body: { controllerId?: unknown; id?: unknown } | null = await request.json().catch(() => null);
	if (typeof body?.controllerId !== 'string' || typeof body.id !== 'string') error(400, '缺少主控或代決的 ID');
	let result: 'marked' | 'unknown';
	try {
		result = await getBoard().markDelegatedSeen(body.controllerId, body.id);
	} catch (cause) {
		log('ERROR', 'delegated', 'delegated seen mark not saved', exceptionFields(cause));
		return json({ reason: (cause as Error).message }, { status: 500 });
	}
	if (result === 'unknown') error(404, '找不到這筆代決');
	return json({ result });
};
