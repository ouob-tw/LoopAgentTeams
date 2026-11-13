// The board's own passkeys, the default second step of a password login. They are registered and
// checked by the board itself (WebAuthn, @simplewebauthn/server), apart from pd's passkeys.
//
// A passkey is registered with a one-time code the host command issues (10 minutes, used up by the
// passkey it registers) on top of the password, so knowing the password is not enough to add one;
// or from the settings of a device already logged in. A passkey logs in alone too, without the
// password. The file is kept in the board's state directory, readable by its owner only, and every
// change holds the state directory's lock, which the host commands share.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withLock } from './devices.ts';

export const PASSKEYS_FILE = 'passkeys.json';
/** How long a code from `board passkey code` can be used. */
export const ENROLL_CODE_MINUTES = 10;
/** Letters and digits that cannot be mistaken for each other when typed from a terminal. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10;

export interface Passkey {
	/** A short ID for the host commands. */
	id: string;
	/** The browser's user agent when it was registered. */
	label: string;
	createdAt: string;
	lastUsedAt: string | null;
	/** The credential ID WebAuthn gives, base64url. */
	credentialId: string;
	/** The COSE public key, base64url. */
	publicKey: string;
	/** The authenticator's signature counter at its last use; 0 for one that keeps none. */
	counter: number;
	transports: string[];
}

interface Stored {
	passkeys: Passkey[];
	/** The one registration code that can be used, by its hash; a new one replaces it. */
	enrollment?: { codeHash: string; expiresAt: string };
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
/** A code as typed: case, spaces and dashes do not matter. */
const normalized = (code: string) => code.toUpperCase().replace(/[\s-]/g, '');
export const enrollCodeHash = (code: string) => sha256(normalized(code));

function read(stateDir: string): Stored {
	let text: string;
	try {
		text = readFileSync(join(stateDir, PASSKEYS_FILE), 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { passkeys: [] };
		throw error;
	}
	let stored: Stored;
	try {
		stored = JSON.parse(text);
	} catch {
		// Not the parser's own message, which quotes the file.
		throw new Error(`${PASSKEYS_FILE} is not valid JSON`);
	}
	if (!Array.isArray(stored?.passkeys)) throw new Error(`${PASSKEYS_FILE} has no passkey list`);
	return stored;
}

function write(stateDir: string, stored: Stored): void {
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const path = join(stateDir, PASSKEYS_FILE);
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(stored, null, 2) + '\n', { mode: 0o600 });
	renameSync(temporary, path);
}

/** The registered passkeys; throws when the file cannot be read. */
export const listPasskeys = (stateDir: string): Passkey[] => read(stateDir).passkeys;

/** Whether any passkey is registered; throws when the file cannot be read. */
export const hasPasskeys = (stateDir: string) => listPasskeys(stateDir).length > 0;

/** Remove a passkey by its ID: it cannot log in from then on. False when there is none. */
export function deletePasskey(stateDir: string, id: string): boolean {
	return withLock(stateDir, () => {
		const stored = read(stateDir);
		const kept = stored.passkeys.filter((passkey) => passkey.id !== id);
		if (kept.length === stored.passkeys.length) return false;
		write(stateDir, { ...stored, passkeys: kept });
		return true;
	});
}

/** Issue a registration code, replacing any earlier one; it works for 10 minutes and registers one passkey. */
export function issueEnrollCode(stateDir: string, now: number): { code: string; expiresAt: string } {
	const raw = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
	const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
	const expiresAt = new Date(now + ENROLL_CODE_MINUTES * 60 * 1000).toISOString();
	withLock(stateDir, () => write(stateDir, { ...read(stateDir), enrollment: { codeHash: enrollCodeHash(code), expiresAt } }));
	return { code, expiresAt };
}

const codeWorks = (stored: Stored, codeHash: string, now: number) =>
	!!stored.enrollment && stored.enrollment.codeHash === codeHash && Date.parse(stored.enrollment.expiresAt) > now;

/** Whether this registration code can be used now: the latest one issued, not yet used, not over. */
export const enrollCodeWorks = (stateDir: string, code: string, now: number) => codeWorks(read(stateDir), enrollCodeHash(code), now);

type NewPasskey = Pick<Passkey, 'credentialId' | 'publicKey' | 'counter' | 'transports' | 'label'>;

const made = (now: number, passkey: NewPasskey): Passkey => ({
	id: randomBytes(4).toString('hex'),
	createdAt: new Date(now).toISOString(),
	lastUsedAt: null,
	...passkey,
	label: passkey.label.slice(0, 200)
});

/** Register a passkey with the registration code (by its hash), using the code up. Null, and
 *  nothing saved, when the code no longer works: used, replaced or over meanwhile. */
export function addPasskey(stateDir: string, codeHash: string, now: number, passkey: NewPasskey): Passkey | null {
	return withLock(stateDir, () => {
		const stored = read(stateDir);
		if (!codeWorks(stored, codeHash, now)) return null;
		const added = made(now, passkey);
		write(stateDir, { passkeys: [...stored.passkeys, added] });
		return added;
	});
}

/** Register a passkey from a logged-in device's settings: no code, and an issued code stays. */
export function addDevicePasskey(stateDir: string, now: number, passkey: NewPasskey): Passkey {
	return withLock(stateDir, () => {
		const stored = read(stateDir);
		const added = made(now, passkey);
		write(stateDir, { ...stored, passkeys: [...stored.passkeys, added] });
		return added;
	});
}

/** Note a passkey's verified use with the counter it signed. False when it was deleted meanwhile,
 *  or when another login already took this counter: either way the login does not go through. */
export function recordUse(stateDir: string, credentialId: string, counter: number, now: number): boolean {
	return withLock(stateDir, () => {
		const stored = read(stateDir);
		const passkey = stored.passkeys.find((candidate) => candidate.credentialId === credentialId);
		if (!passkey) return false;
		// An authenticator that keeps a counter must sign a larger one each time; 0 means it keeps none.
		if ((counter || passkey.counter) && counter <= passkey.counter) return false;
		passkey.counter = counter;
		passkey.lastUsedAt = new Date(now).toISOString();
		write(stateDir, stored);
		return true;
	});
}
