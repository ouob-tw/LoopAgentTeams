// An HTTPS front for the browser tests of passkeys, which work only over HTTPS at the board's
// address: Chrome reaches the board at https://lat.ouob.net:<port> (resolved to 127.0.0.1 with
// --host-resolver-rules) through this TLS proxy, with a certificate made for the test that Chrome
// is told to accept (--ignore-certificate-errors).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The Chrome flags that send lat.ouob.net to this host and accept the test certificate. */
export const PROXY_CHROME_ARGS = ['--host-resolver-rules=MAP lat.ouob.net 127.0.0.1', '--ignore-certificate-errors'];

/** An HTTPS proxy for lat.ouob.net in front of the board, as the reverse proxy is: it ends TLS and
 *  tells the board, its trusted proxy, that the browser used HTTPS. It listens before the board
 *  starts, so the board's address can name its port; `target` is read at each request. */
export function httpsProxy(target: () => string) {
	const dir = mkdtempSync(join(tmpdir(), 'lat-board-tls-'));
	const [key, cert] = [join(dir, 'key.pem'), join(dir, 'cert.pem')];
	const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=lat.ouob.net', '-addext', 'subjectAltName=DNS:lat.ouob.net']);
	if (made.status !== 0) throw new Error(`openssl could not make the test certificate: ${made.stderr}`);
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		tls: { key: Bun.file(key), cert: Bun.file(cert) },
		// The board's event stream stays open.
		idleTimeout: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const headers = new Headers(request.headers);
			headers.set('x-forwarded-proto', 'https');
			headers.set('x-forwarded-for', '127.0.0.1');
			// Passed on as it comes: a body fetch unpacked must not keep its content-encoding.
			headers.set('accept-encoding', 'identity');
			// Read whole: passed on as a stream next to its own content-length, Node now and then
			// refused it with a bare 400.
			const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
			return fetch(`${target()}${url.pathname}${url.search}`, { method: request.method, headers, body, redirect: 'manual' });
		}
	});
	return {
		origin: `https://lat.ouob.net:${server.port}`,
		close() {
			server.stop(true);
			rmSync(dir, { recursive: true, force: true });
		}
	};
}
