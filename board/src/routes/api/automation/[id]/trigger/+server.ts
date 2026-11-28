import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import type { RequestHandler } from './$types';

/** 立即觸發 (#763): an event task waiting for its event hands over now, recorded as 使用者手動觸發.
 *  202 with the handoff's run; 409 with `message` in any other state. */
export const POST: RequestHandler = ({ params }) => {
	const started = getBoard().automation.triggerNow(params.id);
	return started.ok ? json(started.run, { status: 202 }) : json({ message: started.message }, { status: started.status });
};
