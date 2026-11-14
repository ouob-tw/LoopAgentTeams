// Logging out from the board (設定 → 登出): the device's login ends on the server, like
// `board revoke` for that device, and every other device stays logged in.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startFixture, until, type Fixture } from '../harness.ts';

let fixture: Fixture;
const json = { 'content-type': 'application/json' };

beforeAll(async () => {
	fixture = await startFixture();
	fixture.list([fixture.bound('alpha', 'luna')]);
	await fixture.refresh(await fixture.login());
});
afterAll(() => fixture.cleanup());

const logout = (cookie: string, init: RequestInit = { headers: json, body: '{}' }) => fixture.fetch('/api/device', { method: 'DELETE', ...init, cookie });
const devices = () => fixture.cli('devices').stdout;

test('logging out ends that device on the server and clears its cookie; other devices stay logged in', async () => {
	const phone = await fixture.login('logout-phone');
	const desktop = await fixture.login('logout-desktop');
	const phoneStream = fixture.watch(phone);
	const desktopStream = fixture.watch(desktop);
	await until(() => phoneStream.latest() && desktopStream.latest(), 5_000, 'both streams to deliver the board');

	const response = await logout(phone);
	expect(response.status).toBe(200);
	const cleared = response.headers.getSetCookie().find((cookie) => cookie.startsWith('lat_board_device='));
	expect(cleared).toMatch(/^lat_board_device=;.*Max-Age=0/);

	// The old cookie value works for nothing: the API, the pages, the event stream, logging out again.
	await until(() => phoneStream.unpaired, 5_000, 'the logged-out stream to be closed');
	expect((await fixture.fetch('/api/board', { cookie: phone })).status).toBe(401);
	expect((await fixture.fetch('/api/device', { cookie: phone })).status).toBe(401);
	expect((await logout(phone)).status).toBe(401);
	const page = await fixture.fetch('/', { cookie: phone });
	expect([page.status, page.headers.get('location')]).toEqual([303, '/login']);
	expect(devices()).not.toContain('logout-phone');

	expect(desktopStream.unpaired).toBe(false);
	expect((await fixture.fetch('/api/board', { cookie: desktop })).status).toBe(200);
	expect(devices()).toContain('logout-desktop');
});

test('a test login logs out the same way, ending that test login', async () => {
	const issued = fixture.cli('test-login', '--url', fixture.url, '--label', 'logout-qa');
	expect(issued.code).toBe(0);
	const code = issued.stdout.match(new RegExp(`${fixture.url}/login/test#(\\S+)`))![1];
	const id = issued.stdout.match(/裝置 ([0-9a-f]{8})/)![1];
	const redeemed = await fixture.fetch('/api/login/test', { method: 'POST', headers: json, body: JSON.stringify({ code }) });
	const cookie = redeemed.headers.getSetCookie()[0].split(';')[0];
	expect((await fixture.fetch('/api/board', { cookie })).status).toBe(200);

	expect((await logout(cookie)).status).toBe(200);

	expect((await fixture.fetch('/api/board', { cookie })).status).toBe(401);
	expect(devices()).not.toContain(id);
});

test('another site cannot log the device out', async () => {
	const victim = await fixture.login('logout-victim');
	const foreign = { origin: 'https://evil.example' };
	// What a page on another site can send without asking first: a form, plain text, or no body type.
	const attempts: RequestInit[] = [
		{ headers: { ...foreign, 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' },
		{ headers: { ...foreign, 'content-type': 'text/plain' }, body: '{}' },
		{ headers: foreign }
	];
	for (const init of attempts) expect((await logout(victim, init)).status).toBe(403);

	expect((await fixture.fetch('/api/board', { cookie: victim })).status).toBe(200);
	expect(devices()).toContain('logout-victim');
});
