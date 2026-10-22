// Attachments through the board server: an upload is reserved, arrives in pieces in order, and is
// read back behind the login, only from the upload directory and only once complete.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFixture, type Fixture } from '../harness.ts';

const CHUNK = 256 * 1024;

let fixture: Fixture;
let cookie: string;
let uploads: string;

beforeAll(async () => {
	fixture = await startFixture({ env: { LAT_BOARD_UPLOAD_MAX_MB: '1' } });
	cookie = await fixture.login();
	uploads = join(fixture.dir, 'uploads');
});

afterAll(async () => {
	await fixture.cleanup();
});

const start = (name: string, size: number, useCookie = cookie) =>
	fixture.fetch('/api/uploads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, size }), cookie: useCookie });
const put = (id: string, offset: number, bytes: Uint8Array) =>
	fixture.fetch(`/api/uploads/${id}?offset=${offset}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: bytes.slice(), cookie });
const read = (path: string, headers: Record<string, string> = {}) => fixture.fetch(`/api/uploads/file?path=${encodeURIComponent(path)}`, { headers, cookie });

async function upload(name: string, bytes: Uint8Array): Promise<string> {
	const started = await start(name, bytes.length);
	expect(started.status).toBe(200);
	const { id, path } = await started.json();
	for (let offset = 0; offset < bytes.length; offset += CHUNK) {
		const response = await put(id, offset, bytes.subarray(offset, offset + CHUNK));
		expect(response.status).toBe(200);
	}
	return path;
}

test('nothing is uploaded or read back without logging in', async () => {
	expect((await start('a.png', 10, '')).status).toBe(401);
	expect((await fixture.fetch('/api/uploads/file?path=/etc/passwd')).status).toBe(401);
});

test('a file arrives in pieces and reads back the same, kept only for the board account', async () => {
	const bytes = new Uint8Array(randomBytes(CHUNK * 2 + 1234));
	const path = await upload('螢幕 截圖.png', bytes);
	expect(path.startsWith(`${uploads}/`)).toBe(true);
	expect(path).toMatch(/\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{16}-螢幕_截圖\.png$/);
	expect(new Uint8Array(readFileSync(path))).toEqual(bytes);
	expect(statSync(uploads).mode & 0o777).toBe(0o700);
	expect(statSync(path).mode & 0o777).toBe(0o600);

	const response = await read(path);
	expect(response.status).toBe(200);
	expect(response.headers.get('content-type')).toBe('image/png');
	expect(response.headers.get('content-security-policy')).toBe('sandbox');
	expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
});

test('a video is read in byte ranges, for seeking', async () => {
	const bytes = new Uint8Array(randomBytes(5000));
	const path = await upload('clip.mp4', bytes);
	const part = await read(path, { range: 'bytes=100-199' });
	expect(part.status).toBe(206);
	expect(part.headers.get('content-type')).toBe('video/mp4');
	expect(part.headers.get('content-range')).toBe('bytes 100-199/5000');
	expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.subarray(100, 200));
	const tail = await read(path, { range: 'bytes=-10' });
	expect(new Uint8Array(await tail.arrayBuffer())).toEqual(bytes.subarray(4990));
	expect((await read(path, { range: 'bytes=6000-' })).status).toBe(416);
});

test('a completed file whose own name ends in .part is served like any other', async () => {
	const path = await upload('archive.part', new TextEncoder().encode('abc'));
	const response = await read(path);
	expect(response.status).toBe(200);
	expect(await response.text()).toBe('abc');
});

test('any other file downloads instead of opening in the page', async () => {
	const path = await upload('page.html', new TextEncoder().encode('<script>alert(1)</script>'));
	const response = await read(path);
	expect(response.headers.get('content-type')).toBe('application/octet-stream');
	expect(response.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''" + encodeURIComponent(path.split('/').pop()!));
});

test('pieces must come in order, fit the piece size and stop at the announced size', async () => {
	const started = await start('order.bin', 300);
	const { id, path } = await started.json();
	expect((await put(id, 10, new Uint8Array(10))).status).toBe(409);
	expect((await put(id, 0, new Uint8Array(301))).status).toBe(409);
	expect((await put(id, 0, new Uint8Array(200))).status).toBe(200);
	// Not complete yet: not served, under its own name or its partial one.
	expect((await read(path)).status).toBe(404);
	const hidden = path.replace(/\/([^/]+)$/, '/.$1');
	expect((await read(hidden)).status).toBe(404);
	expect((await put(id, 0, new Uint8Array(100))).status).toBe(409);
	const last = await put(id, 200, new Uint8Array(100));
	expect(await last.json()).toEqual({ received: 300, done: true });
	expect((await read(path)).status).toBe(200);
	// Done: no more pieces.
	expect((await put(id, 300, new Uint8Array(1))).status).toBe(404);
	expect((await put('nope', 0, new Uint8Array(1))).status).toBe(404);
});

test('a file over the limit is refused before anything is written', async () => {
	const response = await start('big.mp4', 1024 * 1024 + 1);
	expect(response.status).toBe(413);
	expect((await response.json()).reason).toContain('1MB');
	expect((await start('ok.mp4', 1024 * 1024)).status).toBe(200);
	expect((await start('bad', -1)).status).toBe(400);
	expect((await start('', 1)).status).toBe(400);
});

test('only files under the upload directory are read back', async () => {
	const outside = join(fixture.dir, 'secret.png');
	writeFileSync(outside, 'secret');
	expect((await read(outside)).status).toBe(404);
	expect((await read(`${uploads}/../secret.png`)).status).toBe(404);
	// A link inside that leads out is not followed.
	const day = join(uploads, 'links');
	mkdirSync(day, { recursive: true });
	symlinkSync(outside, join(day, 'link.png'));
	expect((await read(join(day, 'link.png'))).status).toBe(404);
	expect((await read(join(uploads, 'missing.png'))).status).toBe(404);
});

test('an upload directory that is a link is refused, not used', async () => {
	const other = join(fixture.dir, 'elsewhere');
	mkdirSync(other);
	const linked = join(fixture.dir, 'uploads-moved');
	// Swap the real directory for a link to another one.
	rmSync(linked, { recursive: true, force: true });
	renameSync(uploads, linked);
	symlinkSync(other, uploads);
	try {
		const response = await start('a.png', 1);
		expect(response.status).toBe(500);
		expect((await response.json()).reason).toContain('不是資料夾');
	} finally {
		rmSync(uploads);
		renameSync(linked, uploads);
	}
});
