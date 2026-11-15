// The demo pages' own address, read by the board's settings and by the connection guard, which
// runs before the rest of the server is loaded. No other imports.

export interface DemoSite {
	/** Such as `https://demo.example.net`; always https. */
	origin: string;
	/** The host name and port requests to it name, as `URL.host` writes it. */
	host: string;
}

/** `LAT_BOARD_DEMO_URL`, the https address the proxy sends to the board for demo pages; config.ts
 *  checks it against the board's own address. */
export function demoAddress(env: Record<string, string | undefined>): DemoSite | null {
	const given = env.LAT_BOARD_DEMO_URL?.trim();
	if (!given) return null;
	let url: URL;
	try {
		url = new URL(given);
	} catch {
		throw new Error(`LAT_BOARD_DEMO_URL: "${given}" is not an address`);
	}
	if (url.protocol !== 'https:') throw new Error(`LAT_BOARD_DEMO_URL: "${given}" is not an https address`);
	return { origin: url.origin, host: url.host };
}

/** A Host header as `URL.host` writes it, the way adapter-node builds the request's address (https
 *  unless told otherwise): lower case, without the default port. Null when it is no host. */
export function normalHost(header: string): string | null {
	try {
		return new URL(`https://${header}`).host;
	} catch {
		return null;
	}
}

/** A request to the demo address goes on under this path, so adapter-node's own files (the board's
 *  scripts, icons, service worker) are never found for it and every one reaches hooks.server.ts. */
export const DEMO_HOST_PREFIX = '/__demo-host';
/** The connection guard's word that a request is to the demo address: the one place that decides,
 *  so the static files and SvelteKit never disagree. The guard removes any such header a client sent. */
export const DEMO_MARK = 'x-lat-demo-address';
