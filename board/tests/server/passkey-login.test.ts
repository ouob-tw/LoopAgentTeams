// The passkey second step and its registration: a passkey is registered only with the password and
// a one-time code from the host (10 minutes, used once), several can be registered and each logs
// in, a deleted one cannot, a failed passkey counts against the same lock as a wrong password, and
// a board with passkeys but no TOTP still logs in. Passkeys are answered by a software
// authenticator (tests/soft-passkey.ts); the browser test uses Chrome's virtual one.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PASSWORD, startFixture, type Fixture } from '../harness.ts';
import { SoftPasskey } from '../soft-passkey.ts';

const ORIGIN = 'https://lat.ouob.net';
const RP_ID = 'lat.ouob.net';
const LOCK_SECONDS = 60;
const T0 = Date.parse('2026-11-01T00:00:00.000Z');

const stepCookieOf = (response: Response) => response.headers.getSetCookie()[0].split(';')[0];
const deviceCookieOf = (response: Response) => response.headers.getSetCookie().find((set) => set.startsWith('lat_board_device='))?.split(';')[0];

/** A request from `source` through the trusted proxy, over HTTPS unless `http`. */
function post(fixture: Fixture, path: string, body: unknown, source: string, cookie?: string, { http = false } = {}): Promise<Response> {
	return fixture.fetch(path, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-forwarded-for': source,
			'user-agent': `browser at ${source}`,
			...(http ? {} : { 'x-forwarded-proto': 'https' })
		},
		body: JSON.stringify(body),
		cookie
	});
}

/** A registration code from the host command. */
function enrollCode(fixture: Fixture): string {
	const result = fixture.cli('passkey', 'code');
	expect(result.code).toBe(0);
	return /登記碼：(\S+)/.exec(result.stdout)![1];
}

/** Register `passkey` with the password and `code`: the response of each of the two requests. */
async function enroll(fixture: Fixture, passkey: SoftPasskey, code: string, source: string, password = PASSWORD) {
	const started = await post(fixture, '/api/login/enroll/options', { password, code }, source);
	if (!started.ok) return { started, finished: null };
	const { options, enrollment } = await started.json();
	const finished = await post(fixture, '/api/login/enroll', { enrollment, response: passkey.register(options) }, source);
	return { started, finished };
}

/** The right password from `source`, then the passkey's answer (or what `answer` makes of the options). */
async function loginWith(fixture: Fixture, passkey: SoftPasskey, source: string, answer = (options: { challenge: string }) => passkey.answer(options)) {
	const first = await post(fixture, '/api/login', { password: PASSWORD }, source);
	expect(first.status).toBe(200);
	const step = stepCookieOf(first);
	const options = await post(fixture, '/api/login/passkey/options', {}, source, step);
	expect(options.status).toBe(200);
	return post(fixture, '/api/login/passkey', { response: answer(await options.json()) }, source, step);
}

