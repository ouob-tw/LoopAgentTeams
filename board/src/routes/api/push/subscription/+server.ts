import { error, json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import type { RequestHandler } from './$types';

/** 允許通知: keep this device's subscription (`PushSubscription.toJSON()`), in place of any it had.
 *  400 with `error` when it is not one a browser's push service gave. */
export const PUT: RequestHandler = async ({ locals, request }) => {
	if (!locals.device) error(401);
	const saved = getBoard().push.subscribe(locals.device.id, await request.json().catch(() => null));
	return saved.ok ? json({ ok: true }) : json({ error: saved.error }, { status: 400 });
};

/** 關閉通知: this device's subscription only; the other devices keep theirs. */
export const DELETE: RequestHandler = ({ locals }) => {
	if (!locals.device) error(401);
	return json({ removed: getBoard().push.unsubscribe(locals.device.id) });
};
