import { json } from '@sveltejs/kit';
import type { TestDeviceView } from '#lib/board/test-device.ts';
import { clearDeviceCookie } from '#lib/server/auth.ts';
import { getBoard } from '#lib/server/board.ts';
import { revokeDevice } from '#lib/server/devices.ts';
import type { RequestHandler } from './$types';

/** This device's test login terms, with the agents it started so far; null for a password device. */
export const GET: RequestHandler = ({ locals }) => {
	const test = locals.device?.test;
	const view: TestDeviceView | null = test ? { label: test.label, expiresAt: test.expiresAt, owned: test.owned } : null;
	return json({ test: view });
};

/** 登出: end this device's login on the server, as `board revoke` would, and clear its cookie. Only a
 *  logged-in device gets here (hooks.server.ts); a cross-site form is refused before it, by SvelteKit. */
export const DELETE: RequestHandler = ({ locals, cookies }) => {
	revokeDevice(getBoard().config.stateDir, locals.device!.id);
	clearDeviceCookie(cookies, locals.https);
	return json({ ok: true });
};
