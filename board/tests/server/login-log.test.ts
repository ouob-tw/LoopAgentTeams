// The log line of each login and passkey event (#620), read from what the server writes to
// standard error: the password and TOTP steps, a lockout, the passkey second step and a passkey
// alone, registering a passkey with the host's code and from the settings, deleting one, logging
// out, and the browser's refusals the pages report. Each line has its event, result, reason on a
// failure, the browser's own address, the device when there is one and the user agent. No
// password, code, cookie, token, WebAuthn answer or public key is in any line.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_PASSKEY_ERROR_CHARS } from '../../src/lib/server/auth-log.ts';
import { CLIENT_ERRORS_PER_WINDOW } from '../../src/lib/server/client-errors.ts';
import { PASSKEYS_FILE } from '../../src/lib/server/passkeys.ts';
import { logged, PASSWORD, startFixture, until, type Fixture } from '../harness.ts';
import { SoftPasskey } from '../soft-passkey.ts';

const ORIGIN = 'https://lat.ouob.net';
const MISTYPED = 'not-the-password-密碼';
const RP_ID = 'lat.ouob.net';

let fixture: Fixture;
/** Where this test's part of the server output starts. */
let mark = 0;
/** Every secret a request in this file sent or got: none may be in the server's output. */
const secrets = new Set<string>();

beforeAll(async () => {
	fixture = await startFixture({ env: { LAT_BOARD_URL: ORIGIN, LAT_BOARD_TRUSTED_PROXIES: '127.0.0.1', LAT_BOARD_LOGIN_LOCK_SECONDS: '60' } });
});
afterAll(() => fixture?.cleanup());
beforeEach(() => (mark = fixture.serverOutput().length));

const keep = (...values: (string | undefined | null)[]) => {
	for (const value of values) if (value) secrets.add(value);
};
const cookiesOf = (response: Response) => response.headers.getSetCookie().map((set) => set.split(';')[0]);
const cookieNamed = (response: Response, name: string) => {
	const cookie = cookiesOf(response).find((pair) => pair.startsWith(`${name}=`));
	keep(cookie, cookie?.split('=')[1]);
	return cookie;
};

/** A JSON request from `source` through the trusted proxy over HTTPS, with a user agent naming it. */
function call(method: string, path: string, { body, source, cookie, headers = {} }: { body?: unknown; source: string; cookie?: string; headers?: Record<string, string> }) {
	// A browser's report is a flow and an error name, which its line repeats on purpose.
	if (body && typeof body === 'object' && path !== '/api/login/passkey-error') for (const value of Object.values(body)) keep(typeof value === 'string' ? value : JSON.stringify(value));
	// Each part of a WebAuthn answer, too.
	const answer = (body as { response?: { response?: Record<string, string> } } | undefined)?.response?.response;
	if (answer) keep(...Object.values(answer).filter((value) => typeof value === 'string'));
	return fixture.fetch(path, {
		method,
		headers: { 'content-type': 'application/json', 'x-forwarded-for': source, 'x-forwarded-proto': 'https', 'user-agent': `agent of ${source}`, ...headers },
		body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
		cookie
	});
}
const post = (path: string, body: unknown, source: string, cookie?: string) => call('POST', path, { body, source, cookie });

/** The `message` lines written since this test began, once at least `count` are there. */
async function lines(message: string, count = 1): Promise<Record<string, unknown>[]> {
	const read = () => {
		const text = fixture.serverOutput().slice(mark);
		return logged(text.slice(0, text.lastIndexOf('\n') + 1), message);
	};
	return until(() => (read().length >= count ? read() : null), 5_000, `${count} "${message}" line(s)`);
}

/** The fields every line of a request from `source` carries. */
const from = (source: string) => ({ logger: 'board.login', client_ip: source, user_agent: `agent of ${source}` });

/** The right password from `source`: the open step's cookie. */
async function rightPassword(source: string): Promise<string> {
	const response = await post('/api/login', { password: PASSWORD }, source);
	expect(response.status).toBe(200);
	return cookieNamed(response, 'lat_board_device_step')!;
}

function enrollCode(): string {
	const code = /登記碼：(\S+)/.exec(fixture.cli('passkey', 'code').stdout)![1];
	keep(code);
	return code;
}

const phone = new SoftPasskey(ORIGIN, RP_ID);
let phoneId = '';

