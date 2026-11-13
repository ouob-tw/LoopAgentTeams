import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { changeGrant } from '#lib/server/unattended.ts';
import type { RequestHandler } from './$types';

/** Turn a controller's unattended grant on (`create`), change it (`update`) or turn it off (`close`). */
export const POST: RequestHandler = async ({ request }) => {
	const done = await changeGrant(getBoard(), await request.json().catch(() => null));
	return json(done.body, { status: done.status });
};