describe('a board with its address set and no TOTP', () => {
	let fixture: Fixture;
	let time = T0;
	const phone = new SoftPasskey(ORIGIN, RP_ID);
	const laptop = new SoftPasskey(ORIGIN, RP_ID);

	beforeAll(async () => {
		fixture = await startFixture({
			totp: null,
			env: { LAT_BOARD_URL: ORIGIN, LAT_BOARD_TRUSTED_PROXIES: '127.0.0.1', LAT_BOARD_LOGIN_LOCK_SECONDS: String(LOCK_SECONDS) }
		});
		fixture.setClock(time);
	});
	afterAll(() => fixture.cleanup());

	test('no password login gets in before a passkey is registered', async () => {
		const response = await post(fixture, '/api/login', { password: PASSWORD }, '198.51.100.1');
		expect([response.status, await response.json()]).toEqual([409, { error: 'no_second_step' }]);
	});

	test('a passkey is registered only with the right password and a working code from the host', async () => {
		const source = '198.51.100.2';
		// No code issued yet: a made-up one is refused, before the browser is asked for anything.
		const none = await enroll(fixture, phone, 'ABCDE-FGHJK', source);
		expect([none.started.status, await none.started.json()]).toEqual([401, { error: 'wrong_enroll_code' }]);

		const code = enrollCode(fixture);
		const wrongPassword = await enroll(fixture, phone, code, source, 'not-the-password');
		expect([wrongPassword.started.status, await wrongPassword.started.json()]).toEqual([401, { error: 'wrong_password' }]);

		// Case, spaces and the dash do not matter.
		const typed = ` ${code.replace('-', '').toLowerCase()} `;
		const right = await enroll(fixture, phone, typed, source);
		expect(right.started.status).toBe(200);
		expect(right.finished!.status).toBe(200);
		expect(await right.finished!.json()).toEqual({ enrolled: true });
		expect(deviceCookieOf(right.finished!)).toBeUndefined();

		// Used once: the same code does not register another.
		const again = await enroll(fixture, laptop, code, source);
		expect([again.started.status, await again.started.json()]).toEqual([401, { error: 'wrong_enroll_code' }]);

		const file = join(fixture.dir, 'board-state', 'passkeys.json');
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(readFileSync(file, 'utf8')).not.toContain(code);
	});

	test('a code runs out after 10 minutes, and a newer code replaces the older one', async () => {
		const source = '198.51.100.3';
		const late = enrollCode(fixture);
		fixture.setClock((time += 10 * 60 * 1000));
		const expired = await enroll(fixture, laptop, late, source);
		expect([expired.started.status, await expired.started.json()]).toEqual([401, { error: 'wrong_enroll_code' }]);

		const older = enrollCode(fixture);
		const newer = enrollCode(fixture);
		expect((await enroll(fixture, laptop, older, source)).started.status).toBe(401);
		// A code that runs out while the browser makes the passkey saves nothing.
		fixture.setClock((time += 9 * 60 * 1000));
		const started = await post(fixture, '/api/login/enroll/options', { password: PASSWORD, code: newer }, source);
		const { options, enrollment } = await started.json();
		fixture.setClock((time += 2 * 60 * 1000));
		const tooLate = await post(fixture, '/api/login/enroll', { enrollment, response: laptop.register(options) }, source);
		expect([tooLate.status, await tooLate.json()]).toEqual([401, { error: 'wrong_enroll_code' }]);

		const fresh = await enroll(fixture, laptop, enrollCode(fixture), source);
		expect(fresh.finished!.status).toBe(200);
	});

	test('the right password offers the passkey, and each registered passkey logs in', async () => {
		const first = await post(fixture, '/api/login', { password: PASSWORD }, '198.51.100.4');
		expect(await first.json()).toEqual({ secondStep: ['passkey'], secondsLeft: 300 });
		for (const passkey of [phone, laptop]) {
			const response = await loginWith(fixture, passkey, '198.51.100.4');
			expect(response.status).toBe(200);
			const cookie = deviceCookieOf(response);
			expect((await fixture.fetch('/api/board', { cookie })).status).toBe(200);
		}
		const listed = fixture.cli('passkey', 'list');
		expect(listed.stdout.trim().split('\n')).toHaveLength(2);
		expect(listed.stdout).not.toContain('還沒用過');
		// The device remembers how it logged in.
		expect(fixture.cli('devices').stdout).toContain('browser at 198.51.100.4');
	});

	test('a signed answer is used once: sent again, it is refused', async () => {
		const source = '198.51.100.5';
		const first = await post(fixture, '/api/login', { password: PASSWORD }, source);
		const step = stepCookieOf(first);
		const options = await (await post(fixture, '/api/login/passkey/options', {}, source, step)).json();
		const answer = phone.answer(options);
		expect((await post(fixture, '/api/login/passkey', { response: answer }, source, step)).status).toBe(200);
		const again = await post(fixture, '/api/login', { password: PASSWORD }, source);
		const replay = await post(fixture, '/api/login/passkey', { response: answer }, source, stepCookieOf(again));
		expect([replay.status, await replay.json()]).toEqual([401, { error: 'passkey_failed' }]);
	});

	test('failed passkeys count toward the lock, and only a full login clears the count', async () => {
		const source = '203.0.113.50';
		// Signed for another site, or not by a registered passkey: each counts as a wrong attempt.
		const elsewhere = (options: { challenge: string }) => phone.answer(options, { origin: 'https://evil.example', rpId: 'evil.example' });
		const stranger = new SoftPasskey(ORIGIN, RP_ID);
		for (let i = 1; i <= 2; i++) expect((await loginWith(fixture, phone, source, elsewhere)).status).toBe(401);
		for (let i = 3; i <= 4; i++) expect((await loginWith(fixture, stranger, source)).status).toBe(401);
		const locked = await loginWith(fixture, phone, source, elsewhere);
		expect([locked.status, await locked.json()]).toEqual([429, { error: 'locked', retryAfterSeconds: LOCK_SECONDS }]);
		expect((await post(fixture, '/api/login', { password: PASSWORD }, source)).status).toBe(429);

		fixture.setClock((time += LOCK_SECONDS * 1000));
		for (let i = 1; i <= 4; i++) expect((await loginWith(fixture, phone, source, elsewhere)).status).toBe(401);
		expect((await loginWith(fixture, phone, source)).status).toBe(200);
		// The full login cleared the four: four more failures are let through again.
		for (let i = 1; i <= 4; i++) expect((await loginWith(fixture, phone, source, elsewhere)).status).toBe(401);
		expect((await loginWith(fixture, phone, source)).status).toBe(200);
	});

	test('wrong registration codes count toward the lock too', async () => {
		const source = '203.0.113.51';
		for (let i = 1; i <= 4; i++) expect((await post(fixture, '/api/login/enroll/options', { password: PASSWORD, code: `WRONG-${i}` }, source)).status).toBe(401);
		const locked = await post(fixture, '/api/login/enroll/options', { password: PASSWORD, code: 'WRONG-5' }, source);
		expect(locked.status).toBe(429);
		fixture.setClock((time += LOCK_SECONDS * 1000));
	});

	test('a deleted passkey cannot log in; the other one still can', async () => {
		const source = '198.51.100.6';
		const lines = fixture.cli('passkey', 'list').stdout.trim().split('\n');
		const phoneId = lines[0].split('\t')[0];
		const deleted = fixture.cli('passkey', 'delete', phoneId);
		expect(deleted.code).toBe(0);
		expect(fixture.cli('passkey', 'delete', phoneId).code).toBe(1);
		expect(fixture.cli('passkey', 'list').stdout.trim().split('\n')).toHaveLength(1);

		const refused = await loginWith(fixture, phone, source);
		expect([refused.status, await refused.json()]).toEqual([401, { error: 'passkey_failed' }]);
		expect(deviceCookieOf(refused)).toBeUndefined();
		expect((await loginWith(fixture, laptop, source)).status).toBe(200);
	});

	test('the passkey step closes 5 minutes after the right password', async () => {
		const source = '198.51.100.7';
		const step = stepCookieOf(await post(fixture, '/api/login', { password: PASSWORD }, source));
		const options = await (await post(fixture, '/api/login/passkey/options', {}, source, step)).json();
		fixture.setClock((time += 5 * 60 * 1000));
		const late = await post(fixture, '/api/login/passkey', { response: laptop.answer(options) }, source, step);
		expect([late.status, await late.json()]).toEqual([401, { error: 'second_step_expired' }]);
		const noStep = await post(fixture, '/api/login/passkey/options', {}, source, step);
		expect(noStep.status).toBe(401);
	});

	test('over plain http no passkey is made or used, and nothing counts', async () => {
		const source = '198.51.100.9';
		const code = enrollCode(fixture);
		const started = await post(fixture, '/api/login/enroll/options', { password: PASSWORD, code }, source, undefined, { http: true });
		expect([started.status, await started.json()]).toEqual([409, { error: 'passkey_unavailable' }]);
		const step = stepCookieOf(await post(fixture, '/api/login', { password: PASSWORD }, source, undefined, { http: true }));
		const options = await post(fixture, '/api/login/passkey/options', {}, source, step, { http: true });
		expect([options.status, await options.json()]).toEqual([409, { error: 'passkey_unavailable' }]);
		// The same code still works over HTTPS: nothing was used up.
		expect((await enroll(fixture, new SoftPasskey(ORIGIN, RP_ID), code, source)).finished!.status).toBe(200);
	});

	test('the registration and login endpoints are open to a browser that is not logged in, nothing else is', async () => {
		expect((await fixture.fetch('/api/board')).status).toBe(401);
		expect((await post(fixture, '/api/login/passkey/options', {}, '198.51.100.8')).status).toBe(401);
		expect(await (await post(fixture, '/api/login/passkey/options', {}, '198.51.100.8')).json()).toEqual({ error: 'second_step_expired' });
	});
});

