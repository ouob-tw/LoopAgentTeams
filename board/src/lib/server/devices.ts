// Logged-in devices, kept as a file in the board's state directory.
// The host command and the server both use this, so every change takes the directory lock.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Device {
	id: string;
	label: string;
	/** When the device logged in; devices from before password login keep their pairing time. */
	pairedAt: string;
	/** When the device last made a logged-in request; its login time before the first. */
	lastSeenAt: string;
	/** A test login's terms; null for a device logged in with the password. */
	test: TestTerms | null;
}

/** A time-limited test login (`board test-login`): it reads everything and acts only on the
 *  agents it started itself, `owned` by their session IDs. */
export interface TestTerms {
	label: string;
	expiresAt: string;
	/** Session IDs of the agents and controllers this device started from the board. */
	owned: string[];
}

interface StoredDevice {
	id: string;
	label: string;
	pairedAt: string;
	lastSeenAt?: string;
	/** Empty while a test login's one-time code has not been used. */
	tokenHash: string;
	test?: TestTerms & {
		/** The one-time code's hash, until it is used. */
		codeHash?: string;
	};
}

/** How long a test login lasts by default, and at most. */
export const TEST_LOGIN_DEFAULT_HOURS = 4;
export const TEST_LOGIN_MAX_HOURS = 24;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A password login lasts this long from when it was made... */
export const LOGIN_DAYS = 30;
/** ...and ends sooner when the device makes no logged-in request for this long. */
export const IDLE_DAYS = 7;
/** The server knows each device's last request exactly; the file has it to within this much, one
 *  write a minute per device at most. Only a restart can lose that minute. */
const SEEN_EVERY_MS = 60 * 1000;
/** The last request of each device this process has seen, and when it last wrote one to the file. */
const seen = new Map<string, number>();
const written = new Map<string, number>();

export const DEVICES_FILE = 'devices.json';
const STALE_LOCK_MS = 5_000;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function readJson<T>(path: string): T[] {
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
	const parsed: unknown = JSON.parse(text);
	if (!Array.isArray(parsed)) throw new Error(`${path} is not a list`);
	return parsed;
}

function writeJson(path: string, value: unknown): void {
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
	renameSync(temporary, path);
}

function withLock<T>(stateDir: string, action: () => T): T {
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const lock = join(stateDir, 'lock');
	for (;;) {
		try {
			mkdirSync(lock);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			try {
				// A holder that died leaves the lock behind; every holder finishes in milliseconds.
				if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmdirSync(lock);
			} catch {
				// The holder released it between the two calls.
			}
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
		}
	}
	try {
		return action();
	} finally {
		rmdirSync(lock);
	}
}

/** Register a device that has just logged in and return the token its cookie carries. */
export function registerDevice(stateDir: string, label: string, now: number = Date.now()): { token: string; device: Device } {
	return withLock(stateDir, () => {
		const path = join(stateDir, DEVICES_FILE);
		const devices = readJson<StoredDevice>(path);
		const token = randomBytes(32).toString('base64url');
		const at = new Date(now).toISOString();
		const device: Device = {
			id: randomBytes(4).toString('hex'),
			label: label.slice(0, 200),
			pairedAt: at,
			lastSeenAt: at,
			test: null
		};
		const { test: _, ...stored } = device;
		writeJson(path, [...devices, { ...stored, tokenHash: sha256(token) }]);
		return { token, device };
	});
}

const publicDevice = ({ id, label, pairedAt, lastSeenAt, test }: StoredDevice): Device => ({
	id,
	label,
	pairedAt,
	lastSeenAt: new Date(Math.max(Date.parse(lastSeenAt ?? pairedAt), seen.get(id) ?? 0)).toISOString(),
	test: test ? { label: test.label, expiresAt: test.expiresAt, owned: [...test.owned] } : null
});

/** Whether a login is over: a test login past its own time; a password login 30 days after it
 *  was made, or 7 days after its last logged-in request. */
export function expired(device: Pick<Device, 'test' | 'pairedAt' | 'lastSeenAt'>, now: number): boolean {
	if (device.test) return Date.parse(device.test.expiresAt) <= now;
	return Date.parse(device.pairedAt) + LOGIN_DAYS * DAY_MS <= now || Date.parse(device.lastSeenAt) + IDLE_DAYS * DAY_MS <= now;
}

/** Note that a logged-in device made a request now: at once in this process, in the file at most
 *  once a minute per device. */
export function markSeen(stateDir: string, device: Device, now: number): void {
	if (device.test) return;
	seen.set(device.id, now);
	if (now - (written.get(device.id) ?? -Infinity) < SEEN_EVERY_MS) return;
	written.set(device.id, now);
	withLock(stateDir, () => {
		const path = join(stateDir, DEVICES_FILE);
		const devices = readJson<StoredDevice>(path);
		const stored = devices.find((candidate) => candidate.id === device.id);
		if (!stored) return;
		stored.lastSeenAt = new Date(now).toISOString();
		writeJson(path, devices);
	});
}

