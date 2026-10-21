import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PASSWORD, sleep, startFixture, until, type Fixture } from './harness.ts';

let fixture: Fixture;
const json = { 'content-type': 'application/json' };
const LOCK_SECONDS = 2;

const cookieOf = (response: Response) => response.headers.getSetCookie()[0].split(';')[0];

/** Every file the board keeps in its state directory, as text. */
function stateFiles(dir: string): string {
	const stateDir = join(dir, 'board-state');
	return readdirSync(stateDir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'))
		.join('\n');
}

beforeAll(async () => {
	fixture = await startFixture({ env: { LAT_BOARD_LOGIN_LOCK_SECONDS: String(LOCK_SECONDS) } });
	fixture.list([fixture.bound('alpha', 'luna')]);
	await fixture.refresh(await fixture.login());
});
afterAll(() => fixture.cleanup());

test('a browser that is not logged in is sent to the login screen and sees no board data', async () => {
	const page = await fixture.fetch('/');
	expect(page.status).toBe(303);
	expect(page.headers.get('location')).toBe('/login');

	const login = await fixture.fetch('/login');
	expect(login.status).toBe(200);
	const html = await login.text();
	expect(html).toContain('type="password"');
	expect(html).not.toContain('luna');
});

test('every data endpoint and the event stream refuse a caller that is not logged in', async () => {
	const calls: [string, RequestInit][] = [
		['/api/board', {}],
		['/api/events', {}],
		['/api/refresh', { method: 'POST', headers: json }],
		['/api/anything-else', {}]
	];
	for (const [path, init] of calls) {
		const response = await fixture.fetch(path, init);
		expect([path, response.status]).toEqual([path, 401]);
		expect(await response.text()).not.toContain('luna');
	}
	const forged = await fixture.fetch('/api/board', { cookie: 'lat_board_device=not-a-real-token' });
	expect(forged.status).toBe(401);
});

test('the right password logs the browser in for 400 days', async () => {
	const response = await fixture.tryLogin(PASSWORD);

	expect(response.status).toBe(200);
	const cookie = response.headers.getSetCookie()[0];
	expect(cookie).toContain('HttpOnly');
	expect(cookie).toContain(`Max-Age=${400 * 24 * 60 * 60}`);
	const board = await fixture.board(cookieOf(response));
	expect(board.controllers.map((controller) => controller.hcomName)).toEqual(['luna']);
});

test('a wrong or empty password is refused and logs nothing in', async () => {
	for (const password of ['not-the-password', '']) {
		const response = await fixture.tryLogin(password);
		expect(response.status).toBe(401);
		expect(response.headers.getSetCookie()).toEqual([]);
	}
	// A right password resets the count of wrong ones.
	expect((await fixture.tryLogin(PASSWORD)).status).toBe(200);
});

test('after 5 wrong passwords in a row the source is refused, told how long to wait, then let back in', async () => {
	for (let i = 1; i < 5; i++) expect((await fixture.tryLogin(`wrong-${i}`)).status).toBe(401);

	const fifth = await fixture.tryLogin('wrong-5');
	expect(fifth.status).toBe(429);
	expect(await fifth.json()).toEqual({ error: 'locked', retryAfterSeconds: LOCK_SECONDS });
	expect(fifth.headers.get('retry-after')).toBe(String(LOCK_SECONDS));

	// Even the right password is refused while the wait lasts.
	const during = await fixture.tryLogin(PASSWORD);
	expect(during.status).toBe(429);
	expect(during.headers.getSetCookie()).toEqual([]);

	await sleep(LOCK_SECONDS * 1000 + 200);
	expect((await fixture.tryLogin(PASSWORD)).status).toBe(200);
});

test('many wrong passwords sent at once get no more than 5 tries', async () => {
	const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => fixture.tryLogin(`burst-${i}`)));

	expect(responses.filter((response) => response.status === 401).length).toBeLessThanOrEqual(4);
	expect((await fixture.tryLogin(PASSWORD)).status).toBe(429);
	await sleep(LOCK_SECONDS * 1000 + 200);
	expect((await fixture.tryLogin(PASSWORD)).status).toBe(200);
});

