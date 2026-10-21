import { error, json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { isUsageStyle } from '#lib/server/usage-style.ts';
import type { RequestHandler } from './$types';

/** How the usage line reads, the same on every logged-in device. */
export const GET: RequestHandler = () => json(getBoard().usageStyle());

/** Change it. The new style reaches every open page through the event stream. */
export const PUT: RequestHandler = async ({ request }) => {
	const body: { style?: unknown } | null = await request.json().catch(() => null);
	if (!isUsageStyle(body?.style)) error(400, '用量列樣式必須是 detailed 或 compact');
	try {
		return json(getBoard().setUsageStyle(body.style));
	} catch (cause) {
		error(500, `用量列樣式存不進去：${(cause as Error).message}`);
	}
};
