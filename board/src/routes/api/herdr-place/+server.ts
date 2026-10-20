import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { describePlace } from '#lib/server/herdr.ts';
import { findController } from '#lib/server/wake.ts';
import type { RequestHandler } from './$types';

/** The names and places of the Herdr workspace and tab a controller runs in. */
export const GET: RequestHandler = async ({ url }) => {
	const controllerId = url.searchParams.get('controller');
	if (!controllerId) return json({ error: 'missing_controller' }, { status: 400 });
	const board = getBoard();
	const controller = await findController(board, controllerId);
	if (!controller) return json({ error: 'unknown_controller' }, { status: 404 });
	if (!controller.herdr) return json({ ok: false, reason: '主控已停用 LAT 或已關閉' });
	const result = await describePlace(board.config, controller.herdr.workspace, controller.herdr.tab);
	return json('reason' in result ? { ok: false, reason: result.reason } : { ok: true, place: result.place });
};
