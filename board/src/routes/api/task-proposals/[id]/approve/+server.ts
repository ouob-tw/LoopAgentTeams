import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { PROPOSAL_ID } from '#lib/board/task-proposals.ts';
import type { RequestHandler } from './$types';

/** An assertion is a few hundred bytes; anything far larger is not one. */
const MAX_BODY = 64 * 1024;

/** The board passkey's answer to this proposal's challenge: the task is made when every check holds. */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!PROPOSAL_ID.test(params.id)) return json({ error: 'bad-request' }, { status: 400 });
	const raw = await request.text().catch(() => '');
	let body: unknown = null;
	try {
		body = raw.length <= MAX_BODY ? JSON.parse(raw) : null;
	} catch {
		// Not JSON: the generic 400 below.
	}
	if (!body || typeof body !== 'object') return json({ error: 'bad-request' }, { status: 400 });
	const answer = await getBoard().taskProposals.approve(params.id, body, locals.device!, locals.https);
	return json(answer.body, { status: answer.status });
};
