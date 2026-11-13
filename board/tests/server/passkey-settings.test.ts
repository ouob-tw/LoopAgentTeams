// Passkeys from the settings of a logged-in device, and a login with a passkey alone: a device
// logged in over HTTPS at the board's address registers one with no code from the host and can
// delete it; any registered passkey then logs in without the password, but only signed with the
// holder checked (PIN, fingerprint); a failure counts against the same lock as a wrong password and
// only a login clears it; a test device may do none of it. Passkeys are answered by a software
// authenticator (tests/soft-passkey.ts).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PASSWORD, startFixture, type Fixture } from '../harness.ts';
import { SoftPasskey } from '../soft-passkey.ts';

const ORIGIN = 'https://lat.ouob.net';
const RP_ID = 'lat.ouob.net';
const LOCK_SECONDS = 60;
const T0 = Date.parse('2026-11-01T00:00:00.000Z');

const deviceCookieOf = (response: Response) => response.headers.getSetCookie().find((set) => set.startsWith('lat_board_device='))?.split(';')[0];

/** A request from `source` through the trusted proxy, over HTTPS unless `http`. */
function call(fixture: Fixture, method: string, path: string, { body, source = '198.51.100.1', cookie, http = false }: { body?: unknown; source?: string; cookie?: string; http?: boolean } = {}) {
	return fixture.fetch(path, {
		method,
		headers: {
			'content-type': 'application/json',
			'x-forwarded-for': source,
			'user-agent': `browser at ${source}`,
			...(http ? {} : { 'x-forwarded-proto': 'https' })
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		cookie
	});
}

/** Register `passkey` from the settings of the device with `cookie`: the response of each request. */
async function enrollFromSettings(fixture: Fixture, cookie: string, passkey: SoftPasskey) {
	const started = await call(fixture, 'POST', '/api/passkeys/options', { cookie });
	if (!started.ok) return { started, finished: null };
	const { options, enrollment } = await started.json();
	const finished = await call(fixture, 'POST', '/api/passkeys', { cookie, body: { enrollment, response: passkey.register(options) } });
	return { started, finished };
}

/** A login with `passkey` alone from `source`, or with what `answer` makes of the options. */
async function loginAlone(fixture: Fixture, passkey: SoftPasskey, source: string, answer = (options: { challenge: string }) => passkey.answer(options)) {
	const options = await call(fixture, 'POST', '/api/login/passwordless/options', { source });
	expect(options.status).toBe(200);
	return call(fixture, 'POST', '/api/login/passwordless', { source, body: { response: answer(await options.json()) } });
}

const listed = async (fixture: Fixture, cookie: string) => (await (await call(fixture, 'GET', '/api/passkeys', { cookie })).json()).passkeys as { id: string; label: string; createdAt: string; lastUsedAt: string | null }[];

describe('a board at https://lat.ouob.net', () => {
	let fixture: Fixture;
	let cookie: string;
	let time = T0;
	const phone = new SoftPasskey(ORIGIN, RP_ID);
	const laptop = new SoftPasskey(ORIGIN, RP_ID);

	beforeAll(async () => {
		fixture = await startFixture({
			env: { LAT_BOARD_URL: ORIGIN, LAT_BOARD_TRUSTED_PROXIES: '127.0.0.1', LAT_BOARD_LOGIN_LOCK_SECONDS: String(LOCK_SECONDS) }
		});
		fixture.setClock(time);
		cookie = await fixture.login();
	});
	afterAll(() => fixture.cleanup());

	test('a logged-in device registers a passkey from the settings with no code; the host lists it', async () => {
		const empty = await call(fixture, 'GET', '/api/passkeys', { cookie });
		expect(await empty.json()).toEqual({ origin: ORIGIN, passkeys: [] });

		const started = await call(fixture, 'POST', '/api/passkeys/options', { cookie });
		const { options } = await started.clone().json();
		// The new passkey must check who holds it, so it can log in alone.
		expect(options.authenticatorSelection.userVerification).toBe('required');
		const { finished } = await enrollFromSettings(fixture, cookie, phone);
		expect(finished!.status).toBe(200);
		const passkeys = await listed(fixture, cookie);
		expect(passkeys).toEqual([{ id: expect.any(String), label: 'browser at 198.51.100.1', createdAt: new Date(time).toISOString(), lastUsedAt: null }]);
		expect(JSON.stringify(passkeys)).not.toContain(phone.id);
		expect(fixture.cli('passkey', 'list').stdout).toContain(passkeys[0].id);
	});

	test('the registered passkey logs in alone, with no password', async () => {
		const options = await (await call(fixture, 'POST', '/api/login/passwordless/options', { source: '198.51.100.2' })).json();
		expect(options.userVerification).toBe('required');
		expect(options.allowCredentials.map((credential: { id: string }) => credential.id)).toEqual([phone.id]);
		const response = await call(fixture, 'POST', '/api/login/passwordless', { source: '198.51.100.2', body: { response: phone.answer(options) } });
		expect([response.status, await response.json()]).toEqual([200, { loggedIn: true }]);
		const loggedIn = deviceCookieOf(response);
		expect((await fixture.fetch('/api/board', { cookie: loggedIn })).status).toBe(200);
		expect(fixture.cli('devices').stdout).toContain('browser at 198.51.100.2');
		expect((await listed(fixture, cookie))[0].lastUsedAt).toBe(new Date(time).toISOString());

		// Signed once: the same answer does not log in again.
		const replay = await call(fixture, 'POST', '/api/login/passwordless', { source: '198.51.100.2', body: { response: phone.answer(options) } });
		expect([replay.status, await replay.json()]).toEqual([401, { error: 'passkey_failed' }]);
	});

	test('a passkey registered with the host code logs in alone too', async () => {
		const code = /登記碼：(\S+)/.exec(fixture.cli('passkey', 'code').stdout)![1];
		const started = await call(fixture, 'POST', '/api/login/enroll/options', { body: { password: PASSWORD, code }, source: '198.51.100.3' });
		const { options, enrollment } = await started.json();
		expect((await call(fixture, 'POST', '/api/login/enroll', { body: { enrollment, response: laptop.register(options) }, source: '198.51.100.3' })).status).toBe(200);
		expect((await loginAlone(fixture, laptop, '198.51.100.3')).status).toBe(200);
	});

	test('failures count toward the lock, an answer without the holder checked fails, and only a login clears the count', async () => {
		const source = '203.0.113.60';
		const elsewhere = (options: { challenge: string }) => phone.answer(options, { origin: 'https://evil.example', rpId: 'evil.example' });
		const unchecked = (options: { challenge: string }) => phone.answer(options, { verified: false });
		const madeUp = () => phone.answer({ challenge: 'bm90LWdpdmVu' });
		for (const answer of [elsewhere, unchecked, madeUp]) {
			const failed = await loginAlone(fixture, phone, source, answer);
			expect([failed.status, await failed.json(), deviceCookieOf(failed)]).toEqual([401, { error: 'passkey_failed' }, undefined]);
		}
		expect((await loginAlone(fixture, new SoftPasskey(ORIGIN, RP_ID), source)).status).toBe(401);
		const locked = await loginAlone(fixture, phone, source, elsewhere);
		expect([locked.status, await locked.json()]).toEqual([429, { error: 'locked', retryAfterSeconds: LOCK_SECONDS }]);
		// Locked: the right passkey and the password wait too.
		expect((await loginAlone(fixture, phone, source)).status).toBe(429);
		expect((await call(fixture, 'POST', '/api/login', { body: { password: PASSWORD }, source })).status).toBe(429);

		fixture.setClock((time += LOCK_SECONDS * 1000));
		for (let i = 1; i <= 4; i++) expect((await loginAlone(fixture, phone, source, elsewhere)).status).toBe(401);
		expect((await loginAlone(fixture, phone, source)).status).toBe(200);
		// The login cleared the four: four more failures are let through again.
		for (let i = 1; i <= 4; i++) expect((await loginAlone(fixture, phone, source, elsewhere)).status).toBe(401);
		expect((await loginAlone(fixture, phone, source)).status).toBe(200);
	});

	test('a passkey deleted from the settings cannot log in; the other one still can', async () => {
		const id = (await listed(fixture, cookie)).find((passkey) => passkey.label === 'browser at 198.51.100.1')!.id;
		const deleted = await call(fixture, 'DELETE', `/api/passkeys/${id}`, { cookie });
		expect([deleted.status, await deleted.json()]).toEqual([200, { deleted: id }]);
		expect((await call(fixture, 'DELETE', `/api/passkeys/${id}`, { cookie })).status).toBe(404);
		expect(fixture.cli('passkey', 'list').stdout).not.toContain(id);
		const refused = await loginAlone(fixture, phone, '198.51.100.4');
		expect([refused.status, await refused.json()]).toEqual([401, { error: 'passkey_failed' }]);
		expect((await loginAlone(fixture, laptop, '198.51.100.4')).status).toBe(200);
	});

	test('a registration is finished only by the device that started it, and never with the host code route', async () => {
		const other = await fixture.login('other device');
		const started = await (await call(fixture, 'POST', '/api/passkeys/options', { cookie })).json();
		const stranger = new SoftPasskey(ORIGIN, RP_ID);
		const byOther = await call(fixture, 'POST', '/api/passkeys', { cookie: other, body: { enrollment: started.enrollment, response: stranger.register(started.options) } });
		expect([byOther.status, await byOther.json()]).toEqual([401, { error: 'enroll_expired' }]);

		const again = await (await call(fixture, 'POST', '/api/passkeys/options', { cookie })).json();
		const viaCode = await call(fixture, 'POST', '/api/login/enroll', { body: { enrollment: again.enrollment, response: stranger.register(again.options) } });
		expect([viaCode.status, await viaCode.json()]).toEqual([401, { error: 'enroll_expired' }]);
		expect(await listed(fixture, cookie)).toHaveLength(1);
	});

	test('over plain http nothing is registered or logged in with a passkey', async () => {
		expect((await call(fixture, 'POST', '/api/passkeys/options', { cookie, http: true })).status).toBe(409);
		const started = await (await call(fixture, 'POST', '/api/passkeys/options', { cookie })).json();
		const finished = await call(fixture, 'POST', '/api/passkeys', { cookie, http: true, body: { enrollment: started.enrollment, response: new SoftPasskey(ORIGIN, RP_ID).register(started.options) } });
		expect([finished.status, await finished.json()]).toEqual([409, { error: 'passkey_unavailable' }]);
		const options = await call(fixture, 'POST', '/api/login/passwordless/options', { http: true });
		expect([options.status, await options.json()]).toEqual([409, { error: 'passkey_unavailable' }]);
		const given = await (await call(fixture, 'POST', '/api/login/passwordless/options')).json();
		const login = await call(fixture, 'POST', '/api/login/passwordless', { http: true, body: { response: laptop.answer(given) } });
		expect([login.status, await login.json()]).toEqual([409, { error: 'passkey_unavailable' }]);
	});

	test('the settings endpoints need a logged-in device, and a test device may not change passkeys', async () => {
		expect((await call(fixture, 'GET', '/api/passkeys')).status).toBe(401);
		expect((await call(fixture, 'POST', '/api/passkeys/options')).status).toBe(401);
		const link = new RegExp(`${fixture.url}/login/test#(\\S+)`).exec(fixture.cli('test-login', '--url', fixture.url, '--label', 'qa').stdout)![1];
		const redeemed = await fixture.fetch('/api/login/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: link }) });
		const test = redeemed.headers.getSetCookie()[0].split(';')[0];
		const id = (await listed(fixture, cookie))[0].id;
		for (const [method, path] of [
			['POST', '/api/passkeys/options'],
			['POST', '/api/passkeys'],
			['DELETE', `/api/passkeys/${id}`]
		]) {
			const response = await call(fixture, method, path, { cookie: test, body: {} });
			expect([path, response.status, (await response.json()).error]).toEqual([path, 403, 'test_device']);
		}
		expect(await listed(fixture, cookie)).toHaveLength(1);
	});
});

describe('a board whose address is not set', () => {
	let fixture: Fixture;
	beforeAll(async () => {
		fixture = await startFixture();
	});
	afterAll(() => fixture.cleanup());

	test('the settings say passkeys cannot be used, and none is registered or logged in with', async () => {
		const cookie = await fixture.login();
		expect(await (await call(fixture, 'GET', '/api/passkeys', { cookie })).json()).toEqual({ origin: null, passkeys: [] });
		expect((await call(fixture, 'POST', '/api/passkeys/options', { cookie })).status).toBe(409);
		expect((await call(fixture, 'POST', '/api/login/passwordless/options')).status).toBe(409);
	});
});
