// Who a request comes from: the source list, the browser's address behind a trusted proxy (the
// rule in docs/adr/0013-board-trusted-proxy.md) and whether it came over HTTPS.
import { expect, test } from 'bun:test';
import { clientAddress, LOCAL_ONLY, parseAddressList, viaHttps } from '../../src/lib/server/client-address.ts';

const list = (text: string) => parseAddressList(text, 'TEST');
const proxy = list('192.168.31.48');

test('a list holds single addresses and CIDR ranges of both families, IPv4 seen through IPv6 included', () => {
	const allowed = list('127.0.0.0/8, ::1 192.168.31.48,fd00::/8');
	for (const address of ['127.0.0.1', '127.9.9.9', '::1', '192.168.31.48', '::ffff:192.168.31.48', 'fd12::3']) expect([address, allowed.has(address)]).toEqual([address, true]);
	for (const address of ['192.168.31.49', '10.0.0.1', '::2', 'fe80::1', '', 'not-an-address']) expect([address, allowed.has(address)]).toEqual([address, false]);
});

test('without a setting only the host itself is on the list', () => {
	const local = list(LOCAL_ONLY.join(','));
	expect(['127.0.0.1', '::1', '::ffff:127.0.0.1'].every((address) => local.has(address))).toBe(true);
	expect(['192.168.31.48', '10.0.0.5', '::ffff:192.168.31.48'].some((address) => local.has(address))).toBe(false);
	expect(list('').has('127.0.0.1')).toBe(false);
});

test('an entry that is not an address or a range stops the board from starting, naming the setting', () => {
	for (const entry of ['lat.ouob.net', '192.168.31.0/33', '::1/129', '10.0.0.0/8/1', '10.0.0.0/', '10.0.0.0/x', '300.1.1.1']) {
		expect(() => list(entry)).toThrow(`TEST: "${entry}" is not an IP address or CIDR range`);
	}
});

test('a connection that is not a trusted proxy is its own address, whatever X-Forwarded-For says', () => {
	expect(clientAddress('192.168.31.77', '203.0.113.7', proxy)).toBe('192.168.31.77');
	expect(clientAddress('::ffff:192.168.31.77', '203.0.113.7', proxy)).toBe('192.168.31.77');
	expect(clientAddress('127.0.0.1', '203.0.113.7', list(''))).toBe('127.0.0.1');
});

test('behind a trusted proxy the address is the first one from the right that is not a trusted proxy', () => {
	expect(clientAddress('192.168.31.48', '203.0.113.7', proxy)).toBe('203.0.113.7');
	expect(clientAddress('::ffff:192.168.31.48', '203.0.113.7', proxy)).toBe('203.0.113.7');
	// The browser put its own guess on the left; only what the trusted proxies added counts.
	const twoProxies = list('192.168.31.48, 10.0.0.0/8');
	expect(clientAddress('192.168.31.48', '1.2.3.4, 198.51.100.9, 10.1.2.3', twoProxies)).toBe('198.51.100.9');
	expect(clientAddress('192.168.31.48', '1.2.3.4,198.51.100.9,10.1.2.3,192.168.31.48', twoProxies)).toBe('198.51.100.9');
	expect(clientAddress('192.168.31.48', '2001:db8::5', proxy)).toBe('2001:db8::5');
	// Every hop a trusted proxy: the farthest one from the board.
	expect(clientAddress('192.168.31.48', '10.0.0.9, 10.0.0.8', twoProxies)).toBe('10.0.0.9');
	// No header: the proxy's own address.
	expect(clientAddress('192.168.31.48', null, proxy)).toBe('192.168.31.48');
});

test("a malformed entry anywhere makes the whole header untrusted: the connection's own address counts", () => {
	for (const header of ['garbage, 203.0.113.7', '203.0.113.7, ', '203.0.113.7:443', 'unknown', ', 203.0.113.7', '203.0.113.7 198.51.100.9']) {
		expect([header, clientAddress('192.168.31.48', header, proxy)]).toEqual([header, '192.168.31.48']);
	}
});

test('only a trusted proxy can say the browser used HTTPS', () => {
	expect(viaHttps('192.168.31.48', 'https', proxy)).toBe(true);
	expect(viaHttps('::ffff:192.168.31.48', 'HTTPS', proxy)).toBe(true);
	expect(viaHttps('192.168.31.48', 'http', proxy)).toBe(false);
	expect(viaHttps('192.168.31.48', null, proxy)).toBe(false);
	expect(viaHttps('192.168.31.77', 'https', proxy)).toBe(false);
	expect(viaHttps('127.0.0.1', 'https', list(''))).toBe(false);
});