test('a logged-in browser opening the login screen goes straight to the board', async () => {
	const cookie = await fixture.login();

	const response = await fixture.fetch('/login', { cookie });

	expect(response.status).toBe(303);
	expect(response.headers.get('location')).toBe('/');
	const page = await fixture.fetch('/', { cookie });
	expect(page.status).toBe(200);
	expect(await page.text()).toContain('luna');
});

test('a changed password works at once and the old one no longer does; logged-in devices stay in', async () => {
	const before = await fixture.login();
	const changed = fixture.cliWithInput('new-password-2\nnew-password-2\n', 'password');
	try {
		expect(changed.code).toBe(0);
		expect(changed.stdout).toContain('已變更密碼');

		expect((await fixture.tryLogin(PASSWORD)).status).toBe(401);
		expect((await fixture.tryLogin('new-password-2')).status).toBe(200);
		expect((await fixture.fetch('/api/board', { cookie: before })).status).toBe(200);
	} finally {
		fixture.setPassword(PASSWORD);
	}
});

test('the host command refuses two different entries or an empty one and keeps the old password', async () => {
	const mismatch = fixture.cliWithInput('first-try\nsecond-try\n', 'password');
	expect(mismatch.code).toBe(1);
	expect(mismatch.stderr).toContain('兩次輸入不一致');

	const empty = fixture.cliWithInput('\n\n', 'password');
	expect(empty.code).toBe(1);
	expect(empty.stderr).toContain('不能是空的');

	expect((await fixture.tryLogin('first-try')).status).toBe(401);
	expect((await fixture.tryLogin(PASSWORD)).status).toBe(200);
});

test('the password is nowhere in the state directory, the server output or the command output', async () => {
	const set = fixture.cliWithInput(`${PASSWORD}\n${PASSWORD}\n`, 'password');
	await fixture.tryLogin(PASSWORD);
	await fixture.tryLogin(`${PASSWORD}-wrong`);

	const stored = JSON.parse(readFileSync(join(fixture.dir, 'board-state/password.json'), 'utf8'));
	expect(stored.scheme).toBe('scrypt');
	expect(stored.salt).toBeTruthy();
	expect(stored.hash).toBeTruthy();
	for (const text of [stateFiles(fixture.dir), fixture.serverOutput(), set.stdout, set.stderr]) {
		expect(text).not.toContain(PASSWORD);
		expect(text).not.toContain(Buffer.from(PASSWORD).toString('base64'));
	}
	// Login succeeded above, so the right password reset the count again.
	expect((await fixture.tryLogin(PASSWORD)).status).toBe(200);
});

test('a device paired before the upgrade stays logged in until it is revoked', async () => {
	// What the pairing-code version left in the state directory.
	const token = 'token-from-the-pairing-version';
	const devicesPath = join(fixture.dir, 'board-state/devices.json');
	const devices = JSON.parse(readFileSync(devicesPath, 'utf8'));
	devices.push({
		id: 'a1b2c3d4',
		label: 'old-paired-phone',
		pairedAt: '2026-10-01T00:00:00.000Z',
		tokenHash: createHash('sha256').update(token).digest('hex')
	});
	writeFileSync(devicesPath, JSON.stringify(devices));
	writeFileSync(join(fixture.dir, 'board-state/pairing-codes.json'), '[]\n');
	const cookie = `lat_board_device=${token}`;

	expect((await fixture.fetch('/', { cookie })).status).toBe(200);
	expect(fixture.cli('devices').stdout).toContain('a1b2c3d4\t2026-10-01T00:00:00.000Z\told-paired-phone');

	expect(fixture.cli('revoke', 'a1b2c3d4').code).toBe(0);
	const page = await fixture.fetch('/', { cookie });
	expect([page.status, page.headers.get('location')]).toEqual([303, '/login']);
});

