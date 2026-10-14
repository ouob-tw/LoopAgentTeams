import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { modelStatus, switchModel } from '#lib/server/switch.ts';
import { findController } from '#lib/server/wake.ts';
import type { RequestHandler } from './$types';

/** What a switch of this controller's model and effort may offer right now. A browser that goes
 *  away ends the helper read. */
export const GET: RequestHandler = async ({ url, request }) => {
	const controllerId = url.searchParams.get('controller');
	if (!controllerId) return json({ error: 'missing_controller' }, { status: 400 });
	const board = getBoard();
	const controller = await findController(board, controllerId);
	if (!controller) return json({ error: 'unknown_controller' }, { status: 404 });
	return json(await modelStatus(board, controller, request.signal));
};

/** Switch a controller's model and effort, or continue its open switch. Every attempt answers
 *  with its sent-log entry. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const { controllerId, model, effort } = body ?? {};
	if (
		typeof controllerId !== 'string' ||
		!controllerId ||
		(model !== null && typeof model !== 'string') ||
		(effort !== null && typeof effort !== 'string')
	) {
		return json({ error: 'invalid_switch' }, { status: 400 });
	}
	const result = await switchModel(getBoard(), { controllerId, model, effort });
	return json(result.body, { status: result.status });
};
