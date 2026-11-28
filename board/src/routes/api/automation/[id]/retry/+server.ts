import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import type { RequestHandler } from './$types';

/** 重試接手 (#763): the event task's 接手失敗 or 接手結果不明 handoff tried again with the same event.
 *  202 with the new attempt's run; 409 with `message` while one is going or there is none to retry. */
export const POST: RequestHandler = ({ params }) => {
	const started = getBoard().automation.retryHandoff(params.id);
	return started.ok ? json(started.run, { status: 202 }) : json({ message: started.message }, { status: started.status });
};
