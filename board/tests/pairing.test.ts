import { afterAll, beforeAll, expect, test } from 'bun:test';
import { sleep, startFixture, until, type Fixture } from './harness.ts';

let fixture: Fixture;
const json = { 'content-type': 'application/json' };

const newCode = () => fixture.newCode();

function tryPair(code: string): Promise<Response> {
	return fixture.fetch('/api/pair', { method: 'POST', headers: json, body: JSON.stringify({ code }) });
}

beforeAll(async () => {
	fixture = await startFixture(2, { env: { LAT_BOARD_PAIRING_TTL_SECONDS: '2' } });
	fixture.list([fixture.bound('alpha', 'luna')]);
	await fixture.refresh(await fixture.pair());
});
afterAll(() => fixture.cleanup());

test('an unpaired browser is sent to the pairing screen and sees no board data', async () => {
	const page = await fixture.fetch('/');
	expect(page.status).toBe(303);
	expect(page.headers.get('location')).toBe('/pair');

	const pairing = await fixture.fetch('/pair');
	expect(pairing.status).toBe(200);
	const html = await pairing.text();
	expect(html).toContain('配對碼');
	expect(html).not.toContain('luna');
});

test('every data endpoint refuses an unpaired caller', async () => {
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

test('a pairing code pairs one device, then stops working', async () => {
	const code = newCode();

	const first = await tryPair(code);
	expect(first.status).toBe(200);
	const cookie = first.headers.getSetCookie()[0];
	expect(cookie).toContain('HttpOnly');
	const board = await fixture.board(cookie.split(';')[0]);
	expect(board.controllers.map((controller) => controller.hcomName)).toEqual(['luna']);

	const second = await tryPair(code);
	expect(second.status).toBe(400);
	expect(second.headers.getSetCookie()).toEqual([]);
});

test('a pairing code is accepted as typed: lower case, with or without the dash', async () => {
	const code = newCode();
	expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

	expect((await tryPair(code.toLowerCase().replace('-', ' '))).status).toBe(200);
});

test('a wrong code and an expired code are both refused', async () => {
	expect((await tryPair('AAAA-AAAA')).status).toBe(400);
	expect((await tryPair('')).status).toBe(400);

	const code = newCode();
	await sleep(2_200);
	expect((await tryPair(code)).status).toBe(400);
});

test('a paired browser opening the pairing screen goes straight to the board', async () => {
	const cookie = await fixture.pair();

	const response = await fixture.fetch('/pair', { cookie });

	expect(response.status).toBe(303);
	expect(response.headers.get('location')).toBe('/');
	const page = await fixture.fetch('/', { cookie });
	expect(page.status).toBe(200);
	expect(await page.text()).toContain('luna');
});

test('the host can list devices and revoke one; the revoked device is back at the pairing screen', async () => {
	const phone = await fixture.pair('phone-browser');
	const desktop = await fixture.pair('desktop-browser');
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
	expect([page.status, page.headers.get('location')]).toEqual([303, '/pair']);
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