test('the host can list devices and revoke one; the revoked device is back at the login screen', async () => {
	const phone = await fixture.login('phone-browser');
	const desktop = await fixture.login('desktop-browser');
	const phoneStream = fixture.watch(phone);
	const desktopStream = fixture.watch(desktop);
	await until(() => phoneStream.latest() && desktopStream.latest(), 5_000, 'both streams to deliver the board');

	const listed = fixture.cli('devices').stdout.trim().split('\n').map((line) => line.split('\t'));
	const phoneId = listed.find((row) => row[2] === 'phone-browser')![0];
	expect(listed.some((row) => row[2] === 'desktop-browser')).toBe(true);

	const revoked = fixture.cli('revoke', phoneId);
	expect(revoked.code).toBe(0);

	// The open stream is told to leave, and every later request is refused.
	await until(() => phoneStream.unpaired, 5_000, 'the revoked stream to be closed');
	expect((await fixture.fetch('/api/board', { cookie: phone })).status).toBe(401);
	const page = await fixture.fetch('/', { cookie: phone });
	expect([page.status, page.headers.get('location')]).toEqual([303, '/login']);
	expect(fixture.cli('devices').stdout).not.toContain('phone-browser');

	// The other device keeps working.
	expect(desktopStream.unpaired).toBe(false);
	expect((await fixture.fetch('/api/board', { cookie: desktop })).status).toBe(200);
});

test('revoking an unknown device fails without touching the others', async () => {
	const before = fixture.cli('devices').stdout;

	const result = fixture.cli('revoke', 'ffffffff');

	expect(result.code).toBe(1);
	expect(fixture.cli('devices').stdout).toBe(before);
});

test('an unreadable password file is reported on the login screen and logs nothing in', async () => {
	const path = join(fixture.dir, 'board-state/password.json');
	const saved = readFileSync(path, 'utf8');
	writeFileSync(path, 'not json');
	try {
		const page = await fixture.fetch('/login');
		expect(page.status).toBe(200);
		expect(await page.text()).toContain('密碼檔讀不出來');

		const response = await fixture.tryLogin(PASSWORD);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: 'password_unreadable' });
		expect(response.headers.getSetCookie()).toEqual([]);

		// What the screen says to do repairs it.
		const repaired = fixture.cliWithInput(`${PASSWORD}\n${PASSWORD}\n`, 'password');
		expect(repaired.code).toBe(0);
		expect(repaired.stderr).toContain('讀不出來');
		expect(repaired.stdout).toContain('已變更密碼');
	} finally {
		if (readFileSync(path, 'utf8') === 'not json') writeFileSync(path, saved);
	}
	expect((await fixture.tryLogin(PASSWORD)).status).toBe(200);
});

describe('before a password is set', () => {
	let fresh: Fixture;
	beforeAll(async () => {
		fresh = await startFixture({ password: null });
	});
	afterAll(() => fresh.cleanup());

	test('the login screen names the command to run, and nothing logs in', async () => {
		const html = await (await fresh.fetch('/login')).text();
		expect(html).toContain('bun run board password');
		expect(html).not.toContain('type="password"');

		const response = await fresh.tryLogin('anything');
		expect(response.status).toBe(409);
		expect(response.headers.getSetCookie()).toEqual([]);
		expect((await fresh.fetch('/api/board')).status).toBe(401);
	});

	test('setting the password on the host lets the browser in without a restart', async () => {
		const set = fresh.cliWithInput('first-password\nfirst-password\n', 'password');
		expect(set.stdout).toContain('已設定密碼');

		const response = await fresh.tryLogin('first-password');
		expect(response.status).toBe(200);
		expect((await fresh.fetch('/api/board', { cookie: cookieOf(response) })).status).toBe(200);
	});
});
