// Who is on the other end of a request: whether the connection may reach the board at all, the
// browser's own address behind a trusted proxy, and whether the browser used HTTPS.
// The rule is docs/adr/0013-board-trusted-proxy.md: forwarded headers count only when the
// connection itself comes from a trusted proxy.
import { BlockList, isIP } from 'node:net';

/** Addresses given as single IPs or CIDR ranges, IPv4 or IPv6. */
export interface AddressList {
	/** The entries as given, for messages. */
	entries: string[];
	has(address: string): boolean;
}

/** Without a setting only the host itself may connect. */
export const LOCAL_ONLY = ['127.0.0.0/8', '::1'];

/** Who may connect, and which proxies are believed: `LAT_BOARD_ALLOWED_SOURCES` (only the host
 *  itself when not set) and `LAT_BOARD_TRUSTED_PROXIES` (none when not set). */
export function connectionSettings(env: Record<string, string | undefined>): { allowedSources: AddressList; trustedProxies: AddressList } {
	return {
		allowedSources: parseAddressList(env.LAT_BOARD_ALLOWED_SOURCES?.trim() || LOCAL_ONLY.join(','), 'LAT_BOARD_ALLOWED_SOURCES'),
		trustedProxies: parseAddressList(env.LAT_BOARD_TRUSTED_PROXIES ?? '', 'LAT_BOARD_TRUSTED_PROXIES')
	};
}

/** An IPv4 address a dual-stack socket reports as `::ffff:a.b.c.d` is that IPv4 address. */
export function plainAddress(address: string): string {
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
	return mapped ? mapped[1] : address;
}

/** Parse a comma- or space-separated list; throws on an entry that is not an IP or a CIDR range. */
export function parseAddressList(text: string, name: string): AddressList {
	const entries = text.split(/[\s,]+/).filter(Boolean);
	const list = new BlockList();
	for (const entry of entries) {
		const [address, prefix, ...rest] = entry.split('/');
		const family = isIP(address);
		const bits = family === 4 ? 32 : 128;
		const length = prefix === undefined ? bits : /^\d+$/.test(prefix) ? Number(prefix) : NaN;
		if (!family || rest.length || !(length >= 0 && length <= bits)) throw new Error(`${name}: "${entry}" is not an IP address or CIDR range`);
		list.addSubnet(address, length, family === 4 ? 'ipv4' : 'ipv6');
	}
	return {
		entries,
		has(candidate) {
			const address = plainAddress(candidate);
			const family = isIP(address);
			return family !== 0 && list.check(address, family === 4 ? 'ipv4' : 'ipv6');
		}
	};
}

/**
 * The browser's address. A connection from a trusted proxy is read from `X-Forwarded-For`, right
 * to left, up to the first address that is not a trusted proxy; an entry that is not an IP address
 * makes the whole header untrusted and the connection's own address counts. `X-Real-IP` and
 * `CF-Connecting-IP` are never read.
 */
export function clientAddress(peer: string, forwardedFor: string | null, trusted: AddressList): string {
	const own = plainAddress(peer);
	if (!forwardedFor || !trusted.has(own)) return own;
	const hops = forwardedFor.split(',').map((hop) => plainAddress(hop.trim()));
	if (hops.some((hop) => !isIP(hop))) return own;
	for (let i = hops.length - 1; i >= 0; i--) if (!trusted.has(hops[i])) return hops[i];
	// Every hop is a trusted proxy: the one farthest from the board is the closest to the browser.
	return hops[0];
}

/** Whether the browser used HTTPS: the board has none of its own, so only a trusted proxy can say so. */
export function viaHttps(peer: string, forwardedProto: string | null, trusted: AddressList): boolean {
	return trusted.has(peer) && forwardedProto?.trim().toLowerCase() === 'https';
}
