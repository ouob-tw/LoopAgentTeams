// The login cookie's name is a server setting: a board that sets its own keeps its login apart from
// another board the same browser reaches under the same host name (cookies ignore the port).
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';

const OWN = 'lat_board_other';
let plain: Fixture;
let own: Fixture;

beforeAll(async () => {
	plain = await startFixture();
	own = await startFixture({ env: { LAT_BOARD_COOKIE_NAME: OWN } });
});
afterAll(async () => {
	await plain.cleanup();
	await own.cleanup();
});

const renamed = (cookie: string, name: string) => `${name}=${cookie.split('=')[1]}`;

test('without the setting the login cookie keeps its name', async () => {
	const cookie = await plain.login();
	expect(cookie.startsWith('lat_board_device=')).toBe(true);
	expect((await plain.fetch('/api/board', { cookie })).status).toBe(200);
});

test('with the setting the login sets that name and only that name is accepted', async () => {
	const cookie = await own.login();
	expect(cookie.startsWith(`${OWN}=`)).toBe(true);
	expect((await own.fetch('/api/board', { cookie })).status).toBe(200);
	expect((await own.fetch('/api/board', { cookie: renamed(cookie, 'lat_board_device') })).status).toBe(401);
	// The same token under the other board's default name is a different cookie there.
	expect((await plain.fetch('/api/board', { cookie })).status).toBe(401);
});

test('the event streams read the configured name too', async () => {
	const cookie = await own.login();
	for (const path of ['/api/events', '/api/transcript/events', '/api/agents/transcript/events']) {
		const response = await own.fetch(path, { cookie: renamed(cookie, 'lat_board_device') });
		expect([path, response.status]).toEqual([path, 401]);
	}
});
