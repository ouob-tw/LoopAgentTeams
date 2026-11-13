import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { takeEnrollment } from '#lib/server/login-steps.ts';
import { addDevicePasskey, listPasskeys, type Passkey } from '#lib/server/passkeys.ts';
import { verifyEnroll } from '#lib/server/webauthn.ts';
import type { RequestHandler } from './$types';

/** What the settings show of the registered passkeys, and the only address they work from (null
 *  when the board's address is not set). Keys and credential IDs stay on the server. */
export const GET: RequestHandler = () => {
	const { config } = getBoard();
	let passkeys: Passkey[];
	try {
		passkeys = listPasskeys(config.stateDir);
	} catch (error) {
		console.error(`看板 passkey 檔讀不出來：${(error as Error).message}`);
		return json({ error: 'passkeys_unreadable' }, { status: 500 });
	}
	return json({
		origin: config.passkeySite?.origin ?? null,
		passkeys: passkeys.map(({ id, label, createdAt, lastUsedAt }) => ({ id, label, createdAt, lastUsedAt }))
	});
};

/** The end of registering a passkey from the settings: the browser's new passkey, for the
 *  registration this device started (/api/passkeys/options). A logged-in device needs no code. */
export const POST: RequestHandler = async ({ request, locals }) => {
	const { config } = getBoard();
	const body = await request.json().catch(() => null);
	const token = typeof body?.enrollment === 'string' ? body.enrollment : '';
	const response = body?.response;
	if (!token || !response || typeof response !== 'object') return json({ error: 'passkey_failed' }, { status: 400 });
	const site = config.passkeySite;
	if (!site || !locals.https) return json({ error: 'passkey_unavailable' }, { status: 409 });
	const enrollment = takeEnrollment(token, config.now());
	if (!enrollment || enrollment.deviceId !== locals.device!.id) return json({ error: 'enroll_expired' }, { status: 401 });
	const created = await verifyEnroll(site, enrollment.challenge, response);
	if (!created) return json({ error: 'passkey_failed' }, { status: 401 });
	try {
		const { id } = addDevicePasskey(config.stateDir, config.now(), { ...created, label: request.headers.get('user-agent') ?? '' });
		return json({ enrolled: id });
	} catch (error) {
		console.error(`看板 passkey 檔寫不進去：${(error as Error).message}`);
		return json({ error: 'passkeys_unreadable' }, { status: 500 });
	}
};
