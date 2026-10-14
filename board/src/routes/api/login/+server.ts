import { json } from '@sveltejs/kit';
import { setDeviceCookie } from '#lib/server/auth.ts';
import { getBoard } from '#lib/server/board.ts';
import { registerDevice } from '#lib/server/devices.ts';
import { createLoginLimit } from '#lib/server/login-limit.ts';
import { checkPassword } from '#lib/server/password.ts';
import type { RequestHandler } from './$types';

const limit = createLoginLimit(getBoard().config.loginLockMs);

const locked = (seconds: number) =>
	json({ error: 'locked', retryAfterSeconds: seconds }, { status: 429, headers: { 'retry-after': String(seconds) } });

// The password is never logged or echoed back, whatever happens.
export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
	const { stateDir } = getBoard().config;
	const body = await request.json().catch(() => null);
	const password = typeof body?.password === 'string' ? body.password : '';
	if (!password) return json({ error: 'wrong_password' }, { status: 401 });

	const source = getClientAddress();
	const wait = limit.begin(source);
	if (wait) return locked(wait);
	let matches: boolean | null;
	try {
		matches = await checkPassword(stateDir, password);
	} catch (error) {
		limit.uncounted(source);
		console.error(`看板密碼檔讀不出來：${(error as Error).message}`);
		return json({ error: 'password_unreadable' }, { status: 500 });
	}
	if (matches === null) {
		limit.uncounted(source);
		return json({ error: 'no_password' }, { status: 409 });
	}
	if (!matches) {
		const lockedFor = limit.failed(source);
		return lockedFor ? locked(lockedFor) : json({ error: 'wrong_password' }, { status: 401 });
	}
	limit.succeeded(source);
	const { token } = registerDevice(stateDir, request.headers.get('user-agent') ?? '');
	setDeviceCookie(cookies, token);
	return json({ loggedIn: true });
};