describe('the password and TOTP steps', () => {
	test('a wrong password, then the right one, then a wrong and a right code each write one line', async () => {
		const source = '198.51.100.10';
		expect((await post('/api/login', { password: MISTYPED }, source)).status).toBe(401);
		const step = await rightPassword(source);
		const wrong = fixture.totpCode(-5 * 30_000);
		const right = fixture.totpCode();
		keep(wrong, right);
		expect((await post('/api/login/totp', { code: wrong }, source, step)).status).toBe(401);
		const done = await post('/api/login/totp', { code: right }, source, step);
		expect(done.status).toBe(200);
		cookieNamed(done, 'lat_board_device');

		const password = await lines('login_password', 2);
		expect(password[0]).toMatchObject({ ...from(source), level: 'INFO', result: 'failure', reason: 'wrong_password' });
		expect(password[1]).toMatchObject({ ...from(source), level: 'INFO', result: 'success' });
		expect(password[1]).not.toHaveProperty('reason');
		expect(password[0].request_id).toEqual(expect.any(String));
		const totp = await lines('login_totp', 2);
		const deviceId = totp[1].device_id;
		expect(totp[0]).toMatchObject({ ...from(source), result: 'failure', reason: 'wrong_code' });
		expect(totp[1]).toMatchObject({ ...from(source), result: 'success' });
		expect(deviceId).toMatch(/^[0-9a-f]{8}$/);
		expect(fixture.cli('devices').stdout).toContain(`${deviceId}\t`);
	});

	test('the attempt that locks a source writes a warning with who and during what; a locked attempt says locked', async () => {
		const source = '198.51.100.11';
		for (let i = 0; i < 5; i++) await post('/api/login', { password: `wrong-${i}` }, source);
		expect((await post('/api/login', { password: PASSWORD }, source)).status).toBe(429);
		const [lock, ...more] = await lines('login_locked');
		expect(more).toEqual([]);
		expect(lock).toMatchObject({ ...from(source), level: 'WARNING', result: 'failure', reason: 'too_many_attempts', during: 'login_password', lock_seconds: 60 });
		const password = await lines('login_password', 6);
		expect(password.slice(0, 4).map((line) => line.reason)).toEqual(Array(4).fill('wrong_password'));
		expect(password.slice(4).map((line) => line.reason)).toEqual(['locked', 'locked']);
	});
});

