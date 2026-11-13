import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { finishLogin, locked, loginLimit, usePasswordlessChallenge } from '#lib/server/login-steps.ts';
import { listPasskeys, recordUse, type Passkey } from '#lib/server/passkeys.ts';
import { verifyLogin } from '#lib/server/webauthn.ts';
import type { RequestHandler } from './$types';

/** A login with a passkey alone, no password: the browser's answer to a challenge given by
 *  /api/login/passwordless/options, signed with the holder checked. A failed check counts like a
 *  wrong password; only a passed one clears the count and logs the device in. Each challenge is
 *  answered once. */
export const POST: RequestHandler = async ({ request, cookies, locals }) => {
	const { config } = getBoard();
	const limit = loginLimit(config);
	const body = await request.json().catch(() => null);
	const response = body?.response;
	if (!response || typeof response !== 'object' || typeof response.id !== 'string') return json({ error: 'passkey_failed' }, { status: 400 });

	const source = locals.clientAddress;
	const wait = limit.admit(source);
	if (wait) return locked(wait);
	const site = config.passkeySite;
	if (!site || !locals.https) {
		limit.refund(source);
		return json({ error: 'passkey_unavailable' }, { status: 409 });
	}
	let passkeys: Passkey[];
	try {
		passkeys = listPasskeys(config.stateDir);
	} catch (error) {
		limit.refund(source);
		console.error(`看板 passkey 檔讀不出來：${(error as Error).message}`);
		return json({ error: 'passkeys_unreadable' }, { status: 500 });
	}
	const passkey = passkeys.find((candidate) => candidate.credentialId === response.id);
	const counter = passkey ? await verifyLogin(site, (challenge) => usePasswordlessChallenge(challenge, config.now()), response, passkey, 'alone') : null;
	let right = false;
	if (counter !== null) {
		try {
			right = recordUse(config.stateDir, passkey!.credentialId, counter, config.now());
		} catch (error) {
			limit.refund(source);
			console.error(`看板 passkey 檔寫不進去：${(error as Error).message}`);
			return json({ error: 'passkeys_unreadable' }, { status: 500 });
		}
	}
	const lockedFor = right ? limit.succeeded(source) : limit.failed(source);
	if (lockedFor) return locked(lockedFor);
	if (!right) return json({ error: 'passkey_failed' }, { status: 401 });
	finishLogin(config, cookies, locals.https, request.headers.get('user-agent') ?? '', 'passkey');
	return json({ loggedIn: true });
};
