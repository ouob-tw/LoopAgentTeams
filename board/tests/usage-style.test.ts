// The usage line's style is one setting for every logged-in device: kept in the board's state
// directory, read and written only by logged-in devices, pushed to every open page over the event
// stream, and 詳細 until someone chooses otherwise. Runs on the built board.
import { chmodSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startFixture, until, type Fixture } from './harness.ts';

let fixture: Fixture;
let cookie: string;

beforeAll(async () => {
	fixture = await startFixture();
	cookie = await fixture.login();
});
afterAll(async () => {
	// Left read-only by the failing save below if that test did not get to restore it.
	chmodSync(join(fixture.dir, 'board-state'), 0o700);
	await fixture.cleanup();
});

const stateFile = () => join(fixture.dir, 'board-state/usage-style.json');
const put = (style: unknown, device = cookie) =>
	fixture.fetch('/api/usage-style', {
		method: 'PUT',
		cookie: device,
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ style })
	});
const get = async (device = cookie) => (await (await fixture.fetch('/api/usage-style', { cookie: device })).json()).style;

test('with nothing saved the style is 詳細, for a new page too', async () => {
	expect(existsSync(stateFile())).toBe(false);
	expect(await get()).toBe('detailed');
	const page = fixture.watch(cookie);
	await until(() => page.usageStyles.at(0), 5_000, 'the style on connecting');
	expect(page.usageStyles).toEqual(['detailed']);
	page.close();
});

test('only a logged-in device can read or change it', async () => {
	expect((await fixture.fetch('/api/usage-style')).status).toBe(401);
	expect((await fixture.fetch('/api/usage-style', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ style: 'compact' }) })).status).toBe(401);
	expect(existsSync(stateFile())).toBe(false);
});

test('a style that is neither 詳細 nor 精簡 is refused and nothing changes', async () => {
	for (const style of ['', 'tiny', 1, null, undefined]) expect((await put(style)).status).toBe(400);
	expect((await fixture.fetch('/api/usage-style', { method: 'PUT', cookie, headers: { 'content-type': 'application/json' }, body: 'not json' })).status).toBe(400);
	expect(await get()).toBe('detailed');
	expect(existsSync(stateFile())).toBe(false);
});

test('a change on one device reaches every open page and every device that asks later, and survives a restart', async () => {
	const other = await fixture.login('second-device');
	const mine = fixture.watch(cookie);
	const theirs = fixture.watch(other);
	await until(() => mine.usageStyles.length && theirs.usageStyles.length, 5_000, 'both pages to connect');

	const saved = await put('compact');
	expect(saved.status).toBe(200);
	const { style, revision } = await saved.json();
	expect(style).toBe('compact');
	await until(() => theirs.usageStyles.at(-1) === 'compact', 5_000, 'the other device to hear of 精簡');
	await until(() => mine.usageStyles.at(-1) === 'compact', 5_000, 'this device to hear of 精簡');
	expect(await get(other)).toBe('compact');
	expect(JSON.parse(readFileSync(stateFile(), 'utf8'))).toEqual({ style: 'compact' });
	expect(statSync(stateFile()).mode & 0o777).toBe(0o600);
	expect(readdirSync(join(fixture.dir, 'board-state')).filter((name) => name.endsWith('.tmp'))).toEqual([]);

	await fixture.stop();
	await fixture.start();
	expect(await get(other)).toBe('compact');
	const later = fixture.watch(other);
	await until(() => later.usageStyles.at(0), 10_000, 'a page opened after the restart');
	expect(later.usageStyles).toEqual(['compact']);

	// Every save is a newer revision, restarts included, for pages to tell the newer report apart.
	expect((await fixture.fetch('/api/usage-style', { cookie: other }).then((response) => response.json())).revision).toBeGreaterThan(revision);
	const changed = await put('detailed', other);
	expect((await changed.json()).revision).toBeGreaterThan(revision);
	await until(() => later.usageStyles.at(-1) === 'detailed', 5_000, 'back to 詳細 on the page');
	expect(await get()).toBe('detailed');
	for (const watch of [mine, theirs, later]) watch.close();
});

test('a style that cannot be saved is refused, kept as it was and not pushed', async () => {
	expect((await put('compact')).status).toBe(200);
	const page = fixture.watch(cookie);
	await until(() => page.usageStyles.at(-1) === 'compact', 5_000, 'the page to connect');
	const heard = page.usageStyles.length;

	chmodSync(join(fixture.dir, 'board-state'), 0o500);
	try {
		const refused = await put('detailed');
		expect(refused.status).toBe(500);
		expect(await get()).toBe('compact');
		expect(JSON.parse(readFileSync(stateFile(), 'utf8'))).toEqual({ style: 'compact' });
		await Bun.sleep(300);
		expect(page.usageStyles.length).toBe(heard);
	} finally {
		chmodSync(join(fixture.dir, 'board-state'), 0o700);
	}
	page.close();
});

test('a saved file that cannot be used reads as 詳細 and the next save replaces it', async () => {
	await fixture.stop();
	await Bun.write(stateFile(), '{"style":"huge"}');
	await fixture.start();
	expect(await get()).toBe('detailed');
	expect((await put('compact')).status).toBe(200);
	expect(JSON.parse(readFileSync(stateFile(), 'utf8'))).toEqual({ style: 'compact' });
});
