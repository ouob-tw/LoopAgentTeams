import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { keepPasswordlessChallenge } from '#lib/server/login-steps.ts';
import { listPasskeys, type Passkey } from '#lib/server/passkeys.ts';
import { loginOptions, TIMEOUT_MS } from '#lib/server/webauthn.ts';
import type { RequestHandler } from './$types';

/** What the browser signs to log in with a passkey alone: a fresh challenge for any registered
 *  passkey, which must check who holds it. Asking proves nothing, so it neither counts nor clears. */
export const POST: RequestHandler = async ({ locals }) => {
	const { config } = getBoard();
	// Over plain http a passkey is never used, whatever the page.
	if (!config.passkeySite || !locals.https) return json({ error: 'passkey_unavailable' }, { status: 409 });
	let passkeys: Passkey[];
	try {
		passkeys = listPasskeys(config.stateDir);
	} catch (error) {
		console.error(`看板 passkey 檔讀不出來：${(error as Error).message}`);
		return json({ error: 'passkeys_unreadable' }, { status: 500 });
	}
	if (!passkeys.length) return json({ error: 'no_passkey' }, { status: 409 });
	const options = await loginOptions(config.passkeySite, passkeys, 'alone');
	const now = config.now();
	keepPasswordlessChallenge(options.challenge, now + TIMEOUT_MS, now);
	return json(options);
};
