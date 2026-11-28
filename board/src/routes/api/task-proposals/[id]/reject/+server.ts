import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { bodyOf } from '#lib/server/task-proposal-approval.ts';
import { PROPOSAL_ID } from '#lib/board/task-proposals.ts';
import type { RequestHandler } from './$types';

/** 拒絕: end a waiting proposal, with the user's reason when one is given (`reason`). No passkey. */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	const body = await bodyOf(request, { empty: true });
	if (!PROPOSAL_ID.test(params.id) || body === undefined) return json({ error: 'bad-request' }, { status: 400 });
	const answer = getBoard().taskProposals.reject(params.id, body, locals.device!);
	return json(answer.body, { status: answer.status });
};