/** Whether the device's test login code was never used. */
const unused = (device: StoredDevice) => !device.tokenHash;

export interface ListedDevice extends Device {
	/** A test login whose one-time link has not been opened yet. */
	unused: boolean;
}

export function listDevices(stateDir: string): ListedDevice[] {
	return readJson<StoredDevice>(join(stateDir, DEVICES_FILE)).map((device) => ({ ...publicDevice(device), unused: unused(device) }));
}

/** The logged-in device the token belongs to; null for none, and for a test login past its time. */
export function findDevice(stateDir: string, token: string, now: number = Date.now()): Device | null {
	if (!token) return null;
	const tokenHash = sha256(token);
	const match = readJson<StoredDevice>(join(stateDir, DEVICES_FILE)).find(
		(device) => !unused(device) && device.tokenHash === tokenHash
	);
	if (!match) return null;
	const device = publicDevice(match);
	return expired(device, now) ? null : device;
}

/** A logged-in device by its ID; null for none, and for a test login past its time. */
export function findDeviceById(stateDir: string, id: string, now: number): Device | null {
	const match = readJson<StoredDevice>(join(stateDir, DEVICES_FILE)).find((device) => device.id === id && !unused(device));
	if (!match) return null;
	const device = publicDevice(match);
	return expired(device, now) ? null : device;
}

/** A relaunch gave the agent a new session: every test device that owned the old one owns the new one. */
export function carryOwnership(stateDir: string, from: string, to: string): void {
	withLock(stateDir, () => {
		const path = join(stateDir, DEVICES_FILE);
		const devices = readJson<StoredDevice>(path);
		let changed = false;
		for (const device of devices) {
			if (!device.test?.owned.includes(from) || device.test.owned.includes(to)) continue;
			device.test.owned = [...device.test.owned, to];
			changed = true;
		}
		if (changed) writeJson(path, devices);
	});
}

export function revokeDevice(stateDir: string, id: string): boolean {
	return withLock(stateDir, () => {
		const path = join(stateDir, DEVICES_FILE);
		const devices = readJson<StoredDevice>(path);
		const kept = devices.filter((device) => device.id !== id);
		if (kept.length === devices.length) return false;
		writeJson(path, kept);
		return true;
	});
}

/** Issue a test login: its device waits, logged out, for the one-time `code` the login link carries. */
export function issueTestLogin(stateDir: string, terms: { label: string; hours: number; now: number }): { id: string; code: string; expiresAt: string } {
	return withLock(stateDir, () => {
		const path = join(stateDir, DEVICES_FILE);
		const devices = readJson<StoredDevice>(path);
		const code = randomBytes(32).toString('base64url');
		const id = randomBytes(4).toString('hex');
		const expiresAt = new Date(terms.now + terms.hours * 60 * 60 * 1000).toISOString();
		const device: StoredDevice = {
			id,
			label: '',
			pairedAt: new Date(terms.now).toISOString(),
			tokenHash: '',
			test: { label: terms.label.slice(0, 200), expiresAt, owned: [], codeHash: sha256(code) }
		};
		writeJson(path, [...devices, device]);
		return { id, code, expiresAt };
	});
}

/** Log a browser in with a test login's one-time code: only once, and only before it expires. */
export function redeemTestLogin(stateDir: string, code: string, userAgent: string, now: number): { token: string; device: Device } | null {
	if (!code) return null;
	return withLock(stateDir, () => {
		const path = join(stateDir, DEVICES_FILE);
		const devices = readJson<StoredDevice>(path);
		const codeHash = sha256(code);
		const match = devices.find((device) => device.test?.codeHash === codeHash);
		if (!match?.test || !unused(match) || Date.parse(match.test.expiresAt) <= now) return null;
		const token = randomBytes(32).toString('base64url');
		const { codeHash: _, ...test } = match.test;
		const redeemed: StoredDevice = { ...match, label: userAgent.slice(0, 200), pairedAt: new Date(now).toISOString(), tokenHash: sha256(token), test };
		writeJson(path, devices.map((device) => (device === match ? redeemed : device)));
		return { token, device: publicDevice(redeemed) };
	});
}

/** Note that a test device started the agent with this session ID: from now on it may act on it. */
export function addOwned(stateDir: string, deviceId: string, sessionId: string): void {
	withLock(stateDir, () => {
		const path = join(stateDir, DEVICES_FILE);
		const devices = readJson<StoredDevice>(path);
		const device = devices.find((candidate) => candidate.id === deviceId);
		if (!device?.test || device.test.owned.includes(sessionId)) return;
		device.test.owned = [...device.test.owned, sessionId];
		writeJson(path, devices);
	});
}