describe('passkeys', () => {
	test('registering with the host code: a wrong code fails, the right one starts and succeeds with the passkey', async () => {
		const source = '198.51.100.20';
		expect((await post('/api/login/enroll/options', { password: PASSWORD, code: 'NOT-A-CODE' }, source)).status).toBe(401);
		const started = await post('/api/login/enroll/options', { password: PASSWORD, code: enrollCode() }, source);
		expect(started.status).toBe(200);
		const { options, enrollment } = await started.json();
		keep(enrollment, options.challenge);
		expect((await post('/api/login/enroll', { enrollment, response: phone.register(options) }, source)).status).toBe(200);
		[{ id: phoneId }] = JSON.parse(readFileSync(join(fixture.dir, 'board-state', PASSKEYS_FILE), 'utf8')).passkeys;

		const enroll = await lines('passkey_enroll', 3);
		expect(enroll[0]).toMatchObject({ ...from(source), result: 'failure', reason: 'wrong_enroll_code', via: 'host_code' });
		expect(enroll[1]).toMatchObject({ ...from(source), result: 'start', via: 'host_code' });
		expect(enroll[2]).toMatchObject({ ...from(source), result: 'success', via: 'host_code', passkey_id: phoneId });
	});

	test('the passkey second step: a bad signature and an unknown passkey fail with their cause, the right answer logs in', async () => {
		const source = '198.51.100.21';
		const step = await rightPassword(source);
		const ask = async () => {
			const options = await (await post('/api/login/passkey/options', {}, source, step)).json();
			keep(options.challenge);
			return options;
		};
		const forged = phone.answer(await ask(), { origin: 'https://evil.example' });
		expect((await post('/api/login/passkey', { response: forged }, source, step)).status).toBe(401);
		const stranger = new SoftPasskey(ORIGIN, RP_ID);
		expect((await post('/api/login/passkey', { response: stranger.answer(await ask()) }, source, step)).status).toBe(401);
		const done = await post('/api/login/passkey', { response: phone.answer(await ask()) }, source, step);
		expect(done.status).toBe(200);
		cookieNamed(done, 'lat_board_device');

		const login = await lines('login_passkey', 6);
		expect(login.map((line) => line.result)).toEqual(['start', 'failure', 'start', 'failure', 'start', 'success']);
		expect(login[1]).toMatchObject({ ...from(source), reason: 'passkey_failed', cause: 'not_verified', passkey_id: phoneId });
		expect(login[3]).toMatchObject({ ...from(source), reason: 'passkey_failed', cause: 'unknown_passkey' });
		expect(login[3]).not.toHaveProperty('passkey_id');
		expect(login[5]).toMatchObject({ ...from(source), passkey_id: phoneId, device_id: expect.stringMatching(/^[0-9a-f]{8}$/) });
	});

	test('a passkey alone: a holder not checked fails, the right answer logs in', async () => {
		const source = '198.51.100.22';
		const ask = async () => {
			const options = await (await post('/api/login/passwordless/options', {}, source)).json();
			keep(options.challenge);
			return options;
		};
		expect((await post('/api/login/passwordless', { response: phone.answer(await ask(), { verified: false }) }, source)).status).toBe(401);
		const done = await post('/api/login/passwordless', { response: phone.answer(await ask()) }, source);
		expect(done.status).toBe(200);
		cookieNamed(done, 'lat_board_device');

		const login = await lines('login_passwordless', 2);
		expect(login[0]).toMatchObject({ ...from(source), result: 'failure', reason: 'passkey_failed', cause: 'not_verified', passkey_id: phoneId });
		expect(login[1]).toMatchObject({ ...from(source), result: 'success', passkey_id: phoneId, device_id: expect.stringMatching(/^[0-9a-f]{8}$/) });
	});

	test('from the settings: registering, a registration that ran out, deleting, a passkey already gone, and logging out name the device', async () => {
		const source = '198.51.100.23';
		const cookie = await fixture.login('settings-device');
		keep(cookie, cookie.split('=')[1]);
		const device = fixture.cli('devices').stdout.split('\n').find((line) => line.includes('settings-device'))!;
		const deviceId = /\b[0-9a-f]{8}\b/.exec(device)![0];
		const laptop = new SoftPasskey(ORIGIN, RP_ID);
		const started = await call('POST', '/api/passkeys/options', { source, cookie });
		const { options, enrollment } = await started.json();
		keep(enrollment, options.challenge);
		const saved = await call('POST', '/api/passkeys', { source, cookie, body: { enrollment, response: laptop.register(options) } });
		const { enrolled } = await saved.json();
		expect((await call('POST', '/api/passkeys', { source, cookie, body: { enrollment, response: laptop.register(options) } })).status).toBe(410);
		expect((await call('DELETE', `/api/passkeys/${enrolled}`, { source, cookie })).status).toBe(200);
		expect((await call('DELETE', `/api/passkeys/${enrolled}`, { source, cookie })).status).toBe(404);
		expect((await call('DELETE', '/api/device', { source, cookie })).status).toBe(200);

		const here = { ...from(source), device_id: deviceId };
		const enroll = await lines('passkey_enroll', 3);
		expect(enroll[0]).toMatchObject({ ...here, result: 'start', via: 'settings' });
		expect(enroll[1]).toMatchObject({ ...here, result: 'success', via: 'settings', passkey_id: enrolled });
		expect(enroll[2]).toMatchObject({ ...here, result: 'failure', via: 'settings', reason: 'enroll_expired' });
		const deleted = await lines('passkey_delete', 2);
		expect(deleted[0]).toMatchObject({ ...here, result: 'success', passkey_id: enrolled });
		expect(deleted[1]).toMatchObject({ ...here, result: 'failure', reason: 'no_passkey' });
		expect(await lines('logout')).toEqual([expect.objectContaining({ ...here, result: 'success' })]);
	});
});

