import { json } from '@sveltejs/kit';
import { resendNotification } from '#lib/server/answer.ts';
import { getBoard } from '#lib/server/board.ts';
import type { RequestHandler } from './$types';

/** Resend the notification of a controller's sent answers. Only ever on the user's request. */
export const POST: RequestHandler = async ({ request }) => {
	const body: { controllerId?: unknown } | null = await request.json().catch(() => null);
	const controllerId = body?.controllerId;
	if (typeof controllerId !== 'string' || !controllerId) return json({ error: 'missing_controller' }, { status: 400 });
	const result = await resendNotification(getBoard(), controllerId);
	return json(result.body, { status: result.status });
};
