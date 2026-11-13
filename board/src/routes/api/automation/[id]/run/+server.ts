import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import type { RequestHandler } from './$types';

/** 立即執行: 202 with the run once it has started; 409 with `message` while the task is running. */
export const POST: RequestHandler = ({ params }) => {
	const started = getBoard().automation.runNow(params.id);
	return started.ok ? json(started.run, { status: 202 }) : json({ message: started.message }, { status: started.status });
};
