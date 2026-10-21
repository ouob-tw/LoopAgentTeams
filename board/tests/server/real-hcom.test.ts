// The board against the real `hcom term inject`, with a stand-in for the client's terminal: a
// private hcom directory whose one agent's input port is a listener in this test. It keeps
// the fake input command honest about how the real one reads its arguments. Skipped where
// `hcom` is not installed. Nothing here touches the real hcom data or a real client.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture, until, type Fixture } from '../harness.ts';

const installed = Bun.which('hcom') !== null;

/** What the stand-in terminal received: the text in its input box at each submit. */
const submitted: string[] = [];
let inputBox = '';
let terminal: { port: number; stop(closeActive?: boolean): void } | undefined;
let hcomDir = '';
let fixture: Fixture;
let cookie: string;

beforeAll(async () => {
	if (!installed) return;
	hcomDir = mkdtempSync(join(tmpdir(), 'lat-board-hcom-'));
	mkdirSync(join(hcomDir, 'home'));
	// Any command makes hcom create its database; then register the one agent and its input port.
	spawnSync('hcom', ['list'], { env: { ...process.env, HCOM_DIR: hcomDir }, encoding: 'utf8' });
	terminal = Bun.listen({
		hostname: '127.0.0.1',
		port: 0,
		socket: {
			data(socket, data) {
				const received = Buffer.from(data).toString('utf8');
				if (received === '\0SCREEN\n') {
					socket.write(JSON.stringify({ input_text: inputBox }));
					socket.end();
				} else if (received === '\r') {
					submitted.push(inputBox);
					inputBox = '';
				} else {
					inputBox += received;
				}
			}
		}
	});
	const db = new Database(join(hcomDir, 'hcom.db'));
	db.run("INSERT INTO instances (name, created_at, status) VALUES ('luna', ?, 'active')", [Date.now() / 1000]);
	db.run("INSERT INTO notify_endpoints (instance, kind, port, updated_at) VALUES ('luna', 'inject', ?, ?)", [terminal.port, Date.now() / 1000]);
	db.close();
	fixture = await startFixture({
		env: { HCOM_DIR: hcomDir, LAT_BOARD_INJECT_COMMAND: JSON.stringify(['hcom', 'term', 'inject']), LAT_BOARD_INJECT_TIMEOUT_SECONDS: '10' }
	});
	cookie = await fixture.login();
});
afterAll(async () => {
	terminal?.stop(true);
	await fixture?.cleanup();
	if (hcomDir) rmSync(hcomDir, { recursive: true, force: true });
});

const texts = ['hello', 'line one\nline two', '--help', '-h', '--enter', '--go', '--name', '-x', '--', '--a\n--b', '--help\nsecond line'];
for (const text of texts) {
	test.skipIf(!installed)(`real hcom: ${JSON.stringify(text)} reaches the input box unchanged, submitted once`, async () => {
		const luna = fixture.bound('alpha', 'luna');
		fixture.list([luna]);
		submitted.length = 0;
		inputBox = '';

		const response = await fixture.fetch('/api/messages', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ controllerId: luna.session_id, text }),
			cookie
		});

		expect(await response.json()).toMatchObject({ ok: true, reason: null });
		// hcom sends the submit on a connection of its own just before it exits, so the board can
		// answer before this process has read it; a late one would land in the next text's test.
		await until(() => submitted.length > 0, 5_000, 'the submit');
		expect(submitted).toEqual([text]);
	}, 20_000);
}
