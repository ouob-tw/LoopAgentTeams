import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { finishLogin, locked, loginLimit, secondStepOpen } from '#lib/server/login-steps.ts';
import { useTotp } from '#lib/server/totp.ts';
import type { RequestHandler } from './$types';

/** The TOTP second step: the six digits of the authenticator app, within 5 minutes of the right
 *  password. A wrong code counts like a wrong password; only a right one clears the count and logs
 *  the device in. The code is never logged or echoed back. */
export const POST: RequestHandler = async ({ request, cookies, locals }) => {
	const { config } = getBoard();
	const limit = loginLimit(config);
	const body = await request.json().catch(() => null);
	const code = typeof body?.code === 'string' ? body.code.trim() : '';
	if (!code) return json({ error: 'wrong_code' }, { status: 401 });

	const source = locals.clientAddress;
	const wait = limit.admit(source);
	if (wait) return locked(wait);
	const now = config.now();
	if (!secondStepOpen(cookies, now)) {
		limit.refund(source);
		return json({ error: 'second_step_expired' }, { status: 401 });
	}
	let right: boolean | null;
	try {
		right = useTotp(config.stateDir, code, now);
	} catch (error) {
		limit.refund(source);
		console.error(`看板 TOTP 金鑰檔讀不出來：${(error as Error).message}`);
		return json({ error: 'second_step_unreadable' }, { status: 500 });
	}
	if (right === null) {
		limit.refund(source);
		return json({ error: 'no_second_step' }, { status: 409 });
	}
	const lockedFor = right ? limit.succeeded(source) : limit.failed(source);
	if (lockedFor) return locked(lockedFor);
	if (!right) return json({ error: 'wrong_code' }, { status: 401 });
	finishLogin(config, cookies, locals.https, request.headers.get('user-agent') ?? '', 'totp');
	return json({ loggedIn: true });
};
