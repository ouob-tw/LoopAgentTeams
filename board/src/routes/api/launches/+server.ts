import { isAbsolute } from 'node:path';
import { json } from '@sveltejs/kit';
import { isLaunchClient, TAB_NAME_MAX, WORKSPACE_NAME_MAX, type LaunchRequest, type WorkspacePick } from '#lib/board/launch.ts';
import { offered } from '#lib/board/models.ts';
import { getBoard } from '#lib/server/board.ts';
import { listLaunches, startLaunch } from '#lib/server/launch.ts';
import { typedText } from '#lib/server/send.ts';
import type { RequestHandler } from './$types';

/** A name as a tab or workspace title takes it: one line, no longer than `max`; undefined when it
 *  is not that. */
function titleText(value: unknown, max: number): string | undefined {
	if (typeof value !== 'string') return undefined;
	const name = value.trim();
	return name.length > max || /[\r\n]/.test(name) ? undefined : name;
}

/** A plain agent's tab name as the form sends it; undefined when it is not that. */
function agentPart(value: unknown): LaunchRequest['agent'] | undefined {
	if (value === undefined || value === null) return null;
	// One line in a tab's title, short enough for Herdr's tab bar.
	const tabName = titleText((value as Record<string, unknown>).tabName, TAB_NAME_MAX);
	return tabName === undefined ? undefined : { tabName };
}

/** The workspace as the form chose it; null when none was sent, undefined when it is not one. */
function workspacePart(value: unknown): WorkspacePick | null | undefined {
	if (value === undefined || value === null) return null;
	const { kind, id, label } = value as Record<string, unknown>;
	if (kind === 'auto') return { kind };
	if (kind === 'existing') return typeof id === 'string' && id ? { kind, id } : undefined;
	if (kind !== 'new') return undefined;
	const name = titleText(label, WORKSPACE_NAME_MAX);
	return name ? { kind, label: name } : undefined;
}

/** Start a new controller, or a plain agent in a Herdr workspace. Every attempt that was made
 *  answers with its sent-log entry. */
export const POST: RequestHandler = async ({ request }) => {
	const body: Partial<Record<keyof LaunchRequest, unknown>> | null = await request.json().catch(() => null);
	const { client, folder, text, gitInit, model = null, effort = null } = body ?? {};
	const agent = agentPart(body?.agent);
	const workspace = workspacePart(body?.workspace);
	const board = getBoard();
	if (
		agent === undefined ||
		workspace === undefined ||
		// A plain agent opens where the form says; a controller goes to its project's by default.
		(agent && !workspace) ||
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
	const result = await startLaunch(board, { client, folder, text, gitInit, model, effort, agent, workspace: workspace ?? { kind: 'auto' } });
	return json(result.body, { status: result.status });
};

/** The folders to choose from and the recent launches with where they stand. */
export const GET: RequestHandler = async () => json(await listLaunches(getBoard()));
