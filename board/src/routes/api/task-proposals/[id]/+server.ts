import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { PROPOSAL_ID } from '#lib/board/task-proposals.ts';
import type { RequestHandler } from './$types';

/** One 任務提案 with its result, if it has one. A malformed ID gets the generic 400. */
export const GET: RequestHandler = ({ params }) => {
	if (!PROPOSAL_ID.test(params.id)) return json({ error: 'bad-request' }, { status: 400 });
	const detail = getBoard().taskProposals.detail(params.id);
	return detail ? json(detail) : json({ error: 'not-found' }, { status: 404 });
};
