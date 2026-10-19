import { isAbsolute } from 'node:path';
import { json } from '@sveltejs/kit';
import { isLaunchClient, TAB_NAME_MAX, type LaunchRequest } from '#lib/board/launch.ts';
import { offered } from '#lib/board/models.ts';
import { getBoard } from '#lib/server/board.ts';
import { listLaunches, startLaunch } from '#lib/server/launch.ts';
import { typedText } from '#lib/server/send.ts';
import type { RequestHandler } from './$types';

/** A plain agent's workspace and tab name as the form sends them; undefined when they are not that. */
function agentPart(value: unknown): LaunchRequest['agent'] | undefined {
	if (value === undefined || value === null) return null;
	const { workspace, tabName } = value as Record<string, unknown>;
	if (typeof workspace !== 'string' || !workspace || typeof tabName !== 'string') return undefined;
	const name = tabName.trim();
	// One line in a tab's title, short enough for Herdr's tab bar.
	if (name.length > TAB_NAME_MAX || /[\r\n]/.test(name)) return undefined;
	return { workspace, tabName: name };
}

/** Start a new controller, or a plain agent in a Herdr workspace. Every attempt that was made
 *  answers with its sent-log entry. */
export const POST: RequestHandler = async ({ request }) => {
	const body: Partial<Record<keyof LaunchRequest, unknown>> | null = await request.json().catch(() => null);
	const { client, folder, text, gitInit, model = null, effort = null } = body ?? {};
	const agent = agentPart(body?.agent);
	const board = getBoard();
	if (
		agent === undefined ||
		!isLaunchClient(client) ||
		typeof folder !== 'string' ||
		!isAbsolute(folder) ||
		typeof text !== 'string' ||
		// A controller's first message follows the LAT start command; a plain agent may get none.
		(!agent && !typedText(text).trim()) ||
		typeof gitInit !== 'boolean' ||
		// The board never runs `git init` for a plain agent.
		(agent && gitInit) ||
		(model !== null && typeof model !== 'string') ||
		(effort !== null && typeof effort !== 'string') ||
		!offered(board.config.modelOptions[client], { model, effort })
	) {
		return json({ error: 'invalid_launch' }, { status: 400 });
	}
	const result = await startLaunch(board, { client, folder, text, gitInit, model, effort, agent });
	return json(result.body, { status: result.status });
};

/** The folders to choose from and the recent launches with where they stand. */
export const GET: RequestHandler = async () => json(await listLaunches(getBoard()));
