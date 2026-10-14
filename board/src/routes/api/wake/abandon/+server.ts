import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { abandonResume } from '#lib/server/wake.ts';
import type { RequestHandler } from './$types';

/** Give up a controller's open resume attempt, after the user confirmed it on the page. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const { controllerId, wakeId } = body ?? {};
	if (typeof controllerId !== 'string' || !controllerId || typeof wakeId !== 'string' || !wakeId) {
		return json({ error: 'invalid_abandon' }, { status: 400 });
	}
	const result = await abandonResume(getBoard(), controllerId, wakeId);
	return json(result.body, { status: result.status });
};
