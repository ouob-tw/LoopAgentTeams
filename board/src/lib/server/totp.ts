// The TOTP second step of a password login (RFC 6238: HMAC-SHA1, 6 digits, 30-second steps), as
// authenticator apps make it. The secret is kept in the board's state directory, readable by its
// owner only; the host command sets it, and the server reads the file at every check, so a change
// or a clear applies at once. Every read that writes back, and every set or clear, holds the state
// directory's lock: a login that read the old secret cannot write it back over a new one or a clear.
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withLock } from './devices.ts';

export const TOTP_FILE = 'totp.json';
const STEP_MS = 30_000;
const DIGITS = 6;
/** A code from the step before or after is taken too: a phone's clock may be a little off. */
const WINDOW = 1;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

interface StoredTotp {
	/** Base32, as authenticator apps take it. */
	secret: string;
	setAt: string;
	/** The step of the last code that logged in: neither it nor an earlier one works again. */
	lastStep: number;
}

export function base32Encode(bytes: Buffer): string {
	let bits = 0;
	let value = 0;
	let text = '';
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			text += BASE32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) text += BASE32[(value << (5 - bits)) & 31];
	return text;
}

export function base32Decode(text: string): Buffer {
	const bytes: number[] = [];
	let bits = 0;
	let value = 0;
	for (const char of text.toUpperCase().replace(/=+$/, '')) {
		const index = BASE32.indexOf(char);
		if (index < 0) throw new Error('not base32');
		value = (value << 5) | index;
		bits += 5;
		if (bits >= 8) {
			bytes.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return Buffer.from(bytes);
}

/** A new secret: 20 random bytes, the size RFC 4226 recommends for HMAC-SHA1. */
export const newTotpSecret = () => base32Encode(randomBytes(20));

const stepAt = (time: number) => Math.floor(time / STEP_MS);

function codeForStep(secret: string, step: number): string {
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(step));
	const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
	const offset = hmac[hmac.length - 1] & 15;
	const number = hmac.readUInt32BE(offset) & 0x7fffffff;
	return String(number % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** The code an authenticator app shows for this secret at this time. */
export const totpCode = (secret: string, time: number) => codeForStep(secret, stepAt(time));

/** What to put in an authenticator app: the `otpauth://` link its QR code carries. */
export function otpauthUrl(secret: string, account: string): string {
	const issuer = 'LAT 看板';
	const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
	return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_MS / 1000}`;
}

/** The step a code belongs to near this time, or null when it is none of them. Spaces are ignored. */
export function matchingStep(secret: string, code: string, time: number): number | null {
	const digits = code.replace(/\s/g, '');
	if (!new RegExp(`^\\d{${DIGITS}}$`).test(digits)) return null;
	const now = stepAt(time);
	for (let step = now - WINDOW; step <= now + WINDOW; step++) if (codeForStep(secret, step) === digits) return step;
	return null;
}

function readStored(stateDir: string): StoredTotp | null {
	let text: string;
	try {
		text = readFileSync(join(stateDir, TOTP_FILE), 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
	let stored: StoredTotp;
	try {
		stored = JSON.parse(text);
	} catch {
		// Not the parser's own message: it quotes the file, which may hold the secret.
		throw new Error(`${TOTP_FILE} is not valid JSON`);
	}
	if (typeof stored?.secret !== 'string' || !stored.secret) throw new Error(`${TOTP_FILE} has no secret`);
	base32Decode(stored.secret);
	return { ...stored, lastStep: Number.isInteger(stored.lastStep) ? stored.lastStep : -1 };
}

function writeStored(stateDir: string, stored: StoredTotp): void {
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const path = join(stateDir, TOTP_FILE);
	// A new file each time, made owner-only, then moved over the old one.
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(stored, null, 2) + '\n', { mode: 0o600 });
	renameSync(temporary, path);
}

/** Whether a TOTP secret is set; throws when the file cannot be read. */
export const hasTotp = (stateDir: string) => readStored(stateDir) !== null;

/** Set the secret, replacing any before it: codes from the old one stop working at once. The code
 *  that confirmed it, from `usedStep`, does not log in. */
export function saveTotp(stateDir: string, secret: string, now: number, usedStep = -1): void {
	withLock(stateDir, () => writeStored(stateDir, { secret, setAt: new Date(now).toISOString(), lastStep: usedStep }));
}

/** Remove the secret, also a damaged file; false when there was none. */
export function clearTotp(stateDir: string): boolean {
	const path = join(stateDir, TOTP_FILE);
	return withLock(stateDir, () => {
		const set = existsSync(path);
		rmSync(path, { force: true });
		return set;
	});
}

/** Check a code and, when it is right, use it up: the same code, or one from an earlier step, does
 *  not work again. null when no secret is set. Holds the state directory's lock from the read to the
 *  write, so two logins cannot both use one code and a set or clear cannot slip in between. */
export function useTotp(stateDir: string, code: string, now: number): boolean | null {
	return withLock(stateDir, () => {
		const stored = readStored(stateDir);
		if (!stored) return null;
		const step = matchingStep(stored.secret, code, now);
		if (step === null || step <= stored.lastStep) return false;
		writeStored(stateDir, { ...stored, lastStep: step });
		return true;
	});
}
