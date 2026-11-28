import { json } from '@sveltejs/kit';
import { audited, passkeyCause } from '#lib/server/auth-log.ts';
import { getBoard } from '#lib/server/board.ts';
import { demoFolderId } from '#lib/server/demo.ts';
import { setDemoShared } from '#lib/server/demo-share.ts';
import { openRequest, removeRequest, takeConfirmChallenge } from '#lib/server/demo-share-requests.ts';
import { log } from '#lib/server/log.ts';
import { listPasskeys, recordUse, type Passkey } from '#lib/server/passkeys.ts';
import { verifyLogin } from '#lib/server/webauthn.ts';
import type { RequestHandler } from './$types';

/** Confirm an agent's request to share a demo: the browser's answer to the challenge this device
 *  was given for this version of the demo (./options), signed with the holder checked. Only then,
 *  and only while that version is still the one published, is the demo shared (demo-share.ts) and
 *  the request removed; a failed check leaves
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
	const open = openRequest(config, name);
	if (!open) return json({ error: 'no_request' }, { status: 404 });
	const purpose = { deviceId: locals.device!.id, name, folder: open.folder };
	let passkeys: Passkey[];
	try {
		passkeys = listPasskeys(config.stateDir);
	} catch (error) {
		console.error(`看板 passkey 檔讀不出來：${(error as Error).message}`);
		return json({ error: 'passkeys_unreadable' }, { status: 500 });
	}
	const passkey = passkeys.find((candidate) => candidate.credentialId === response.id);
	note.passkey_id = passkey?.id;
	const counter = passkey ? await verifyLogin(site, (challenge) => takeConfirmChallenge(challenge, purpose, config.now()), response, passkey, 'alone') : null;
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
	// while the passkey was being used, and that version is not the one confirmed. The share is
	// pinned to the folder read before this check, so one put in place after it is not shared.
	const sharedAs = demoFolderId(config.demoSiteDir, name);
	if (openRequest(config, name)?.folder !== purpose.folder) return json({ error: 'no_request' }, { status: 404 });
	try {
		if (!setDemoShared(config.stateDir, config.demoSiteDir, name, true, sharedAs)) return json({ error: 'no_request' }, { status: 404 });
	} catch (error) {
		console.error(`示意頁分享設定存不進去：${(error as Error).message}`);
		return json({ error: 'not_saved' }, { status: 500 });
	}
	try {
		removeRequest(config.demoRequestsDir, name);
	} catch (error) {
		// Shared all the same: a request for a shared demo is not listed.
		console.error(`示意頁分享申請刪不掉：${(error as Error).message}`);
	}
	log('INFO', 'board.demo', 'demo_share_changed', { name, shared: true, via: 'request' });
	void getBoard().refresh();
	return json({ shared: name });
});
