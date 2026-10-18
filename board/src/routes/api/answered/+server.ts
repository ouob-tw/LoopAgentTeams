import { error, json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import type { RequestHandler } from './$types';

/** One controller's answered questions, shown as read-only cards in its conversation. */
export const GET: RequestHandler = async ({ url }) => {
	const controller = url.searchParams.get('controller');
	if (!controller) error(400, '缺少主控');
	return json(await getBoard().answered(controller));
};
