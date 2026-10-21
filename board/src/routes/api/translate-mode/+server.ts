import { error, json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { isTranslateMode } from '#lib/server/translate-mode.ts';
import type { RequestHandler } from './$types';

/** Whether conversations open translated, the same on every logged-in device. */
export const GET: RequestHandler = () => json(getBoard().translateMode());

/** Change it. The new mode reaches every open page through the event stream. */
export const PUT: RequestHandler = async ({ request }) => {
	const body: { mode?: unknown } | null = await request.json().catch(() => null);
	if (!isTranslateMode(body?.mode)) error(400, '對話翻譯偏好必須是 auto 或 manual');
	try {
		return json(getBoard().setTranslateMode(body.mode));
	} catch (cause) {
		error(500, `對話翻譯偏好存不進去：${(cause as Error).message}`);
	}
};
