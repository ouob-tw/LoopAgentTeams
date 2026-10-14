import { isAbsolute } from 'node:path';
import { json } from '@sveltejs/kit';
import { isLaunchClient, type LaunchRequest } from '#lib/board/launch.ts';
import { offered } from '#lib/board/models.ts';
import { getBoard } from '#lib/server/board.ts';
import { listLaunches, startController } from '#lib/server/launch.ts';
import { typedText } from '#lib/server/send.ts';
import type { RequestHandler } from './$types';

/** Start a new controller. Every attempt that was made answers with its sent-log entry. */
export const POST: RequestHandler = async ({ request }) => {
	const body: Partial<Record<keyof LaunchRequest, unknown>> | null = await request.json().catch(() => null);
	const { client, folder, text, gitInit, model = null, effort = null } = body ?? {};
	const board = getBoard();
	if (
		!isLaunchClient(client) ||
		typeof folder !== 'string' ||
		!isAbsolute(folder) ||
		typeof text !== 'string' ||
		!typedText(text).trim() ||
		typeof gitInit !== 'boolean' ||
		(model !== null && typeof model !== 'string') ||
		(effort !== null && typeof effort !== 'string') ||
		!offered(board.config.modelOptions[client], { model, effort })
	) {
		return json({ error: 'invalid_launch' }, { status: 400 });
	}
	const result = await startController(board, { client, folder, text, gitInit, model, effort });
	return json(result.body, { status: result.status });
};

/** The folders to choose from and the recent launches with where they stand. */
export const GET: RequestHandler = async () => json(await listLaunches(getBoard()));
