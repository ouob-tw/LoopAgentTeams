import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { everyController } from '#lib/board/types.ts';
import { readReview } from '#lib/server/helper.ts';
import { readEvidenceFile } from '#lib/server/evidence-file.ts';
import type { RequestHandler } from './$types';

/** A file the controller's current review cites as evidence, for the board's evidence window. */
export const GET: RequestHandler = async ({ url }) => {
	const board = getBoard();
	const controller = everyController(await board.current()).find((candidate) => candidate.id === url.searchParams.get('controller'));
	if (!controller) return json({ reason: '找不到這個主控' }, { status: 404 });
	const read = await readReview(board.config, { workspace: controller.workspace, sessionId: controller.id });
	if (!read.ok) return json({ reason: read.reason }, { status: 502 });
	const file = await readEvidenceFile(controller.workspace, read.review, url.searchParams.get('path') ?? '');
	if (!file.ok) return json({ reason: file.reason }, { status: file.status });
	return json({ text: file.text, truncated: file.truncated });
};
