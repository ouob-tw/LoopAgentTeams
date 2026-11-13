import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { locked, loginLimit, startEnrollment } from '#lib/server/login-steps.ts';
import { enrollCodeHash, enrollCodeWorks, listPasskeys, type Passkey } from '#lib/server/passkeys.ts';
import { checkPassword } from '#lib/server/password.ts';
import { enrollOptions } from '#lib/server/webauthn.ts';
import type { RequestHandler } from './$types';

/** The start of registering a passkey: the password and the host's registration code, both right,
 *  give the browser what to create. A wrong one counts like a wrong password; right ones neither
 *  count nor clear, as registering logs nothing in. Neither is logged or echoed back. */
export const POST: RequestHandler = async ({ request, locals }) => {
	const { config } = getBoard();
	const limit = loginLimit(config);
	const body = await request.json().catch(() => null);
	const password = typeof body?.password === 'string' ? body.password : '';
	const code = typeof body?.code === 'string' ? body.code.trim() : '';
	if (!password) return json({ error: 'wrong_password' }, { status: 401 });
	if (!code) return json({ error: 'wrong_enroll_code' }, { status: 401 });
	const site = config.passkeySite;
	if (!site) return json({ error: 'passkey_unavailable' }, { status: 409 });

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
	let passkeys: Passkey[];
	let codeWorks: boolean;
	try {
		passkeys = listPasskeys(config.stateDir);
		codeWorks = enrollCodeWorks(config.stateDir, code, config.now());
	} catch (error) {
		limit.refund(source);
		console.error(`看板 passkey 檔讀不出來：${(error as Error).message}`);
		return json({ error: 'passkeys_unreadable' }, { status: 500 });
	}
	if (matches === null) {
		limit.refund(source);
		return json({ error: 'no_password' }, { status: 409 });
	}
	if (!matches || !codeWorks) {
		const lockedFor = limit.failed(source);
		return lockedFor ? locked(lockedFor) : json({ error: matches ? 'wrong_enroll_code' : 'wrong_password' }, { status: 401 });
	}
	limit.refund(source);
	const options = await enrollOptions(site, passkeys);
	return json({ options, enrollment: startEnrollment(options.challenge, enrollCodeHash(code), config.now()) });
};
