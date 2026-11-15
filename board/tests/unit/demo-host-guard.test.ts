// The connection guard decides which requests are to the demo address, before adapter-node serves
// its own files: the host is read as adapter-node reads it and compared as URLs write it, and only
// the guard's own mark tells SvelteKit.
import { afterEach, expect, test } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseAddressList } from '../../src/lib/server/client-address.ts';
import { guardConnection } from '../../src/lib/server/connection-guard.ts';

const settings = { allowedSources: parseAddressList('127.0.0.1', 'test'), trustedProxies: parseAddressList('', 'test'), demoHost: 'demo.example.test' };

function guarded(headers: Record<string, string>, url = '/_app/version.json') {
	const req = { url, headers: { ...headers }, method: 'GET', socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage;
	const set: Record<string, string> = {};
	const res = { setHeader: (name: string, value: string) => (set[name] = value) } as unknown as ServerResponse;
	expect(guardConnection(req, res, settings)).toBe(true);
	return { url: req.url, mark: req.headers['x-lat-demo-address'], set };
}

afterEach(() => {
	delete process.env.HOST_HEADER;
});

test('the demo host however written goes on under the demo prefix, marked, with the demo headers', () => {
	for (const host of ['demo.example.test', 'DEMO.example.test', 'demo.example.test:443', 'demo.example.test:0443']) {
		expect({ host, ...guarded({ host }) }).toMatchObject({ host, url: '/__demo-host/_app/version.json', mark: '1' });
	}
	expect(guarded({ host: 'demo.example.test' }).set['cache-control']).toBe('no-store');
});

test('another host, or another port, is the board: not rewritten, and a mark the client sent is removed', () => {
	for (const host of ['board.example.test', 'demo.example.test:8443', 'demo.example.test.evil', 'bad host']) {
		expect({ host, ...guarded({ host, 'x-lat-demo-address': '1' }) }).toMatchObject({ host, url: '/_app/version.json', mark: undefined });
	}
});

test('with HOST_HEADER the host comes from it, and from Host when it is not sent, as adapter-node does', () => {
	process.env.HOST_HEADER = 'X-Forwarded-Host';
	expect(guarded({ host: 'board.example.test', 'x-forwarded-host': 'demo.example.test' }).mark).toBe('1');
	expect(guarded({ host: 'demo.example.test' }).mark).toBe('1');
	expect(guarded({ host: 'demo.example.test', 'x-forwarded-host': 'board.example.test' }).mark).toBeUndefined();
});
