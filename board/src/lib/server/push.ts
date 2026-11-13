// Web Push to the devices that pressed 允許通知: the board's own VAPID key pair (RFC 8292) and one
// subscription per logged-in device, both kept in the board state directory's `push` folder, and
// each message encrypted for its subscription as RFC 8291 has it (aes128gcm), with node:crypto
// alone. A push goes only to a known push service, so a subscription cannot make the board call
// another address. A subscription the push service says is gone (404, 410), or whose device is no
// longer logged in, is removed; any other failure is logged and changes nothing else.
import { createECDH, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, sign, createCipheriv, type KeyObject } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AlertPush } from '../board/alerts.ts';
import { writeAtomic } from './automation.ts';
import { log } from './log.ts';

export interface StoredSubscription {
	deviceId: string;
	endpoint: string;
	keys: { p256dh: string; auth: string };
	createdAt: string;
}

/** The push services browsers use, by host name and the domains under it. */
export const PUSH_SERVICES = ['fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];

/** How long a push service keeps a message for a phone that is off. */
const TTL_SECONDS = 24 * 3600;
const SEND_TIMEOUT_MS = 10_000;
const MAX_ENDPOINT = 2048;
const RECORD_SIZE = 4096;

const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const fromB64u = (text: unknown): Buffer | null => (typeof text === 'string' && /^[A-Za-z0-9_-]+={0,2}$/.test(text) ? Buffer.from(text, 'base64url') : null);

export type Subscribed = { ok: true } | { ok: false; error: string };

export interface Push {
	/** The VAPID public key, base64url, as `applicationServerKey` wants it. */
	publicKey(): string;
	/** This device's subscription endpoint; null when it has none. */
	endpointOf(deviceId: string): string | null;
	/** Keep this device's subscription, in place of any it had. */
	subscribe(deviceId: string, input: unknown): Subscribed;
	unsubscribe(deviceId: string): boolean;
	/** Send to every subscription; resolves with how many push services took it. */
	send(message: AlertPush): Promise<number>;
}

/** Check a subscription as the page sends it (`PushSubscription.toJSON()`). */
export function checkSubscription(input: unknown, testOrigin: string | null = null): { endpoint: string; keys: { p256dh: string; auth: string } } | string {
	const body = (input && typeof input === 'object' ? input : {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
	if (typeof body.endpoint !== 'string' || body.endpoint.length > MAX_ENDPOINT) return '訂閱少了推播網址';
	let url: URL;
	try {
		url = new URL(body.endpoint);
	} catch {
		return '推播網址不是網址';
	}
	const known = url.protocol === 'https:' && !url.username && !url.password && PUSH_SERVICES.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
	if (!known && !(testOrigin !== null && url.origin === testOrigin)) return '推播網址不是瀏覽器的推播服務';
	const p256dh = fromB64u(body.keys?.p256dh);
	const auth = fromB64u(body.keys?.auth);
	if (!p256dh || p256dh.length !== 65 || p256dh[0] !== 4) return '訂閱的金鑰不對';
	if (!auth || auth.length !== 16) return '訂閱的金鑰不對';
	try {
		// A point that is not on the curve cannot be encrypted for.
		const probe = createECDH('prime256v1');
		probe.generateKeys();
		probe.computeSecret(p256dh);
	} catch {
		return '訂閱的金鑰不對';
	}
	return { endpoint: url.href, keys: { p256dh: b64u(p256dh), auth: b64u(auth) } };
}

/** The message body encrypted for one subscription (RFC 8291, one aes128gcm record). */
export function encryptPayload(payload: Buffer, keys: { p256dh: string; auth: string }): Buffer {
	const uaPublic = Buffer.from(keys.p256dh, 'base64url');
	const authSecret = Buffer.from(keys.auth, 'base64url');
	const local = createECDH('prime256v1');
	const asPublic = local.generateKeys();
	const shared = local.computeSecret(uaPublic);
	const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
	const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
	const salt = randomBytes(16);
	const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
	const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
	const cipher = createCipheriv('aes-128-gcm', cek, nonce);
	// The last (and only) record ends with the delimiter 0x02.
	const sealed = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
	const header = Buffer.alloc(21);
	salt.copy(header, 0);
	header.writeUInt32BE(RECORD_SIZE, 16);
	header.writeUInt8(asPublic.length, 20);
	return Buffer.concat([header, asPublic, sealed]);
}

/** The VAPID `Authorization` header for one push service: a JWT signed with the board's key. */
export function vapidHeader(endpoint: string, key: { privateKey: KeyObject; publicKey: string }, subject: string, now: number): string {
	const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
	const claims = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
	const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
	return `vapid t=${header}.${claims}.${b64u(signature)}, k=${key.publicKey}`;
}

/** The board's key pair, made on first use and kept so subscriptions stay good across restarts. */
function loadKeys(dir: string): { privateKey: KeyObject; publicKey: string } {
	const file = join(dir, 'vapid.json');
	try {
		const saved = JSON.parse(readFileSync(file, 'utf8'));
		const privateKey = createPrivateKey({ key: saved.privateKey, format: 'jwk' });
		return { privateKey, publicKey: rawPublic(createPublicKey(privateKey)) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`${file} cannot be read: ${(error as Error).message}`);
	}
	const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
	writeAtomic(file, JSON.stringify({ privateKey: pair.privateKey.export({ format: 'jwk' }) }, null, '\t') + '\n');
	return { privateKey: pair.privateKey, publicKey: rawPublic(pair.publicKey) };
}

function rawPublic(key: KeyObject): string {
	const jwk = key.export({ format: 'jwk' });
	return b64u(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]));
}

export function createPush(options: {
	/** The board state directory's `push` folder. */
	dir: string;
	now(): number;
	/** Who sends, as push services ask: the board's https address. */
	subject: string;
	/** Whether a device is still logged in: pushes go only to those. */
	deviceKnown(deviceId: string): boolean;
	/** An origin taken as a push service besides the real ones: the tests' fake service. */
	testOrigin?: string | null;
}): Push {
	mkdirSync(options.dir, { recursive: true, mode: 0o700 });
	const keys = loadKeys(options.dir);
	const file = join(options.dir, 'subscriptions.json');
	let subscriptions: StoredSubscription[];
	try {
		const value = JSON.parse(readFileSync(file, 'utf8'));
		subscriptions = Array.isArray(value) ? value : [];
	} catch {
		subscriptions = [];
	}
	const save = () => writeAtomic(file, JSON.stringify(subscriptions, null, '\t') + '\n');
	const drop = (gone: StoredSubscription[]) => {
		if (!gone.length) return;
		subscriptions = subscriptions.filter((entry) => !gone.includes(entry));
		save();
	};

	async function deliver(entry: StoredSubscription, body: Buffer, topic: string): Promise<'sent' | 'gone' | 'failed'> {
		const host = new URL(entry.endpoint).hostname;
		try {
			const response = await fetch(entry.endpoint, {
				method: 'POST',
				headers: {
					authorization: vapidHeader(entry.endpoint, keys, options.subject, options.now()),
					'content-encoding': 'aes128gcm',
					'content-type': 'application/octet-stream',
					ttl: String(TTL_SECONDS),
					urgency: 'high',
					topic
				},
				body: new Uint8Array(encryptPayload(body, entry.keys)),
				redirect: 'error',
				signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
			});
			await response.body?.cancel();
			if (response.ok) return 'sent';
			if (response.status === 404 || response.status === 410) {
				log('INFO', 'board.push', 'push_subscription_gone', { device_id: entry.deviceId, host, status: response.status });
				return 'gone';
			}
			log('WARNING', 'board.push', 'push_refused', { device_id: entry.deviceId, host, status: response.status });
		} catch (error) {
			log('WARNING', 'board.push', 'push_failed', { device_id: entry.deviceId, host, error: (error as Error).message });
		}
		return 'failed';
	}

	return {
		publicKey: () => keys.publicKey,
		endpointOf: (deviceId) => subscriptions.find((entry) => entry.deviceId === deviceId)?.endpoint ?? null,
		subscribe(deviceId, input) {
			const checked = checkSubscription(input, options.testOrigin ?? null);
			if (typeof checked === 'string') return { ok: false, error: checked };
			// One per device, and an endpoint belongs to one device only.
			subscriptions = subscriptions.filter((entry) => entry.deviceId !== deviceId && entry.endpoint !== checked.endpoint);
			subscriptions.push({ deviceId, ...checked, createdAt: new Date(options.now()).toISOString() });
			save();
			return { ok: true };
		},
		unsubscribe(deviceId) {
			const before = subscriptions.length;
			subscriptions = subscriptions.filter((entry) => entry.deviceId !== deviceId);
			if (subscriptions.length === before) return false;
			save();
			return true;
		},
		async send(message) {
			drop(subscriptions.filter((entry) => !options.deviceKnown(entry.deviceId)));
			const body = Buffer.from(JSON.stringify(message));
			// Topic: a later push for the same card replaces one the phone has not fetched yet.
			const topic = message.alert.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'alert';
			const targets = [...subscriptions];
			const results = await Promise.all(targets.map((entry) => deliver(entry, body, topic)));
			drop(targets.filter((_, index) => results[index] === 'gone'));
			return results.filter((result) => result === 'sent').length;
		}
	};
}
