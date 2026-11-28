// A browser's side of Web Push for the server tests: a device's push keys, and undoing the board's
// RFC 8291 encryption with them, as the browser does before it shows a notification.
import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto';

/** A device's push keys, as a browser keeps them. */
export function deviceKeys() {
	const ecdh = createECDH('prime256v1');
	const publicKey = ecdh.generateKeys();
	const auth = crypto.getRandomValues(new Uint8Array(16));
	return { ecdh, json: { p256dh: Buffer.from(publicKey).toString('base64url'), auth: Buffer.from(auth).toString('base64url') }, auth: Buffer.from(auth) };
}
export type DeviceKeys = ReturnType<typeof deviceKeys>;

/** What the browser does with a push: undo RFC 8291 with the device's private key. Throws when the
 *  record does not end with the last-record delimiter. */
export function decrypt(body: Buffer, keys: DeviceKeys): unknown {
	const salt = body.subarray(0, 16);
	const idLength = body[20];
	const asPublic = body.subarray(21, 21 + idLength);
	const sealed = body.subarray(21 + idLength);
	const shared = keys.ecdh.computeSecret(asPublic);
	const uaPublic = keys.ecdh.getPublicKey();
	const ikm = Buffer.from(hkdfSync('sha256', shared, keys.auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
	const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
	const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
	const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
	decipher.setAuthTag(sealed.subarray(sealed.length - 16));
	const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
	if (plain.at(-1) !== 2) throw new Error('the record does not end with the last-record delimiter');
	return JSON.parse(plain.subarray(0, -1).toString('utf8'));
}
