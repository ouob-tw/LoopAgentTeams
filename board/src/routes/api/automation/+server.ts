import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import type { RequestHandler } from './$types';

/** The 自動化 tab's tasks with their states and latest runs. */
export const GET: RequestHandler = () => json(getBoard().automation.snapshot());

/** Add a task. 400 with `errors` (field → what is wrong) when the form is not right; nothing is written then. */
export const POST: RequestHandler = async ({ request }) => {
	const saved = getBoard().automation.create(await request.json().catch(() => null));
	return saved.ok ? json(saved.task, { status: 201 }) : json({ errors: saved.errors }, { status: saved.status });
};
