// Who may reach the board and what every answer carries: the source list, the browser's address
// behind a trusted proxy, HTTPS-only cookies and headers, login time limits, and the login lock
// across a restart. Requests leave from chosen loopback addresses (curl --interface), so
// 127.0.0.2 plays the trusted proxy and 127.0.0.3 a machine that is not on the list.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { BUILD_DIR, DAY, PASSWORD, startFixture, type Fixture } from '../harness.ts';

const PROXY = '127.0.0.2';
const OUTSIDER = '127.0.0.3';
const LOCK_SECONDS = 60;
const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const CONTENT_POLICY = "frame-ancestors 'none'; object-src 'none'; base-uri 'self'";
// Files adapter-node serves itself, before SvelteKit and its hooks: one script of this build, an icon, the service worker.
const BUILT_FILES = [
	`/_app/immutable/entry/${readdirSync(join(import.meta.dir, '../..', BUILD_DIR, 'client/_app/immutable/entry')).find((name) => name.endsWith('.js'))}`,
	'/favicon.ico',
	'/pd-sw.js'
];

interface Answer {
	status: number;
	headers: Headers;
	cookies: string[];
	body: string;
}

/** One request from the local address `from`, as curl prints it. */
async function request(base: string, from: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Answer> {
	const args = ['-s', '-i', '--interface', from, '-X', init.method ?? 'GET'];
	for (const [name, value] of Object.entries(init.headers ?? {})) args.push('-H', `${name}: ${value}`);
	if (init.body !== undefined) args.push('--data-binary', init.body);
	const child = Bun.spawn(['curl', ...args, base + path], { stdout: 'pipe', stderr: 'pipe' });
	const text = await new Response(child.stdout).text();
	if ((await child.exited) !== 0) throw new Error(`curl failed: ${await new Response(child.stderr).text()}`);
	const split = text.indexOf('\r\n\r\n');
	const [statusLine, ...lines] = text.slice(0, split).split('\r\n');
	const headers = new Headers();
	const cookies: string[] = [];
	for (const line of lines) {
		const colon = line.indexOf(':');
		const name = line.slice(0, colon).trim();
		const value = line.slice(colon + 1).trim();
		if (name.toLowerCase() === 'set-cookie') cookies.push(value);
		else headers.append(name, value);
	}
	return { status: Number(statusLine.split(' ')[1]), headers, cookies, body: text.slice(split + 4) };
}

const loginBody = (password: string) => ({ method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'curl-device' }, body: JSON.stringify({ password }) });

/** The addresses of the login locks the server wrote down since `from` characters into its output. */
function locks(fixture: Fixture, from: number): string[] {
	return fixture
		.serverOutput()
		.slice(from)
		.split('\n')
		.filter((line) => line.includes('"login_locked"'))
		.map((line) => JSON.parse(line).client_ip);
}

