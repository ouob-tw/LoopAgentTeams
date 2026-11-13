// The push module on its own: with no https address of the board, or a key file that cannot be
// read, pushes are off with a reason and nothing else breaks; an address saved earlier that is no
// longer taken is dropped before a send, so the board never calls it.
import { createECDH } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { createPush } from '../../src/lib/server/push.ts';

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function folder(): string {
	const dir = mkdtempSync(join(tmpdir(), 'lat-push-'));
	dirs.push(dir);
	return join(dir, 'push');
}
const keys = { p256dh: Buffer.from(createECDH('prime256v1').generateKeys()).toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') };
const options = (dir: string, subject: string | null = 'https://board.example.test') => ({ dir, now: () => Date.now(), subject, deviceKnown: () => true });
const message = { title: '任務', body: '這次執行失敗', alert: 'a1' };

test('with no https address of the board, pushes are off and say why', async () => {
	const push = createPush(options(folder(), null));
	expect(push.publicKey()).toBeNull();
	expect(push.problem()).toContain('LAT_BOARD_URL');
	expect(push.subscribe('d1', { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys })).toEqual({ ok: false, error: push.problem()! });
	expect(await push.send(message)).toBe(0);
});

test('a key file that cannot be read turns pushes off, is left as it is, and does not throw', async () => {
	const dir = folder();
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'vapid.json'), '{ torn');
	const push = createPush(options(dir));
	expect(push.publicKey()).toBeNull();
	expect(push.problem()).toContain('金鑰');
	expect(await push.send(message)).toBe(0);
	expect(readFileSync(join(dir, 'vapid.json'), 'utf8')).toBe('{ torn');
});

test('an address saved earlier that is no longer taken is dropped before a send, never called', async () => {
	let called = 0;
	const service = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => (called++, new Response(null, { status: 201 })) });
	try {
		const origin = `http://127.0.0.1:${service.port}`;
		const dir = folder();
		const before = createPush({ ...options(dir), testOrigin: origin });
		expect(before.subscribe('d1', { endpoint: `${origin}/push/1`, keys })).toEqual({ ok: true });
		expect(await before.send(message)).toBe(1);
		// The board started again without the test origin.
		const after = createPush(options(dir));
		expect(await after.send(message)).toBe(0);
		expect(called).toBe(1);
		expect(after.endpointOf('d1')).toBeNull();
	} finally {
		service.stop(true);
	}
});
