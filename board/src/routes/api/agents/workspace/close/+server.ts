import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { workspaceContents } from '#lib/server/herdr.ts';
import { closeHerdrWorkspace } from '#lib/server/tab-control.ts';
import type { RequestHandler } from './$types';

/** What closing the workspace would take with it, read now, for the user to confirm. */
export const GET: RequestHandler = async ({ url }) => {
	const workspace = url.searchParams.get('workspace');
	if (!workspace) return json({ error: 'invalid_workspace' }, { status: 400 });
	const contents = await workspaceContents(getBoard().config, workspace);
	if (contents === null) return json({ reason: '工作區已不在 Herdr 的清單上。' }, { status: 404 });
	if ('reason' in contents) return json({ reason: contents.reason }, { status: 502 });
	return json(contents);
};

/** Close a Herdr workspace with what the user confirmed is in it. Every attempt answers with its
 *  sent-log entry. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const { workspace, agents, tabs } = (body ?? {}) as Record<string, unknown>;
	const count = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;
	if (typeof workspace !== 'string' || !workspace || !count(agents) || !count(tabs)) return json({ error: 'invalid_close' }, { status: 400 });
	const result = await closeHerdrWorkspace(getBoard(), workspace, { agents, tabs });
	return json(result.body, { status: result.status });
};
