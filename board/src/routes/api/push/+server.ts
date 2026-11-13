import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import type { RequestHandler } from './$types';

/** The board's VAPID public key, this device's subscription endpoint (null when it has none), and
 *  why pushes cannot work on this board (null when they can; the key is null then). */
export const GET: RequestHandler = ({ locals }) => {
	const { push } = getBoard();
	return json({ publicKey: push.publicKey(), endpoint: locals.device ? push.endpointOf(locals.device.id) : null, problem: push.problem() });
};
