import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { renameAgentTab } from '#lib/server/tab-control.ts';
import { tabTarget } from '../target.ts';
import type { RequestHandler } from './$types';

/** Rename a Herdr tab. Every attempt answers with its sent-log entry; a blank name is not one. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const target = tabTarget(body);
	const label = typeof body?.label === 'string' ? body.label.trim() : '';
	if (!target || !label) return json({ error: 'invalid_rename' }, { status: 400 });
	const result = await renameAgentTab(getBoard(), target, label);
	return json(result.body, { status: result.status });
};