describe("the browser's refusals the pages report", () => {
	const report = (body: unknown, source: string, init: { cookie?: string; headers?: Record<string, string> } = {}) =>
		call('POST', '/api/login/passkey-error', { body, source, ...init });

	test('each is a failure of its flow with the error name as the reason; an unknown name is other', async () => {
		const source = '198.51.100.30';
		const cookie = await fixture.login('reporting-device');
		keep(cookie, cookie.split('=')[1]);
		expect((await report({ flow: 'settings', name: 'InvalidStateError' }, source, { cookie })).status).toBe(204);
		expect((await report({ flow: 'alone', name: 'NotAllowedError' }, source)).status).toBe(204);
		expect((await report({ flow: 'second_step', name: 'AbortError' }, source)).status).toBe(204);
		expect((await report({ flow: 'host_code', name: `secret ${PASSWORD}\n{"level":"ERROR"}` }, source)).status).toBe(204);

		const [settings, hostCode] = await lines('passkey_enroll', 2);
		expect(settings).toMatchObject({ ...from(source), result: 'failure', reason: 'InvalidStateError', via: 'settings', source: 'browser', device_id: expect.stringMatching(/^[0-9a-f]{8}$/) });
		expect(hostCode).toMatchObject({ ...from(source), result: 'failure', reason: 'other', via: 'host_code', source: 'browser' });
		expect(hostCode).not.toHaveProperty('device_id');
		expect(await lines('login_passwordless')).toEqual([expect.objectContaining({ ...from(source), result: 'failure', reason: 'NotAllowedError', source: 'browser' })]);
		expect(await lines('login_passkey')).toEqual([expect.objectContaining({ ...from(source), result: 'failure', reason: 'AbortError', source: 'browser' })]);
	});

	test('only a same-origin JSON report of a known flow and bounded size is taken, and an address only so many a minute', async () => {
		const source = '198.51.100.31';
		expect((await report({ flow: 'nowhere', name: 'NotAllowedError' }, source)).status).toBe(400);
		expect((await report('not json', source)).status).toBe(400);
		// A form or plain text from another site SvelteKit refuses itself; any other type but JSON is refused here.
		expect((await report({ flow: 'alone', name: 'NotAllowedError' }, source, { headers: { 'content-type': 'text/plain' } })).status).toBe(403);
		expect((await report({ flow: 'alone', name: 'NotAllowedError' }, source, { headers: { 'content-type': 'application/xml' } })).status).toBe(415);
		expect((await report({ flow: 'alone', name: 'NotAllowedError' }, source, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
		expect((await report({ flow: 'alone', name: 'x'.repeat(MAX_PASSKEY_ERROR_CHARS) }, source)).status).toBe(413);
		for (let i = 0; i < CLIENT_ERRORS_PER_WINDOW; i++) expect((await report({ flow: 'alone', name: 'NotAllowedError' }, source)).status).toBe(204);
		expect((await report({ flow: 'alone', name: 'NotAllowedError' }, source)).status).toBe(429);
		// Another address still gets its own.
		expect((await report({ flow: 'alone', name: 'NotAllowedError' }, '198.51.100.32')).status).toBe(204);
		const logins = await lines('login_passwordless', CLIENT_ERRORS_PER_WINDOW + 1);
		expect(logins.filter((line) => line.client_ip === source)).toHaveLength(CLIENT_ERRORS_PER_WINDOW);
	});
});

test('no line has a password, code, cookie, token, WebAuthn answer or public key', async () => {
	keep(PASSWORD);
	const stored = JSON.parse(readFileSync(join(fixture.dir, 'board-state', PASSKEYS_FILE), 'utf8')).passkeys;
	for (const passkey of stored) keep(passkey.publicKey, passkey.credentialId);
	keep(phone.id);
	// Settled: a line written by a request after every other is there.
	mark = fixture.serverOutput().length;
	await post('/api/login', { password: MISTYPED }, '198.51.100.99');
	await lines('login_password');
	const output = fixture.serverOutput();
	expect(logged(output, 'login_password').length).toBeGreaterThan(5);
	// A six-digit code could turn up by chance in a request id or a time, so short secrets are looked
	// for in the login lines without those.
	const loginLines = output
		.split('\n')
		.filter((line) => line.includes('"logger":"board.login"'))
		.map((line) => {
			const { ts: _ts, request_id: _id, ...rest } = JSON.parse(line);
			return JSON.stringify(rest);
		})
		.join('\n');
	expect(loginLines.length).toBeGreaterThan(1000);
	const found = [...secrets].filter((secret) => (secret.length >= 12 ? output : loginLines).includes(secret));
	expect(found).toEqual([]);
});
