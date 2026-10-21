// Whether conversations open translated is one setting for every logged-in device: kept in the board's state
// directory, read and written only by logged-in devices, pushed to every open page over the event
// stream, and 手動切換 until someone chooses otherwise. Runs on the built board.
import { chmodSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startFixture, until, type Fixture } from '../harness.ts';

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

const stateFile = () => join(fixture.dir, 'board-state/translate-mode.json');
const put = (mode: unknown, device = cookie) =>
	fixture.fetch('/api/translate-mode', {
		method: 'PUT',
		cookie: device,
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ mode })
	});
const get = async (device = cookie) => (await (await fixture.fetch('/api/translate-mode', { cookie: device })).json()).mode;

test('with nothing saved the mode is 手動切換, for a new page too', async () => {
	expect(existsSync(stateFile())).toBe(false);
	expect(await get()).toBe('manual');
	const page = fixture.watch(cookie);
	await until(() => page.translateModes.at(0), 5_000, 'the mode on connecting');
	expect(page.translateModes).toEqual(['manual']);
	page.close();
});

test('only a logged-in device can read or change it', async () => {
	expect((await fixture.fetch('/api/translate-mode')).status).toBe(401);
	expect((await fixture.fetch('/api/translate-mode', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'auto' }) })).status).toBe(401);
	expect(existsSync(stateFile())).toBe(false);
});

test('a mode that is neither 自動翻譯 nor 手動切換 is refused and nothing changes', async () => {
	for (const mode of ['', 'tiny', 1, null, undefined]) expect((await put(mode)).status).toBe(400);
	expect((await fixture.fetch('/api/translate-mode', { method: 'PUT', cookie, headers: { 'content-type': 'application/json' }, body: 'not json' })).status).toBe(400);
	expect(await get()).toBe('manual');
	expect(existsSync(stateFile())).toBe(false);
});

test('a change on one device reaches every open page and every device that asks later, and survives a restart', async () => {
	const other = await fixture.login('second-device');
	const mine = fixture.watch(cookie);
	const theirs = fixture.watch(other);
	await until(() => mine.translateModes.length && theirs.translateModes.length, 5_000, 'both pages to connect');

	const saved = await put('auto');
	expect(saved.status).toBe(200);
	const { mode, revision } = await saved.json();
	expect(mode).toBe('auto');
	await until(() => theirs.translateModes.at(-1) === 'auto', 5_000, 'the other device to hear of 自動翻譯');
	await until(() => mine.translateModes.at(-1) === 'auto', 5_000, 'this device to hear of 自動翻譯');
	expect(await get(other)).toBe('auto');
	expect(JSON.parse(readFileSync(stateFile(), 'utf8'))).toEqual({ mode: 'auto' });
	expect(statSync(stateFile()).mode & 0o777).toBe(0o600);
	expect(readdirSync(join(fixture.dir, 'board-state')).filter((name) => name.endsWith('.tmp'))).toEqual([]);

	await fixture.stop();
	await fixture.start();
	expect(await get(other)).toBe('auto');
	const later = fixture.watch(other);
	await until(() => later.translateModes.at(0), 10_000, 'a page opened after the restart');
	expect(later.translateModes).toEqual(['auto']);

	// Every save is a newer revision, restarts included, for pages to tell the newer report apart.
	expect((await fixture.fetch('/api/translate-mode', { cookie: other }).then((response) => response.json())).revision).toBeGreaterThan(revision);
	const changed = await put('manual', other);
	expect((await changed.json()).revision).toBeGreaterThan(revision);
	await until(() => later.translateModes.at(-1) === 'manual', 5_000, 'back to 手動切換 on the page');
	expect(await get()).toBe('manual');
	for (const watch of [mine, theirs, later]) watch.close();
});

test('a mode that cannot be saved is refused, kept as it was and not pushed', async () => {
	expect((await put('auto')).status).toBe(200);
	const page = fixture.watch(cookie);
	await until(() => page.translateModes.at(-1) === 'auto', 5_000, 'the page to connect');
	const heard = page.translateModes.length;

	chmodSync(join(fixture.dir, 'board-state'), 0o500);
	try {
		const refused = await put('manual');
		expect(refused.status).toBe(500);
		expect(await get()).toBe('auto');
		expect(JSON.parse(readFileSync(stateFile(), 'utf8'))).toEqual({ mode: 'auto' });
		await Bun.sleep(300);
		expect(page.translateModes.length).toBe(heard);
	} finally {
		chmodSync(join(fixture.dir, 'board-state'), 0o700);
	}
	page.close();
});

test('a saved file that cannot be used reads as 手動切換 and the next save replaces it', async () => {
	await fixture.stop();
	await Bun.write(stateFile(), '{"mode":"huge"}');
	await fixture.start();
	expect(await get()).toBe('manual');
	expect((await put('auto')).status).toBe(200);
	expect(JSON.parse(readFileSync(stateFile(), 'utf8'))).toEqual({ mode: 'auto' });
});
