// The TOTP second step of a login: the code counts against the same lock as the password and only
// a full login clears it, the step closes after 5 minutes, a code works once, a board without a
// second step lets no password login in, and the host command sets, replaces and clears the secret.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { totpCode } from '../../src/lib/server/totp.ts';
import { PASSWORD, startFixture, type Fixture } from '../harness.ts';

const LOCK_SECONDS = 60;
const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const STEP_MS = 30_000;
const CLI = join(import.meta.dir, '../../src/cli.ts');

const stepCookieOf = (response: Response) => response.headers.getSetCookie()[0].split(';')[0];
const deviceCookieOf = (response: Response) => response.headers.getSetCookie().find((set) => set.startsWith('lat_board_device='))?.split(';')[0];

/** The right password from `source` (through the trusted proxy), and the step cookie it set. */
async function password(fixture: Fixture, source: string, value = PASSWORD): Promise<Response> {
	return fixture.fetch('/api/login', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-forwarded-for': source },
		body: JSON.stringify({ password: value })
	});
}

function code(fixture: Fixture, source: string, stepCookie: string, value: string): Promise<Response> {
	return fixture.fetch('/api/login/totp', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-forwarded-for': source },
		body: JSON.stringify({ code: value }),
		cookie: stepCookie
	});
}

/** A code that is wrong now: the one of five steps ago. */
const wrongCode = (fixture: Fixture) => fixture.totpCode(-5 * STEP_MS);

