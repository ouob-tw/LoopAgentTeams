import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { startEnrollment } from '#lib/server/login-steps.ts';
import { listPasskeys, type Passkey } from '#lib/server/passkeys.ts';
import { enrollOptions } from '#lib/server/webauthn.ts';
import type { RequestHandler } from './$types';

/** The start of registering a passkey from the settings of a logged-in device (a test device is
 *  refused before this runs): what the browser is to create, and the token only this device can
 *  finish it with. Only over HTTPS at the board's address; the authenticator checks who holds it. */
export const POST: RequestHandler = async ({ locals }) => {
	const { config } = getBoard();
	const site = config.passkeySite;
	if (!site || !locals.https) return json({ error: 'passkey_unavailable' }, { status: 409 });
	let passkeys: Passkey[];
	try {
		passkeys = listPasskeys(config.stateDir);
	} catch (error) {
		console.error(`看板 passkey 檔讀不出來：${(error as Error).message}`);
		return json({ error: 'passkeys_unreadable' }, { status: 500 });
	}
	const options = await enrollOptions(site, passkeys);
	return json({ options, enrollment: startEnrollment(options.challenge, { deviceId: locals.device!.id }, config.now()) });
};
