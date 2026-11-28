import { json } from '@sveltejs/kit';
import { audited } from '#lib/server/auth-log.ts';
import { getBoard } from '#lib/server/board.ts';
import { bodyOf } from '#lib/server/task-proposal-approval.ts';
import { PROPOSAL_ID } from '#lib/board/task-proposals.ts';
import type { RequestHandler } from './$types';

/** 核准: a one-time passkey challenge for this proposal at the version the card showed
 *  (`contentHash`); refused when the proposal changed since. Only a logged-in device that is no
 *  test login gets here. Asking proves nothing: its 登入紀錄 line is a start. */
export const POST: RequestHandler = audited(
	'task_proposal_challenge',
	async ({ params, request, locals }) => {
		const body = await bodyOf(request);
		if (!PROPOSAL_ID.test(params.id) || !body) return json({ error: 'bad-request' }, { status: 400 });
		const answer = await getBoard().taskProposals.challenge(params.id, body, locals.device!, locals.https);
		return json(answer.body, { status: answer.status });
	},
	{ start: true }
);
