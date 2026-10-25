// `bun run demo` against a port the system picks: the real build on made-up data with the given
// stylesheet applied, and its folder gone after SIGTERM. Never uses the live board's port 7100.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PASSWORD } from '../harness.ts';

const SCRIPT = join(import.meta.dir, '../../scripts/demo-board.ts');
const CSS = ':root { --accent: #ff00aa; }';
let dir: string;
let child: ChildProcess;
let url: string;
let output = '';

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'lat-board-demo-run-'));
	writeFileSync(join(dir, 'proposed.css'), CSS);
	child = spawn('bun', [SCRIPT, '--css', join(dir, 'proposed.css'), '--port', '0', '--host', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] });
	child.stdout!.on('data', (chunk) => (output += chunk));
	child.stderr!.on('data', (chunk) => (output += chunk));
	const deadline = Date.now() + 40_000;
	while (!output.includes('DEMO READY') && Date.now() < deadline && child.exitCode === null) await Bun.sleep(100);
	const port = /Listening on http:\/\/[^\s:]+:(\d+)/.exec(output)?.[1];
	if (!port || !output.includes('DEMO READY')) {
		child.kill('SIGTERM');
		throw new Error(`demo did not start:\n${output}`);
	}
	url = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
	if (child.exitCode === null) {
		// Let the demo clean up after itself; kill it only when it does not.
		const exited = new Promise((resolve) => child.once('exit', resolve));
		child.kill('SIGTERM');
		if (await Promise.race([exited, Bun.sleep(10_000).then(() => 'late')]) === 'late') child.kill('SIGKILL');
	}
	rmSync(dir, { recursive: true, force: true });
});

async function login(): Promise<{ response: Response; cookie: string }> {
	const response = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
	return { response, cookie: response.headers.getSetCookie()[0]?.split(';')[0] ?? '' };
}

test('serves the given stylesheet and the made-up board behind the printed password', async () => {
	expect(output).toContain(PASSWORD);
	const { response, cookie } = await login();
	expect(response.status).toBe(200);
	// A cookie without Domain belongs to the host name it was set on, so another host name keeps its own login.
	expect(response.headers.getSetCookie()[0]).not.toMatch(/domain=/i);
	expect(await (await fetch(`${url}/user.css`, { headers: { cookie } })).text()).toBe(CSS);
	expect(await (await fetch(`${url}/`, { headers: { cookie } })).text()).toContain('href="/user.css"');
	const board = await (await fetch(`${url}/api/board`, { headers: { cookie } })).json() as { controllers: { hcomName: string }[] };
	expect(board.controllers.map((c) => c.hcomName).sort()).toEqual(['luna', 'rana']);
	// The seeded board ask reached the board's folder: the hook did not take s-ask for a controller.
	const folder = /\/[^"]*?lat-board-test-\w+/.exec(JSON.stringify(board))![0];
	const asks = readdirSync(join(folder, 'board-asks'));
	expect(asks.some((name) => name.endsWith('.json') && name !== 'heartbeat.json')).toBe(true);
});

test('the demo logs in under a cookie name of its own, and the live board\'s cookie name gets nothing', async () => {
	const { cookie } = await login();
	expect(cookie.startsWith('lat_board_demo=')).toBe(true);
	expect((await fetch(`${url}/api/board`, { headers: { cookie } })).status).toBe(200);
	const asLive = cookie.replace('lat_board_demo=', 'lat_board_device=');
	expect((await fetch(`${url}/api/board`, { headers: { cookie: asLive } })).status).toBe(401);
});

test('SIGTERM stops the server and deletes its temporary folder', async () => {
	const { cookie } = await login();
	// The made-up workspaces live in the fixture's folder.
	const folder = /\/[^"]*?lat-board-test-\w+/.exec(await (await fetch(`${url}/api/board`, { headers: { cookie } })).text())?.[0];
	expect(folder).toBeDefined();
	expect(existsSync(folder!)).toBe(true);
	const exited = new Promise((resolve) => child.once('exit', resolve));
	child.kill('SIGTERM');
	await exited;
	expect(existsSync(folder!)).toBe(false);
	await expect(fetch(`${url}/login`)).rejects.toThrow();
});
