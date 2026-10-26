// Run by browser-launch.test.ts inside a private session bus whose Secret Service never answers, not by
// `bun test` itself: a Chrome started without `--password-store=basic` cannot answer its first cookie
// request (or, in some versions, even to start) until that service does; one started by `launchChrome` answers at once.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { CHROME, CHROME_FLAGS, launchChrome, Tab } from '../browser.ts';

const COOKIE = { name: 'lat_board_device', value: 'case', url: 'http://127.0.0.1:9/' };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('launchChrome answers the first cookie request without the secret service', async () => {
	const browser = await launchChrome();
	try {
		await browser.tab.send('Network.setCookie', COOKIE, 3_000);
	} finally {
		await browser.close();
	}
}, 20_000);

test('without --password-store=basic Chrome waits on the secret service, at start or at the first cookie request', async () => {
	const profile = mkdtempSync(join(tmpdir(), 'lat-board-test-chrome-case-'));
	const flags = CHROME_FLAGS.filter((flag) => !flag.startsWith('--password-store') && flag !== '--use-mock-keychain');
	const chrome = spawn(CHROME, [...flags, `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore', detached: true });
	try {
		const file = join(profile, 'DevToolsActivePort');
		const deadline = Date.now() + 10_000;
		let port = 0;
		while (!port && Date.now() < deadline) {
			if (existsSync(file)) {
				const [first, rest] = readFileSync(file, 'utf8').split('\n');
				if (rest !== undefined && Number(first) > 0) port = Number(first);
			}
			if (!port) await sleep(50);
		}
		if (!port) {
			// Some Chrome versions wait on the service before they publish a debugging port; a Chrome that
			// crashed would not be waiting.
			expect(chrome.exitCode).toBeNull();
			return;
		}
		const tab = await Tab.open(port);
		const outcome = await tab.send('Network.setCookie', COOKIE, 3_000).then(() => 'answered', (error: Error) => error.message);
		expect(outcome).toContain('no answer from Chrome in 3000 ms to Network.setCookie');
		// Only the cookie store waits: the page itself answers.
		expect(await tab.eval('1 + 1')).toBe(2);
		tab.close();
	} finally {
		process.kill(-chrome.pid!, 'SIGKILL');
		rmSync(profile, { recursive: true, force: true });
	}
}, 20_000);
