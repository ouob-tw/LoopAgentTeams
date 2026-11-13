import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { keepChallenge, secondStepOpen } from '#lib/server/login-steps.ts';
import { listPasskeys, type Passkey } from '#lib/server/passkeys.ts';
import { loginOptions } from '#lib/server/webauthn.ts';
import type { RequestHandler } from './$types';

/** What the browser signs for the passkey second step: a fresh challenge for this browser's open
 *  step, for any registered passkey. Asking proves nothing, so it neither counts nor clears. */
export const POST: RequestHandler = async ({ cookies }) => {
	const { config } = getBoard();
	const now = config.now();
	if (!secondStepOpen(cookies, now)) return json({ error: 'second_step_expired' }, { status: 401 });
	if (!config.passkeySite) return json({ error: 'passkey_unavailable' }, { status: 409 });
	let passkeys: Passkey[];
	try {
		passkeys = listPasskeys(config.stateDir);
	} catch (error) {
		console.error(`看板 passkey 檔讀不出來：${(error as Error).message}`);
		return json({ error: 'passkeys_unreadable' }, { status: 500 });
	}
	if (!passkeys.length) return json({ error: 'no_passkey' }, { status: 409 });
	const options = await loginOptions(config.passkeySite, passkeys);
	keepChallenge(cookies, now, options.challenge);
	return json(options);
};
