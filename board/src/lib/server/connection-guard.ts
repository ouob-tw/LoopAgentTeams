// The built server's first step for every request, before adapter-node serves a built file or
// SvelteKit runs: refuse a connection that is not on the source list, and give every answer the
// security headers, the built files and SvelteKit's own error pages included.
// instrumentation.server.ts installs it; hooks.server.ts does the same for what SvelteKit answers.
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { viaHttps, type AddressList } from './client-address.ts';
import { log } from './log.ts';
import { DEMO_HOST_PREFIX } from './demo-address.ts';
import { isDemoPath, securityHeaders } from './security-headers.ts';

export interface ConnectionSettings {
	allowedSources: AddressList;
	trustedProxies: AddressList;
	/** The demo address's host (demo-address.ts); null when there is none. */
	demoHost: string | null;
}

/** The host the request names, read from the header adapter-node reads it from (`HOST_HEADER`). */
function hostOf(req: IncomingMessage): string {
	return headerText(req.headers[(process.env.HOST_HEADER || 'host').toLowerCase()])?.toLowerCase() ?? '';
}

const headerText = (value: string | string[] | undefined) => (Array.isArray(value) ? value.join(', ') : (value ?? null));

/** Whether the request may go on. The security headers are set either way; a header the answer
 *  sets itself later replaces the one set here. */
export function guardConnection(req: IncomingMessage, res: ServerResponse, settings: ConnectionSettings): boolean {
	const peer = req.socket.remoteAddress ?? '';
	const https = viaHttps(peer, headerText(req.headers['x-forwarded-proto']), settings.trustedProxies);
	const demoHost = settings.demoHost !== null && hostOf(req) === settings.demoHost;
	const demo = demoHost ? 'site' : isDemoPath((req.url ?? '').split('?')[0]) ? 'sandbox' : null;
	for (const [name, value] of securityHeaders(https, null, demo)) res.setHeader(name, value);
	if (settings.allowedSources.has(peer)) {
		if (demoHost) req.url = DEMO_HOST_PREFIX + (req.url ?? '/');
		return true;
	}
	log('WARNING', 'board.http', 'source_refused', { method: req.method, path: (req.url ?? '').split('?')[0], peer });
	res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
	res.end('Forbidden');
	return false;
}

/** Make every HTTP server this process creates from now on guard its requests first. It must run
 *  before the server is created: adapter-node creates its own and hands no way in. */
export function guardServers(settings: ConnectionSettings): void {
	const create = http.createServer;
	http.createServer = ((...args: Parameters<typeof http.createServer>) => {
		const server = create(...args);
		const emit = server.emit;
		server.emit = function (this: http.Server, event: string | symbol, ...rest: unknown[]) {
			if (event === 'request' && !guardConnection(rest[0] as IncomingMessage, rest[1] as ServerResponse, settings)) return true;
			return Reflect.apply(emit, this, [event, ...rest]);
		} as typeof server.emit;
		return server;
	}) as typeof http.createServer;
}