describe('a board with a TOTP secret', () => {
	let fixture: Fixture;
	let time = T0;
	/** Move the board's clock to a later 30-second step, so each login has a code of its own. */
	const nextStep = () => fixture.setClock((time += STEP_MS));

	beforeAll(async () => {
		// The test client is the trusted proxy, so each test can play a source of its own.
		fixture = await startFixture({ env: { LAT_BOARD_TRUSTED_PROXIES: '127.0.0.1', LAT_BOARD_LOGIN_LOCK_SECONDS: String(LOCK_SECONDS) } });
		fixture.setClock(time);
	});
	afterAll(() => fixture.cleanup());

	test('a wrong code logs nothing in and the step stays open for the right one', async () => {
		nextStep();
		const first = await password(fixture, '198.51.100.1');
		const step = stepCookieOf(first);
		const wrong = await code(fixture, '198.51.100.1', step, wrongCode(fixture));
		expect(wrong.status).toBe(401);
		expect(await wrong.json()).toEqual({ error: 'wrong_code' });
		expect(deviceCookieOf(wrong)).toBeUndefined();

		const right = await code(fixture, '198.51.100.1', step, fixture.totpCode());
		expect(right.status).toBe(200);
		expect((await fixture.fetch('/api/board', { cookie: deviceCookieOf(right) })).status).toBe(200);
	});

	test('a code without the right password first, or with a made-up step cookie, is not even checked', async () => {
		nextStep();
		for (const cookie of ['', 'lat_board_device_step=made-up']) {
			const response = await code(fixture, '198.51.100.2', cookie, fixture.totpCode());
			expect(response.status).toBe(401);
			expect(await response.json()).toEqual({ error: 'second_step_expired' });
		}
		// None of those counted: five wrong codes still pass four times before the lock.
		const step = stepCookieOf(await password(fixture, '198.51.100.2'));
		for (let i = 1; i < 5; i++) expect((await code(fixture, '198.51.100.2', step, wrongCode(fixture))).status).toBe(401);
		expect((await code(fixture, '198.51.100.2', step, wrongCode(fixture))).status).toBe(429);
	});

	test('"right password, wrong code" over and over still locks the source, and the lock outlasts a restart', async () => {
		nextStep();
		const source = '203.0.113.30';
		for (let round = 1; round <= 3; round++) {
			const step = stepCookieOf(await password(fixture, source));
			expect([round, (await code(fixture, source, step, wrongCode(fixture))).status]).toEqual([round, 401]);
		}
		// The count is kept across a restart, mid-way.
		await fixture.stop();
		await fixture.start();
		const fourth = stepCookieOf(await password(fixture, source));
		expect((await code(fixture, source, fourth, wrongCode(fixture))).status).toBe(401);
		const fifth = stepCookieOf(await password(fixture, source));
		const locked = await code(fixture, source, fifth, wrongCode(fixture));
		expect(locked.status).toBe(429);
		expect(await locked.json()).toEqual({ error: 'locked', retryAfterSeconds: LOCK_SECONDS });

		// Locked: the right password and the right code are both refused, also after a restart.
		expect((await password(fixture, source)).status).toBe(429);
		await fixture.stop();
		await fixture.start();
		expect((await password(fixture, source)).status).toBe(429);
		// Another source is not locked.
		expect((await password(fixture, '203.0.113.31')).status).toBe(200);

		fixture.setClock((time += LOCK_SECONDS * 1000));
		const step = stepCookieOf(await password(fixture, source));
		expect((await code(fixture, source, step, fixture.totpCode())).status).toBe(200);
	});

	test('only a full login clears the count: the right password alone does not', async () => {
		nextStep();
		const source = '203.0.113.40';
		for (let i = 1; i <= 4; i++) expect((await password(fixture, source, `wrong-${i}`)).status).toBe(401);
		// The right password opens the second step but leaves the four wrong ones counted.
		expect((await password(fixture, source)).status).toBe(200);
		expect((await password(fixture, source, 'wrong-5')).status).toBe(429);

		fixture.setClock((time += LOCK_SECONDS * 1000));
		for (let i = 1; i <= 4; i++) expect((await password(fixture, source, `wrong-${i}`)).status).toBe(401);
		const step = stepCookieOf(await password(fixture, source));
		expect((await code(fixture, source, step, fixture.totpCode())).status).toBe(200);
		// The full login cleared them: four more wrong ones are let through again.
		for (let i = 1; i <= 4; i++) expect((await password(fixture, source, `again-${i}`)).status).toBe(401);
		nextStep();
		const again = stepCookieOf(await password(fixture, source));
		expect((await code(fixture, source, again, fixture.totpCode())).status).toBe(200);
	});

	test('the second step closes 5 minutes after the right password', async () => {
		nextStep();
		const source = '198.51.100.3';
		const late = stepCookieOf(await password(fixture, source));
		const inTime = stepCookieOf(await password(fixture, source));
		fixture.setClock((time += 5 * 60 * 1000 - 1000));
		expect((await code(fixture, source, inTime, fixture.totpCode())).status).toBe(200);

		fixture.setClock((time += 1000));
		const expired = await code(fixture, source, late, fixture.totpCode());
		expect(expired.status).toBe(401);
		expect(await expired.json()).toEqual({ error: 'second_step_expired' });
		expect(deviceCookieOf(expired)).toBeUndefined();
		// The password again opens a new one.
		nextStep();
		const fresh = stepCookieOf(await password(fixture, source));
		expect((await code(fixture, source, fresh, fixture.totpCode())).status).toBe(200);
	});

	test('a code logs in once: a second browser with the same code is refused', async () => {
		nextStep();
		const now = fixture.totpCode();
		const one = stepCookieOf(await password(fixture, '198.51.100.4'));
		const two = stepCookieOf(await password(fixture, '198.51.100.5'));
		expect((await code(fixture, '198.51.100.4', one, now)).status).toBe(200);
		expect((await code(fixture, '198.51.100.5', two, now)).status).toBe(401);
	});

	test('a device that passed the second step is listed as logged in by the host command', async () => {
		nextStep();
		await fixture.login('totp-phone');
		const line = fixture.cli('devices').stdout.split('\n').find((row) => row.includes('totp-phone'))!;
		expect(line).not.toContain('失效');
	});
});

