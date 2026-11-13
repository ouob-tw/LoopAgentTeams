import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { everyController } from '#lib/board/types.ts';
import { readReview } from '#lib/server/helper.ts';
import type { RequestHandler } from './$types';

/** One controller's latest round's review, read again from lat-unattended each time. */
export const GET: RequestHandler = async ({ url }) => {
	const board = getBoard();
	const controller = everyController(await board.current()).find((candidate) => candidate.id === url.searchParams.get('controller'));
	if (!controller) return json({ reason: '找不到這個主控' }, { status: 404 });
	const read = await readReview(board.config, { workspace: controller.workspace, sessionId: controller.id });
	if (!read.ok) return json({ reason: read.reason }, { status: 502 });
	return json({ review: read.review });
};
