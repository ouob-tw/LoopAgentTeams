// A browser that goes away mid-read must end the helper reads it started (the conversation history,
// and the model switch's status) and everything they started, under
// Node and under Bun alike: Bun's HTTP server tells only the request, not the response, that the
// connection closed. The connection is dropped at the socket, as a closed tab or a navigation does.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { NODE, startFixture, until, type Fixture } from './harness.ts';

const runtimes = [
	{ name: 'Node', runtime: NODE },
	{ name: 'Bun', runtime: process.execPath }
];
const fixtures: Record<string, { fixture: Fixture; cookie: string; sessionId: string }> = {};

beforeAll(async () => {
	for (const { name, runtime } of runtimes) {
		// hcom is never run for real: a command that answers nothing stands in for it.
		const fixture = await startFixture({ runtime, env: { LAT_BOARD_HCOM_COMMAND: JSON.stringify(['true']) } });
		const cookie = await fixture.login();
		const controller = fixture.bound('alpha', 'luna', { client: 'codex' });
		fixture.setHelper({ output: { controllers: [controller] }, transcriptChildMs: 20_000, launchArgsChildMs: 20_000 });
		await fixture.refresh(cookie);
		fixtures[name] = { fixture, cookie, sessionId: controller.session_id };
	}
}, 30_000);
afterAll(async () => {
	for (const { fixture } of Object.values(fixtures)) await fixture.cleanup();
});

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** Send a request on a bare socket, so the test can drop the connection itself. */
function request(fixture: Fixture, cookie: string, path: string): Socket {
	const { hostname, port } = new URL(fixture.url);
	const socket = connect(Number(port), hostname);
	socket.on('error', () => {});
	socket.write(`GET ${path} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nCookie: ${cookie}\r\nAccept: */*\r\n\r\n`);
	return socket;
}

for (const { name } of runtimes) {
	for (const [what, path, helper] of [
		['the live feed', '/api/transcript/events', 'transcript'],
		['a page read', '/api/transcript', 'transcript'],
		['an earlier page read', '/api/transcript', 'transcript'],
		['the model switch status read', '/api/model', 'launch-args']
	] as const) {
		test(`${name}: dropping the connection during ${what} ends the helper and its child`, async () => {
			const { fixture, cookie, sessionId } = fixtures[name];
			const pidFile = join(fixture.dir, `${helper}-child.pid`);
			rmSync(pidFile, { force: true });
			const before = what === 'an earlier page read' ? '&before=10' : '';
			const socket = request(fixture, cookie, `${path}?controller=${encodeURIComponent(sessionId)}${before}`);
			const pid = Number(await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8'), 5_000, 'the helper child'));
			expect(alive(pid)).toBe(true);

			socket.destroy();

			await until(() => !alive(pid), 1_000, 'the helper child to exit');
		});
	}
}
