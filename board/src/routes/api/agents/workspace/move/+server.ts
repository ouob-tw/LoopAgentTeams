import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { moveHerdrWorkspace } from '#lib/server/tab-control.ts';
import type { RequestHandler } from './$types';

/** Move a Herdr workspace to where another workspace is. Every attempt answers with its sent-log
 *  entry; dropping a workspace on itself is not one. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const { workspace, onto } = (body ?? {}) as Record<string, unknown>;
	if (typeof workspace !== 'string' || !workspace || typeof onto !== 'string' || !onto || onto === workspace) {
		return json({ error: 'invalid_move' }, { status: 400 });
	}
	const result = await moveHerdrWorkspace(getBoard(), workspace, onto);
	return json(result.body, { status: result.status });
};
