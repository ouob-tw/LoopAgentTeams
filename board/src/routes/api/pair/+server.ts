import { json } from '@sveltejs/kit';
import { setDeviceCookie } from '#lib/server/auth.ts';
import { getBoard } from '#lib/server/board.ts';
import { pairDevice } from '#lib/server/devices.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, cookies }) => {
	const body = await request.json().catch(() => null);
	const code = typeof body?.code === 'string' ? body.code : '';
	const label = request.headers.get('user-agent') ?? '';
	const paired = code ? pairDevice(getBoard().config.stateDir, code, label) : null;
	if (!paired) return json({ error: 'invalid_code' }, { status: 400 });
	setDeviceCookie(cookies, paired.token);
	return json({ paired: true });
};
