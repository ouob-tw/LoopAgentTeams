import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { checkAssertion, pdApprove } from '#lib/server/pd.ts';
import type { RequestHandler } from './$types';

/** An assertion is a few hundred bytes; anything far larger is not one. */
const MAX_BODY = 64 * 1024;

/** Hand the page's passkey assertion for one waiting request to `pd passkey approve <id>` on stdin.
 *  pd's daemon verifies it; without the user's passkey nothing here can approve. Every open page
 *  then reads the list again. */
export const POST: RequestHandler = async ({ request }) => {
	const raw = await request.text().catch(() => '');
	let body: { id?: unknown; credential?: unknown } | null = null;
	try {
		body = raw.length <= MAX_BODY ? JSON.parse(raw) : null;
	} catch {
		// Not JSON: answered below.
	}
	const id = body?.id;
	if (!Number.isInteger(id) || (id as number) < 1) return json({ error: '請求編號必須是正整數' }, { status: 400 });
	const assertion = checkAssertion(body?.credential);
	if (!assertion) return json({ error: '不是 passkey 簽章' }, { status: 400 });
	const board = getBoard();
	const reply = await pdApprove(board.config.pdCommand, id as number, assertion, board.config.pdTimeoutMs);
	await board.refreshPd();
	return json(reply.body, { status: reply.status });
};