describe('a board with a proxy on its list', () => {
	let fixture: Fixture;
	const from = (address: string, path: string, init?: Parameters<typeof request>[3]) => request(fixture.url, address, path, init);
	const viaProxy = (headers: Record<string, string>, password: string) => {
		const body = loginBody(password);
		return from(PROXY, '/api/login', { ...body, headers: { ...body.headers, ...headers } });
	};

	beforeAll(async () => {
		fixture = await startFixture({
			env: { LAT_BOARD_ALLOWED_SOURCES: `127.0.0.1, ${PROXY}`, LAT_BOARD_TRUSTED_PROXIES: PROXY, LAT_BOARD_LOGIN_LOCK_SECONDS: String(LOCK_SECONDS) }
		});
		fixture.setClock(T0);
	});
	afterAll(() => fixture.cleanup());

	test('a connection from outside the list is refused before any route, the login screen included', async () => {
		const before = fixture.serverOutput().length;
		for (const [path, init] of [['/login', {}], ['/', {}], ['/api/board', {}], ['/api/login', loginBody(PASSWORD)], ['/api/login/test', loginBody('x')]] as const) {
			const answer = await from(OUTSIDER, path, init);
			expect([path, answer.status, answer.body, answer.cookies]).toEqual([path, 403, 'Forbidden', []]);
			expect(answer.headers.get('content-security-policy')).toBe(CONTENT_POLICY);
		}
		// A forwarded header does not help a connection that is not on the list.
		expect((await from(OUTSIDER, '/login', { headers: { 'x-forwarded-for': PROXY } })).status).toBe(403);
		expect(fixture.serverOutput().slice(before)).toContain(`"peer":"${OUTSIDER}"`);

		expect((await from('127.0.0.1', '/login')).status).toBe(200);
		expect((await from(PROXY, '/login')).status).toBe(200);
	});

	test('the built files are refused to a connection off the list and carry the headers like every page', async () => {
		for (const path of BUILT_FILES) {
			const refused = await from(OUTSIDER, path);
			expect([path, refused.status, refused.body]).toEqual([path, 403, 'Forbidden']);
			const served = await from('127.0.0.1', path);
			expect([path, served.status, served.headers.get('content-security-policy'), served.headers.get('x-content-type-options')]).toEqual([path, 200, CONTENT_POLICY, 'nosniff']);
			expect(served.headers.get('x-frame-options')).toBe('DENY');
			expect(served.headers.get('strict-transport-security')).toBeNull();
			const secure = await from(PROXY, path, { headers: { 'x-forwarded-proto': 'https' } });
			expect(secure.headers.get('strict-transport-security')).toBe('max-age=31536000');
		}
	});

	test("SvelteKit's own error page, when the request hook fails, carries the headers too", async () => {
		const devices = join(fixture.dir, 'board-state/devices.json');
		const saved = existsSync(devices) ? readFileSync(devices, 'utf8') : null;
		writeFileSync(devices, 'not json');
		try {
			const failed = await from('127.0.0.1', '/', { headers: { cookie: 'lat_board_device=any-token' } });
			expect(failed.status).toBe(500);
			expect(failed.headers.get('content-security-policy')).toBe(CONTENT_POLICY);
			expect(failed.headers.get('x-frame-options')).toBe('DENY');
		} finally {
			if (saved === null) rmSync(devices);
			else writeFileSync(devices, saved);
		}
	});

	test('every answer carries the security headers; HSTS only when a trusted proxy says the browser used HTTPS', async () => {
		const cookie = await fixture.login();
		const answers = [
			await from('127.0.0.1', '/login'),
			await from('127.0.0.1', '/'),
			await from('127.0.0.1', '/api/board'),
			await from('127.0.0.1', '/', { headers: { cookie } }),
			await from('127.0.0.1', '/api/board', { headers: { cookie } })
		];
		expect(answers.map((answer) => answer.status)).toEqual([200, 303, 401, 200, 200]);
		for (const answer of answers) {
			expect(answer.headers.get('content-security-policy')).toBe(CONTENT_POLICY);
			expect(answer.headers.get('x-frame-options')).toBe('DENY');
			expect(answer.headers.get('x-content-type-options')).toBe('nosniff');
			expect(answer.headers.get('referrer-policy')).toBe('same-origin');
			expect(answer.headers.get('strict-transport-security')).toBeNull();
		}
		expect((await from(PROXY, '/login', { headers: { 'x-forwarded-proto': 'https' } })).headers.get('strict-transport-security')).toBe('max-age=31536000');
		expect((await from(PROXY, '/login', { headers: { 'x-forwarded-proto': 'http' } })).headers.get('strict-transport-security')).toBeNull();
		// Said by a connection that is not a trusted proxy, it is not believed.
		expect((await from('127.0.0.1', '/login', { headers: { 'x-forwarded-proto': 'https' } })).headers.get('strict-transport-security')).toBeNull();
	});

	test('the login cookie is Secure only over HTTPS through the trusted proxy, and lasts 30 days', async () => {
		const secure = await viaProxy({ 'x-forwarded-proto': 'https', 'x-forwarded-for': '198.51.100.20' }, PASSWORD);
		expect(secure.status).toBe(200);
		expect(secure.cookies[0]).toContain('; Secure');
		expect(secure.cookies[0]).toContain(`Max-Age=${30 * 24 * 60 * 60}`);

		const plainProxy = await viaProxy({ 'x-forwarded-for': '198.51.100.20' }, PASSWORD);
		const forged = await from('127.0.0.1', '/api/login', { ...loginBody(PASSWORD), headers: { ...loginBody(PASSWORD).headers, 'x-forwarded-proto': 'https' } });
		for (const answer of [plainProxy, forged]) {
			expect(answer.status).toBe(200);
			expect(answer.cookies[0]).not.toContain('Secure');
		}
		// The plain http cookie logs in.
		expect((await fixture.fetch('/api/board', { cookie: forged.cookies[0].split(';')[0] })).status).toBe(200);
	});

	test('behind the trusted proxy the lock and the log follow the browser, not the proxy', async () => {
		const before = fixture.serverOutput().length;
		for (let i = 1; i < 5; i++) expect((await viaProxy({ 'x-forwarded-for': '203.0.113.7' }, `wrong-${i}`)).status).toBe(401);
		const fifth = await viaProxy({ 'x-forwarded-for': '203.0.113.7' }, 'wrong-5');
		expect(fifth.status).toBe(429);
		expect((await viaProxy({ 'x-forwarded-for': '203.0.113.7' }, PASSWORD)).status).toBe(429);

		// Another browser behind the same proxy, and the host itself, are not locked out.
		expect((await viaProxy({ 'x-forwarded-for': '203.0.113.8' }, PASSWORD)).status).toBe(200);
		expect((await fixture.tryLogin(PASSWORD)).status).toBe(200);

		expect(locks(fixture, before)).toEqual(['203.0.113.7']);
		fixture.setClock(T0 + LOCK_SECONDS * 1000);
	});

	test('a forged X-Forwarded-For from a connection that is not a trusted proxy is not believed', async () => {
		const before = fixture.serverOutput().length;
		const direct = (forwarded: string, password: string) =>
			from('127.0.0.1', '/api/login', { ...loginBody(password), headers: { ...loginBody(password).headers, 'x-forwarded-for': forwarded } });
		for (let i = 1; i < 5; i++) expect((await direct(`198.51.100.${i}`, `wrong-${i}`)).status).toBe(401);
		expect((await direct('198.51.100.5', 'wrong-5')).status).toBe(429);
		// A fresh made-up address does not get the host round the lock.
		expect((await direct('198.51.100.6', PASSWORD)).status).toBe(429);
		expect(locks(fixture, before)).toEqual(['127.0.0.1']);
		// The addresses it made up are not locked.
		expect((await viaProxy({ 'x-forwarded-for': '198.51.100.6' }, PASSWORD)).status).toBe(200);
		fixture.setClock(T0 + 2 * LOCK_SECONDS * 1000);
	});

	test('X-Real-IP and CF-Connecting-IP are never read; X-Forwarded-For is read right to left, and a malformed one falls back to the proxy', async () => {
		const cases: [Record<string, string>, string][] = [
			[{ 'x-real-ip': '198.51.100.50', 'cf-connecting-ip': '198.51.100.51' }, PROXY],
			[{ 'x-forwarded-for': `1.2.3.4, 198.51.100.60, ${PROXY}` }, '198.51.100.60'],
			[{ 'x-forwarded-for': 'junk, 198.51.100.61' }, PROXY],
			[{ 'x-forwarded-for': '198.51.100.62', 'x-real-ip': '198.51.100.63' }, '198.51.100.62']
		];
		let time = T0 + 2 * LOCK_SECONDS * 1000;
		for (const [headers, expected] of cases) {
			const before = fixture.serverOutput().length;
			for (let i = 1; i < 5; i++) expect((await viaProxy(headers, `wrong-${i}`)).status).toBe(401);
			expect((await viaProxy(headers, 'wrong-5')).status).toBe(429);
			expect([headers, locks(fixture, before)]).toEqual([headers, [expected]]);
			fixture.setClock((time += LOCK_SECONDS * 1000));
		}
	});

	test('a lock outlasts a restart of the board', async () => {
		fixture.setClock(T0 + 10 * LOCK_SECONDS * 1000);
		for (let i = 1; i <= 5; i++) await viaProxy({ 'x-forwarded-for': '203.0.113.9' }, `wrong-${i}`);
		expect((await viaProxy({ 'x-forwarded-for': '203.0.113.9' }, PASSWORD)).status).toBe(429);

		await fixture.stop();
		await fixture.start();
		const after = await viaProxy({ 'x-forwarded-for': '203.0.113.9' }, PASSWORD);
		expect(after.status).toBe(429);
		expect(JSON.parse(after.body)).toEqual({ error: 'locked', retryAfterSeconds: LOCK_SECONDS });
		fixture.setClock(T0 + 11 * LOCK_SECONDS * 1000);
		expect((await viaProxy({ 'x-forwarded-for': '203.0.113.9' }, PASSWORD)).status).toBe(200);
	});

	test('a login ends 30 days after it was made however much it is used, or after 7 days without a request', async () => {
		const start = T0 + DAY;
		fixture.setClock(start);
		const used = await fixture.login('used-every-6-days');
		const idle = await fixture.login('idle-for-7-days');
		const back = await fixture.login('back-after-6-days');
		for (const day of [6, 12, 18, 24]) {
			fixture.setClock(start + day * DAY);
			expect([day, (await fixture.fetch('/api/board', { cookie: used })).status]).toEqual([day, 200]);
			if (day === 6) expect((await fixture.fetch('/api/board', { cookie: back })).status).toBe(200);
		}
		fixture.setClock(start + 30 * DAY - 60_000);
		expect((await fixture.fetch('/api/board', { cookie: used })).status).toBe(200);

		fixture.setClock(start + 30 * DAY);
		// Over: as if the device had been revoked.
		expect((await fixture.fetch('/api/board', { cookie: used })).status).toBe(401);
		const page = await fixture.fetch('/', { cookie: used });
		expect([page.status, page.headers.get('location')]).toEqual([303, '/login']);
		expect((await fixture.fetch('/api/board', { cookie: idle })).status).toBe(401);
		// Seen on day 6, so its 7 idle days ran out on day 13, before day 30.
		expect((await fixture.fetch('/api/board', { cookie: back })).status).toBe(401);
		expect(fixture.cli('devices').stdout).toMatch(/\tused-every-6-days\t（登入已失效，須重新登入）/);

		// A device idle for just under 7 days is still in; at 7 days it is out.
		const fresh = await fixture.login('fresh');
		fixture.setClock(start + 37 * DAY - 60_000);
		expect((await fixture.fetch('/api/board', { cookie: fresh })).status).toBe(200);
		fixture.setClock(start + 44 * DAY - 60_000);
		expect((await fixture.fetch('/api/board', { cookie: fresh })).status).toBe(401);
	});

	test('the 7 idle days count from the last request itself, not from when it was last written down', async () => {
		const start = T0 + 100 * DAY;
		fixture.setClock(start);
		const cookie = await fixture.login('seen-twice-in-a-minute');
		fixture.setClock(start + 10_000);
		expect((await fixture.fetch('/api/board', { cookie })).status).toBe(200);
		// Within a minute of the last write: not written again, but the server knows it.
		fixture.setClock(start + 50_000);
		expect((await fixture.fetch('/api/board', { cookie })).status).toBe(200);
		fixture.setClock(start + 50_000 + 7 * DAY - 1_000);
		expect((await fixture.fetch('/api/board', { cookie })).status).toBe(200);
		fixture.setClock(start + 50_000 + 7 * DAY - 1_000 + 7 * DAY);
		expect((await fixture.fetch('/api/board', { cookie })).status).toBe(401);
	});

	test('a normal stop writes the last requests down, so a restart does not shorten the idle time', async () => {
		const start = T0 + 200 * DAY;
		fixture.setClock(start);
		const cookie = await fixture.login('seen-before-a-restart');
		fixture.setClock(start + 10_000);
		expect((await fixture.fetch('/api/board', { cookie })).status).toBe(200);
		fixture.setClock(start + 50_000);
		expect((await fixture.fetch('/api/board', { cookie })).status).toBe(200);

		await fixture.stop('SIGTERM');
		await fixture.start();
		fixture.setClock(start + 50_000 + 7 * DAY - 1_000);
		expect((await fixture.fetch('/api/board', { cookie })).status).toBe(200);
	});
});

// A non-loopback address of this host: a connection to it comes from it, which is not the host's loopback.
const lanAddress = Object.values(networkInterfaces())
	.flat()
	.find((entry) => entry && entry.family === 'IPv4' && !entry.internal)?.address;

describe.skipIf(!lanAddress)('a board with no source list', () => {
	let fixture: Fixture;
	beforeAll(async () => {
		fixture = await startFixture({ env: { HOST: '0.0.0.0' } });
	});
	afterAll(() => fixture.cleanup());

	test('only the host itself may connect', async () => {
		const port = new URL(fixture.url).port;
		expect((await request(`http://127.0.0.1:${port}`, '127.0.0.1', '/login')).status).toBe(200);
		const refused = await request(`http://${lanAddress}:${port}`, lanAddress!, '/login');
		expect([refused.status, refused.body]).toEqual([403, 'Forbidden']);
		expect((await request(`http://${lanAddress}:${port}`, lanAddress!, '/api/login', loginBody(PASSWORD))).status).toBe(403);
	});
});