describe('a board whose address is not set', () => {
	let fixture: Fixture;
	beforeAll(async () => {
		fixture = await startFixture();
	});
	afterAll(() => fixture.cleanup());

	test('passkeys cannot be registered or used, and TOTP logs in as before', async () => {
		const code = enrollCode(fixture);
		expect(fixture.cli('passkey', 'code').stderr).toContain('LAT_BOARD_URL');
		const started = await post(fixture, '/api/login/enroll/options', { password: PASSWORD, code }, '127.0.0.1');
		expect([started.status, await started.json()]).toEqual([409, { error: 'passkey_unavailable' }]);
		const first = await fixture.tryLogin(PASSWORD);
		expect(await first.clone().json()).toEqual({ secondStep: ['totp'], secondsLeft: 300 });
		const options = await post(fixture, '/api/login/passkey/options', {}, '127.0.0.1', stepCookieOf(first));
		expect([options.status, await options.json()]).toEqual([409, { error: 'passkey_unavailable' }]);
		expect((await fixture.tryCode(stepCookieOf(first), fixture.totpCode())).status).toBe(200);
	});

	test('a board address that is not https, or an RP ID it does not belong to, stops the host command', async () => {
		for (const [env, named] of [
			[{ LAT_BOARD_URL: 'http://localhost:7100' }, 'LAT_BOARD_URL'],
			[{ LAT_BOARD_URL: 'https://lat.ouob.net', LAT_BOARD_PASSKEY_RP_ID: 'example.com' }, 'LAT_BOARD_PASSKEY_RP_ID']
		] as const) {
			const result = Bun.spawnSync(['bun', join(import.meta.dir, '../../src/cli.ts'), 'passkey', 'list'], { env: { ...fixture.serverEnv(), ...env } });
			expect([named, result.exitCode]).toEqual([named, 1]);
			expect(result.stderr.toString()).toContain(named);
		}
	});
});
