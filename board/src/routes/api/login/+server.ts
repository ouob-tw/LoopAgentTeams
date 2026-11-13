import { json } from '@sveltejs/kit';
import { setDeviceCookie } from '#lib/server/auth.ts';
import { getBoard } from '#lib/server/board.ts';
import { registerDevice } from '#lib/server/devices.ts';
import { log } from '#lib/server/log.ts';
import { createLoginLimit, fileStore, type LoginLimit } from '#lib/server/login-limit.ts';
import { checkPassword } from '#lib/server/password.ts';
import type { RequestHandler } from './$types';

let limit: LoginLimit | undefined;

const locked = (seconds: number) =>
	json({ error: 'locked', retryAfterSeconds: seconds }, { status: 429, headers: { 'retry-after': String(seconds) } });

// The password is never logged or echoed back, whatever happens.
export const POST: RequestHandler = async ({ request, cookies, locals }) => {
	const { config } = getBoard();
	// A lock is written down with the browser's own address; single wrong passwords are not.
	limit ??= createLoginLimit(config.loginLockMs, config.now, fileStore(config.stateDir), (source) =>
		log('WARNING', 'board.login', 'login_locked', { client_ip: source, lock_seconds: config.loginLockMs / 1000 })
	);
	const body = await request.json().catch(() => null);
	const password = typeof body?.password === 'string' ? body.password : '';
	if (!password) return json({ error: 'wrong_password' }, { status: 401 });

	// The browser's own address, also behind a trusted proxy (hooks.server.ts).
	const source = locals.clientAddress;
	const wait = limit.admit(source);
	if (wait) return locked(wait);
	let matches: boolean | null;
	try {
		matches = await checkPassword(config.stateDir, password);
	} catch (error) {
		limit.refund(source);
		console.error(`看板密碼檔讀不出來：${(error as Error).message}`);
		return json({ error: 'password_unreadable' }, { status: 500 });
	}
	if (matches === null) {
		limit.refund(source);
		return json({ error: 'no_password' }, { status: 409 });
	}
	const lockedFor = matches ? limit.succeeded(source) : limit.failed(source);
	if (lockedFor) return locked(lockedFor);
	if (!matches) return json({ error: 'wrong_password' }, { status: 401 });
	const { token } = registerDevice(config.stateDir, request.headers.get('user-agent') ?? '', config.now());
	setDeviceCookie(cookies, token, locals.https);
	return json({ loggedIn: true });
};
