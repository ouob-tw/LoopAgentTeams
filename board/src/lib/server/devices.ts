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
}

interface StoredDevice extends Device {
	tokenHash: string;
}

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
export function registerDevice(stateDir: string, label: string): { token: string; device: Device } {
	return withLock(stateDir, () => {
		const path = join(stateDir, DEVICES_FILE);
		const devices = readJson<StoredDevice>(path);
		const token = randomBytes(32).toString('base64url');
		const device: Device = {
			id: randomBytes(4).toString('hex'),
			label: label.slice(0, 200),
			pairedAt: new Date().toISOString()
		};
		writeJson(path, [...devices, { ...device, tokenHash: sha256(token) }]);
		return { token, device };
	});
}

const publicDevice = ({ id, label, pairedAt }: StoredDevice): Device => ({ id, label, pairedAt });

export function listDevices(stateDir: string): Device[] {
	return readJson<StoredDevice>(join(stateDir, DEVICES_FILE)).map(publicDevice);
}

export function findDevice(stateDir: string, token: string): Device | null {
	const tokenHash = sha256(token);
	const match = readJson<StoredDevice>(join(stateDir, DEVICES_FILE)).find(
		(device) => device.tokenHash === tokenHash
	);
	return match ? publicDevice(match) : null;
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
