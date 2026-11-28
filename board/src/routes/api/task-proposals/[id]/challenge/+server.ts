import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { PROPOSAL_ID } from '#lib/board/task-proposals.ts';
import type { RequestHandler } from './$types';

/** 核准: a one-time passkey challenge for this proposal at the version the card showed
 *  (`contentHash`); refused when the proposal changed since. Only a logged-in device that is no
 *  test login gets here. */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!PROPOSAL_ID.test(params.id)) return json({ error: 'bad-request' }, { status: 400 });
	const body = await request.json().catch(() => null);
	const answer = await getBoard().taskProposals.challenge(params.id, body, locals.device!, locals.https);
	return json(answer.body, { status: answer.status });
};
