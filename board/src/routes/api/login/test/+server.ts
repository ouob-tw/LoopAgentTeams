import { json } from '@sveltejs/kit';
import { setDeviceCookie } from '#lib/server/auth.ts';
import { getBoard } from '#lib/server/board.ts';
import { redeemTestLogin } from '#lib/server/devices.ts';
import type { RequestHandler } from './$types';

/** Log this browser in as the test device whose one-time code it posts (`board test-login`). The
 *  code works once, before the login expires; the cookie ends with it. */
export const POST: RequestHandler = async ({ request, cookies }) => {
	const { config } = getBoard();
	const body = await request.json().catch(() => null);
	const code = typeof body?.code === 'string' ? body.code : '';
	const now = config.now();
	const redeemed = redeemTestLogin(config.stateDir, code, request.headers.get('user-agent') ?? '', now);
	if (!redeemed) return json({ error: 'test_login_unusable' }, { status: 401 });
	setDeviceCookie(cookies, redeemed.token, Math.max(1, Math.floor((Date.parse(redeemed.device.test!.expiresAt) - now) / 1000)));
	return json({ loggedIn: true, label: redeemed.device.test!.label, expiresAt: redeemed.device.test!.expiresAt });
};
