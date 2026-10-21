// Where the helper's registry lives is asked of Herdr through the configured command, never the
// `herdr` on the PATH, and the board does not wait for the answer to serve its pages.
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jsonLines, named, NODE, startFixture, until, type Fixture } from '../harness.ts';

const ROOT = join(import.meta.dir, '../..');
const fixtures: Fixture[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0)) await fixture.cleanup();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A folder for the fake Herdr's plan and logs, and a `herdr` on the PATH that logs every call. */
function setUp(plan: object) {
	const dir = mkdtempSync(join(tmpdir(), 'lat-board-herdr-'));
	dirs.push(dir);
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	const pathLog = join(dir, 'path-herdr-calls.log');
	writeFileSync(join(bin, 'herdr'), `#!/bin/sh\necho "$@" >> '${pathLog}'\nexit 1\n`);
	chmodSync(join(bin, 'herdr'), 0o755);
	writeFileSync(join(dir, 'herdr.json'), JSON.stringify(plan));
	const env = {
		// Unset, so the board asks Herdr where the helper's config directory is.
		HERDR_PLUGIN_CONFIG_DIR: '',
		PATH: `${bin}:${process.env.PATH ?? ''}`,
		LAT_BOARD_HERDR_COMMAND: JSON.stringify([NODE, join(ROOT, 'tests/fake-herdr.mjs'), dir])
	};
	return { dir, pathLog, env };
}

const asked = (dir: string) => jsonLines(join(dir, 'herdr-calls.jsonl')).some((args) => args.join(' ') === 'plugin config-dir lat.panel');

test('the board asks the configured Herdr command, never the one on the PATH, and watches the registry it names', async () => {
	const registryDir = mkdtempSync(join(tmpdir(), 'lat-board-registry-'));
	dirs.push(registryDir);
	const { dir, pathLog, env } = setUp({ raw: { 'plugin config-dir': `${registryDir}\n` } });
	const fixture = await startFixture({ env });
	fixtures.push(fixture);
	const cookie = await fixture.login();
	await fixture.board(cookie);
	await fixture.refresh(cookie);
	await until(() => asked(dir), 5_000, 'the configured Herdr to be asked');

	// The registry in the directory Herdr named is watched: a change there is read in without a refresh.
	const page = fixture.watch(cookie);
	await until(() => page.latest(), 5_000, 'the first snapshot');
	fixture.list([fixture.bound('alpha', 'luna')]);
	writeFileSync(join(registryDir, 'bindings.json'), '{}\n');
	await until(() => named(page.latest(), 'luna'), 5_000, 'the newly bound controller');

	expect(existsSync(pathLog)).toBe(false);
});

test('the board answers at once while Herdr takes 10 seconds to say where the registry is', async () => {
	const { dir, pathLog, env } = setUp({ slowMs: { 'plugin config-dir': 10_000 }, raw: { 'plugin config-dir': '/nonexistent\n' } });
	const started = Date.now();
	const fixture = await startFixture({ env });
	fixtures.push(fixture);
	const cookie = await fixture.login();
	const asking = Date.now();
	const response = await fixture.fetch('/api/board', { cookie });
	expect(response.status).toBe(200);
	expect(Date.now() - asking).toBeLessThan(3_000);
	expect(Date.now() - started).toBeLessThan(8_000);
	// Herdr is still being asked.
	expect(asked(dir)).toBe(true);
	expect(existsSync(pathLog)).toBe(false);
}, 20_000);
