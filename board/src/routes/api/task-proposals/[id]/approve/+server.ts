import { json } from '@sveltejs/kit';
import { audited } from '#lib/server/auth-log.ts';
import { getBoard } from '#lib/server/board.ts';
import { bodyOf } from '#lib/server/task-proposal-approval.ts';
import { PROPOSAL_ID } from '#lib/board/task-proposals.ts';
import type { RequestHandler } from './$types';

/** The board passkey's answer to this proposal's challenge (`response`): the task is made when
 *  every check holds. Its 登入紀錄 line names the passkey and why it failed. */
export const POST: RequestHandler = audited('task_proposal_approve', async ({ params, request, locals }, note) => {
	const body = await bodyOf(request);
	if (!PROPOSAL_ID.test(params.id) || !body) return json({ error: 'bad-request' }, { status: 400 });
	const answer = await getBoard().taskProposals.approve(params.id, body, locals.device!, locals.https);
	if (answer.audit?.passkey_id) note.passkey_id = answer.audit.passkey_id;
	if (answer.audit?.cause) note.cause = answer.audit.cause;
	return json(answer.body, { status: answer.status });
});
