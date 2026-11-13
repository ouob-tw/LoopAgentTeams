import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { locked, loginLimit, openSecondStep, secondSteps, type SecondStep } from '#lib/server/login-steps.ts';
import { checkPassword } from '#lib/server/password.ts';
import type { RequestHandler } from './$types';

/** The first step of a login. The right password logs nothing in: it opens the second step
 *  (login-steps.ts) and neither counts nor clears a wrong attempt. The password is never logged or
 *  echoed back, whatever happens. */
export const POST: RequestHandler = async ({ request, cookies, locals }) => {
	const { config } = getBoard();
	const limit = loginLimit(config);
	const body = await request.json().catch(() => null);
	const password = typeof body?.password === 'string' ? body.password : '';
	if (!password) return json({ error: 'wrong_password' }, { status: 401 });

	// The browser's own address, also behind a trusted proxy (hooks.server.ts).
	const source = locals.clientAddress;
	const wait = limit.admit(source);
	if (wait) return locked(wait);
	// Checked before the password, so a board without a second step tells nobody whether a
	// password was right.
	let steps: SecondStep[];
	try {
		steps = secondSteps(config.stateDir);
	} catch (error) {
		limit.refund(source);
		console.error(`看板第二道驗證的設定檔讀不出來：${(error as Error).message}`);
		return json({ error: 'second_step_unreadable' }, { status: 500 });
	}
	if (!steps.length) {
		limit.refund(source);
		return json({ error: 'no_second_step' }, { status: 409 });
	}
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
	if (!matches) {
		const lockedFor = limit.failed(source);
		return lockedFor ? locked(lockedFor) : json({ error: 'wrong_password' }, { status: 401 });
	}
	limit.refund(source);
	const seconds = openSecondStep(cookies, locals.https, config.now());
	return json({ secondStep: steps, secondsLeft: seconds });
};
