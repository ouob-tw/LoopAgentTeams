import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { locked, loginLimit, takeEnrollment } from '#lib/server/login-steps.ts';
import { addPasskey, type Passkey } from '#lib/server/passkeys.ts';
import { verifyEnroll } from '#lib/server/webauthn.ts';
import type { RequestHandler } from './$types';

/** The end of registering a passkey: the browser's new passkey, for the registration its
 *  `enrollment` token started. Saving it uses the registration code up. A failed check counts like
 *  a wrong password. Registering logs nothing in. */
export const POST: RequestHandler = async ({ request, locals }) => {
	const { config } = getBoard();
	const limit = loginLimit(config);
	const body = await request.json().catch(() => null);
	const token = typeof body?.enrollment === 'string' ? body.enrollment : '';
	const response = body?.response;
	if (!token || !response || typeof response !== 'object') return json({ error: 'passkey_failed' }, { status: 400 });
	const site = config.passkeySite;
	const enrollment = takeEnrollment(token, config.now());
	if (!site || !enrollment) return json({ error: 'enroll_expired' }, { status: 401 });

	const source = locals.clientAddress;
	const wait = limit.admit(source);
	if (wait) return locked(wait);
	const created = await verifyEnroll(site, enrollment.challenge, response);
	if (!created) {
		const lockedFor = limit.failed(source);
		return lockedFor ? locked(lockedFor) : json({ error: 'passkey_failed' }, { status: 401 });
	}
	limit.refund(source);
	let added: Passkey | null;
	try {
		added = addPasskey(config.stateDir, enrollment.codeHash, config.now(), { ...created, label: request.headers.get('user-agent') ?? '' });
	} catch (error) {
		console.error(`看板 passkey 檔寫不進去：${(error as Error).message}`);
		return json({ error: 'passkeys_unreadable' }, { status: 500 });
	}
	// The code was used, replaced or ran out while the browser made the passkey.
	if (!added) return json({ error: 'wrong_enroll_code' }, { status: 401 });
	return json({ enrolled: true });
};