describe('the host command for TOTP', () => {
	let fixture: Fixture;
	beforeAll(async () => {
		fixture = await startFixture({ totp: null });
		fixture.setClock(T0);
	});
	afterAll(() => fixture.cleanup());

	/** Run `board totp`, answer with the code `answer` gives for the secret it printed. */
	async function setTotp(answer: (secret: string) => string): Promise<{ code: number; stdout: string; stderr: string; secret: string }> {
		const child = Bun.spawn(['bun', CLI, 'totp'], { env: fixture.serverEnv(), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
		const reader = child.stdout.getReader();
		let stdout = '';
		let secret = '';
		while (!secret) {
			const { value, done } = await reader.read();
			if (done) break;
			stdout += new TextDecoder().decode(value);
			secret = /金鑰：([A-Z2-7]+)/.exec(stdout)?.[1] ?? '';
		}
		child.stdin.write(answer(secret));
		child.stdin.end();
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			stdout += new TextDecoder().decode(value);
		}
		const code = await child.exited;
		return { code, stdout, stderr: await new Response(child.stderr).text(), secret };
	}

	test('without a second step no password login gets in, and the login screen names the command', async () => {
		const html = await (await fixture.fetch('/login')).text();
		expect(html).toContain('bun run board totp');
		expect(html).not.toContain('type="password"');
		// The same answer for a wrong password: it tells nobody whether a password was right.
		for (const value of [PASSWORD, 'wrong']) {
			const response = await fixture.tryLogin(value);
			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({ error: 'no_second_step' });
			expect(response.headers.getSetCookie()).toEqual([]);
		}
	});

	test('a test login needs no second step', async () => {
		const issued = fixture.cli('test-login', '--label', 'qa');
		const testCode = /#(\S+)/.exec(issued.stdout)![1];
		const redeemed = await fixture.fetch('/api/login/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: testCode }) });
		expect(redeemed.status).toBe(200);
		expect((await fixture.fetch('/api/board', { cookie: deviceCookieOf(redeemed) })).status).toBe(200);
	});

	test('the secret takes effect only after a right code, shown as a QR code and an otpauth link', async () => {
		const refused = await setTotp(() => '12345\n000\nabcdef\n');
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain('3 次都不對，TOTP 沒有變更。');
		expect(refused.stdout).toContain(`otpauth://totp/`);
		expect(refused.stdout).toContain(`secret=${refused.secret}`);
		// The QR code: block characters drawn in the terminal.
		expect(refused.stdout).toMatch(/[█▀▄]{20,}/);
		expect((await fixture.tryLogin(PASSWORD)).status).toBe(409);

		const set = await setTotp((secret) => `${totpCode(secret, T0)}\n`);
		expect(set.code).toBe(0);
		expect(set.stdout).toContain('已設定 TOTP');
		const file = join(fixture.dir, 'board-state/totp.json');
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(file, 'utf8')).secret).toBe(set.secret);

		// The code that confirmed it does not log in; the next one does.
		const step = stepCookieOf(await fixture.tryLogin(PASSWORD));
		expect((await fixture.tryCode(step, totpCode(set.secret, T0))).status).toBe(401);
		fixture.setClock(T0 + STEP_MS);
		expect((await fixture.tryCode(step, totpCode(set.secret, T0 + STEP_MS))).status).toBe(200);
	});

	test('running it again replaces the secret: codes from the old one no longer log in', async () => {
		fixture.setClock(T0 + 10 * STEP_MS);
		const old = JSON.parse(readFileSync(join(fixture.dir, 'board-state/totp.json'), 'utf8')).secret;
		const replaced = await setTotp((secret) => `${totpCode(secret, T0 + 10 * STEP_MS)}\n`);
		expect(replaced.code).toBe(0);
		expect(replaced.stdout).toContain('已更換 TOTP');
		expect(replaced.secret).not.toBe(old);

		fixture.setClock(T0 + 11 * STEP_MS);
		const step = stepCookieOf(await fixture.tryLogin(PASSWORD));
		expect((await fixture.tryCode(step, totpCode(old, T0 + 11 * STEP_MS))).status).toBe(401);
		expect((await fixture.tryCode(step, totpCode(replaced.secret, T0 + 11 * STEP_MS))).status).toBe(200);
	});

	test('clearing it stops password logins until it is set again', async () => {
		const cleared = fixture.cli('totp', 'clear');
		expect(cleared.code).toBe(0);
		expect(cleared.stdout).toContain('已清除 TOTP');
		expect((await fixture.tryLogin(PASSWORD)).status).toBe(409);
		expect(await (await fixture.fetch('/login')).text()).toContain('bun run board totp');
		expect(fixture.cli('totp', 'clear').stdout).toContain('沒有設定 TOTP');
	});
});
