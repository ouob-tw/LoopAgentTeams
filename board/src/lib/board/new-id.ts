// A random ID the page makes for itself. `crypto.randomUUID` exists only in a secure context (https
// or localhost), so on the board opened by plain http on a LAN address it is missing;
// `crypto.getRandomValues` works everywhere.

/** A random version 4 UUID, in or out of a secure context. */
export function newId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
