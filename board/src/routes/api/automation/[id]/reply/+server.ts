import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import type { RequestHandler } from './$types';

/** 送出回覆: `{ text }`, the answer to the question the task's run waits on. 200 with the run once its
 *  agent was sent it; 409 when nothing waits, 400 when it is empty, 502 when it could not be sent. */
export const POST: RequestHandler = async ({ params, request }) => {
	const body = (await request.json().catch(() => ({}))) as { text?: unknown };
	const replied = await getBoard().automation.reply(params.id, body?.text);
	return replied.ok ? json(replied.run) : json({ message: replied.message }, { status: replied.status });
};
