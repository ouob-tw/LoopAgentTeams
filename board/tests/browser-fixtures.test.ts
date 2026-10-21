// The test tools' own checks: fixtures and Chrome take ports the system picks, and a Chrome a
// failed test started does not outlive it.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { CHROME, launchChrome } from './browser.ts';
import { sleep, startFixture } from './harness.ts';

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

test('two fixtures started together get different ports and both answer', async () => {
	const [a, b] = await Promise.all([startFixture(), startFixture()]);
	try {
		expect(new URL(a.url).port).not.toBe(new URL(b.url).port);
		for (const fixture of [a, b]) expect((await fetch(`${fixture.url}/login`)).status).toBe(200);
	} finally {
		await Promise.all([a.cleanup(), b.cleanup()]);
	}
}, 60_000);

test('a fixture and a Chrome start while ports 7110–7201 are taken', async () => {
	const held: Server[] = [];
	for (let port = 7110; port <= 7201; port++) {
		const server = createServer();
		// A port somebody else already holds stays theirs.
		const bound = await new Promise<boolean>((resolve) => {
			server.once('error', () => resolve(false));
			server.listen(port, '127.0.0.1', () => resolve(true));
		});
		if (bound) held.push(server);
	}
	const fixture = await startFixture().catch(async (error) => (await closeAll(held), Promise.reject(error)));
	const browser = CHROME ? await launchChrome() : undefined;
	try {
		expect(held.length).toBeGreaterThan(0);
		expect(Number(new URL(fixture.url).port)).toBeGreaterThan(0);
		expect((await fetch(`${fixture.url}/login`)).status).toBe(200);
		if (browser) expect(await browser.tab.eval('1 + 1')).toBe(2);
	} finally {
		await browser?.close();
		await fixture.cleanup();
		await closeAll(held);
	}
}, 60_000);

const closeAll = (servers: Server[]) => Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));

test.skipIf(!CHROME)('a browser test whose beforeAll fails leaves no Chrome behind', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'lat-board-leak-'));
	const pidFile = join(dir, 'chrome.pid');
	try {
		const run = spawnSync(process.execPath, ['test', join(import.meta.dir, 'chrome-leak-case.ts')], {
			env: { ...process.env, LEAK_PID_FILE: pidFile },
			encoding: 'utf8'
		});
		expect(run.status).not.toBe(0);
		expect(existsSync(pidFile)).toBe(true);
		const pid = Number(readFileSync(pidFile, 'utf8'));
		// The kill has been sent by the time the run ends; the process table follows.
		const deadline = Date.now() + 5000;
		while (alive(pid) && Date.now() < deadline) await sleep(50);
		expect(alive(pid)).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 60_000);
