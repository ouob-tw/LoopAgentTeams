import { json } from '@sveltejs/kit';
import { audited, passkeyCause } from '#lib/server/auth-log.ts';
import { getBoard } from '#lib/server/board.ts';
import { setDemoShared } from '#lib/server/demo-share.ts';
import { openRequest, removeRequest, takeConfirmChallenge } from '#lib/server/demo-share-requests.ts';
import { log } from '#lib/server/log.ts';
import { listPasskeys, recordUse, type Passkey } from '#lib/server/passkeys.ts';
import { verifyLogin } from '#lib/server/webauthn.ts';
import type { RequestHandler } from './$types';

/** Confirm an agent's request to share a demo: the browser's answer to the challenge this device
 *  was given for this demo (./options), signed with the holder checked. Only then is the demo
 *  shared as it is published now (demo-share.ts) and the request removed; a failed check leaves
 *  the request as it was and shares nothing. No refusal here is a 401, which the page takes for a
 *  device no longer logged in. */
export const POST: RequestHandler = audited('demo_share_confirm', async ({ params, request, locals }, note) => {
	const { config } = getBoard();
	const name = params.name;
	const body = await request.json().catch(() => null);
	const response = body?.response;
	if (!response || typeof response !== 'object' || typeof response.id !== 'string') return json({ error: 'passkey_failed' }, { status: 400 });
	const site = config.passkeySite;
	if (!site || !locals.https) return json({ error: 'passkey_unavailable', origin: site?.origin ?? null }, { status: 409 });
	const dirs = { requestsDir: config.demoRequestsDir, siteDir: config.demoSiteDir, stateDir: config.stateDir };
	if (!openRequest(dirs, name)) return json({ error: 'no_request' }, { status: 404 });
	let passkeys: Passkey[];
	try {
		passkeys = listPasskeys(config.stateDir);
	} catch (error) {
		console.error(`看板 passkey 檔讀不出來：${(error as Error).message}`);
		return json({ error: 'passkeys_unreadable' }, { status: 500 });
	}
	const passkey = passkeys.find((candidate) => candidate.credentialId === response.id);
	note.passkey_id = passkey?.id;
	const deviceId = locals.device!.id;
	const counter = passkey ? await verifyLogin(site, (challenge) => takeConfirmChallenge(challenge, deviceId, name, config.now()), response, passkey, 'alone') : null;
	let right = false;
	if (counter !== null) {
		try {
			right = recordUse(config.stateDir, passkey!.credentialId, counter, config.now());
		} catch (error) {
			console.error(`看板 passkey 檔寫不進去：${(error as Error).message}`);
			return json({ error: 'passkeys_unreadable' }, { status: 500 });
		}
	}
	note.cause = passkeyCause({ site, passkey, challenge: true, counter, right });
	if (!right) return json({ error: 'passkey_failed' }, { status: 403 });
	// Checked again with nothing awaited before sharing: the page may have been published again
	// while the passkey was being used, and that page is not the one the request was about.
	if (!openRequest(dirs, name)) return json({ error: 'no_request' }, { status: 404 });
	try {
		if (!setDemoShared(config.stateDir, config.demoSiteDir, name, true)) return json({ error: 'no_request' }, { status: 404 });
		removeRequest(config.demoRequestsDir, name);
	} catch (error) {
		console.error(`示意頁分享設定存不進去：${(error as Error).message}`);
		return json({ error: 'not_saved' }, { status: 500 });
	}
	log('INFO', 'board.demo', 'demo_share_changed', { name, shared: true, via: 'request' });
	void getBoard().refresh();
	return json({ shared: name });
});
