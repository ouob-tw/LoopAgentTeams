import { afterAll, beforeAll, expect, test } from 'bun:test';
import { named, startFixture, until, type Fixture } from '../harness.ts';

let fixture: Fixture;

beforeAll(async () => {
	fixture = await startFixture();
});
afterAll(() => fixture.cleanup());

test('the page reports a lost connection, then reconnects by itself and shows the new data', async () => {
	const cookie = await fixture.login();
	fixture.list([fixture.bound('alpha', 'luna')]);
	await fixture.refresh(cookie);
	const page = fixture.watch(cookie);
	await until(() => named(page.latest(), 'luna'), 5_000, 'the first snapshot');
	expect(page.states.at(-1)).toBe('live');

	await fixture.stop();
	await until(() => page.states.at(-1) === 'offline', 5_000, 'the page to notice the server is gone');

	// Changed while the server was down; nothing asks for a refresh.
	fixture.list([fixture.bound('alpha', 'luna'), fixture.bound('beta', 'nova')]);
	await fixture.start();

	await until(() => page.states.at(-1) === 'live', 10_000, 'the page to reconnect');
	await until(() => named(page.latest(), 'nova'), 5_000, 'the data read after the restart');
	expect(page.unpaired).toBe(false);
});
