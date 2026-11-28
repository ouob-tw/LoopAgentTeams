import { json } from '@sveltejs/kit';
import { audited } from '#lib/server/auth-log.ts';
import { getBoard } from '#lib/server/board.ts';
import { keepConfirmChallenge, openRequest } from '#lib/server/demo-share-requests.ts';
import { listPasskeys, type Passkey } from '#lib/server/passkeys.ts';
import { loginOptions, TIMEOUT_MS } from '#lib/server/webauthn.ts';
import type { RequestHandler } from './$types';

/** The start of confirming an agent's request to share a demo (a test device is refused before
 *  this runs): what the browser is to sign, with any registered passkey that checks who holds it.
 *  The challenge is for this device and this demo only. Only over HTTPS at the board's address. */
export const POST: RequestHandler = audited(
	'demo_share_confirm',
	async ({ params, locals }) => {
		const { config } = getBoard();
		const site = config.passkeySite;
		if (!site || !locals.https) return json({ error: 'passkey_unavailable', origin: site?.origin ?? null }, { status: 409 });
		if (!openRequest({ requestsDir: config.demoRequestsDir, siteDir: config.demoSiteDir, stateDir: config.stateDir }, params.name))
			return json({ error: 'no_request' }, { status: 404 });
		let passkeys: Passkey[];
		try {
			passkeys = listPasskeys(config.stateDir);
		} catch (error) {
			console.error(`看板 passkey 檔讀不出來：${(error as Error).message}`);
			return json({ error: 'passkeys_unreadable' }, { status: 500 });
		}
		if (!passkeys.length) return json({ error: 'no_passkey' }, { status: 409 });
		const options = await loginOptions(site, passkeys, 'alone');
		const now = config.now();
		keepConfirmChallenge(options.challenge, locals.device!.id, params.name, now + TIMEOUT_MS, now);
		return json(options);
	},
	{ start: true }
);
