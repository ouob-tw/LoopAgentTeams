import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import type { RequestHandler } from './$types';

/** 停止這次: 202 once the running run is told to stop (its record says so when it has ended); 409 when none runs. */
export const POST: RequestHandler = ({ params }) => {
	const stopped = getBoard().automation.stop(params.id);
	if (stopped === null) return json({ message: '這個任務已不存在' }, { status: 404 });
	return stopped ? json({ ok: true }, { status: 202 }) : json({ message: '這個任務現在沒有在跑' }, { status: 409 });
};
