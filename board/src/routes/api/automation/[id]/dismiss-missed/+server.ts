import { error, json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import type { RequestHandler } from './$types';

/** 這期就算了: the task's missed periods are no longer shown; `{ dismissed }` says how many. */
export const POST: RequestHandler = ({ params }) => {
	const dismissed = getBoard().automation.dismissMissed(params.id);
	if (dismissed === null) error(404, '這個任務已不存在');
	return json({ dismissed });
};
