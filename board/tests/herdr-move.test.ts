// Moving a resumed controller's tab to the front over Herdr's socket, against a fake socket.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BoardConfig } from '../src/lib/server/config.ts';
import { tabToFront } from '../src/lib/server/herdr.ts';
import { NODE } from './harness.ts';

const dir = mkdtempSync(join(tmpdir(), 'lat-board-herdr-move-'));
const socketPath = join(dir, 'herdr.sock');
const fakeCli = join(dir, 'herdr.mjs');
writeFileSync(
	fakeCli,
	`process.stdout.write(JSON.stringify({ result: { panes: [{ pane_id: 'wA:p1', tab_id: 'wA:t3' }] } }));`
);
let server: Server | undefined;
afterEach(() => {
	server?.close();
	server = undefined;
	rmSync(socketPath, { force: true });
});

const config = { herdrCommand: [NODE, fakeCli], herdrTimeoutMs: 1_000, herdrSocket: socketPath } as BoardConfig;

/** A socket that answers each request line with `reply(request)`; null sends nothing. */
async function fakeSocket(reply: (request: { id: string; method: string; params: object }) => string | null) {
	const requests: { method: string; params: object }[] = [];
	server = createServer((socket) => {
		socket.on('data', (chunk) => {
			const request = JSON.parse(chunk.toString().trim());
			requests.push({ method: request.method, params: request.params });
			const answer = reply(request);
			if (answer !== null) socket.write(answer);
		});
	});
	await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
	return requests;
}

test('the pane’s tab is moved to index 0, skipping lines that answer something else', async () => {
	const requests = await fakeSocket(
		(request) => `{"event":"tab.moved"}\n{"id":"other","result":{}}\n${JSON.stringify({ id: request.id, result: { type: 'tab_moved' } })}\n`
	);
	expect(await tabToFront(config, 'wA:p1')).toBeNull();
	expect(requests).toEqual([{ method: 'tab.move', params: { tab_id: 'wA:t3', insert_index: 0 } }]);
});

test('an error answer, a missing pane, no socket and a silent socket are reported, never thrown', async () => {
	await fakeSocket((request) => JSON.stringify({ id: request.id, error: { message: 'insert_index 0 is out of bounds' } }) + '\n');
	expect(await tabToFront(config, 'wA:p1')).toBe('移動分頁失敗：insert_index 0 is out of bounds');
	expect(await tabToFront(config, 'wA:gone')).toBe('找不到窗格所在的分頁');
	server!.close();
	rmSync(socketPath, { force: true });
	expect(await tabToFront(config, 'wA:p1')).toStartWith('移動分頁失敗：');
	await fakeSocket(() => null);
	expect(await tabToFront(config, 'wA:p1')).toBe('移動分頁失敗：逾時沒有回應');
});
