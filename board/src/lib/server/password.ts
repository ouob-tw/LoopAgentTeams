// The board's login password, kept in the state directory as a salted scrypt hash, never as text.
// The host command sets it; the server reads the file at every login, so a change applies at once.
import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

export const PASSWORD_FILE = 'password.json';

interface StoredPassword {
	scheme: 'scrypt';
	N: number;
	r: number;
	p: number;
	salt: string;
	hash: string;
	setAt: string;
}

// About 0.1 s and 32 MiB per check on a desktop CPU.
const COST = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LENGTH = 32;
const maxmem = (N: number, r: number) => 128 * N * r * 2;

const scryptAsync = promisify(scrypt) as (
	password: string,
	salt: Buffer,
	length: number,
	options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

function readStored(stateDir: string): StoredPassword | null {
	let text: string;
	try {
		text = readFileSync(join(stateDir, PASSWORD_FILE), 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
	const stored = JSON.parse(text) as StoredPassword;
	if (stored.scheme !== 'scrypt' || !stored.salt || !stored.hash) throw new Error(`${PASSWORD_FILE} is not a password hash`);
	return stored;
}

export function hasPassword(stateDir: string): boolean {
	return readStored(stateDir) !== null;
}

export function setPassword(stateDir: string, password: string): void {
	const salt = randomBytes(16);
	const hash = scryptSync(password, salt, KEY_LENGTH, { ...COST, maxmem: maxmem(COST.N, COST.r) });
	const stored: StoredPassword = {
		scheme: 'scrypt',
		...COST,
		salt: salt.toString('base64'),
		hash: hash.toString('base64'),
		setAt: new Date().toISOString()
	};
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const path = join(stateDir, PASSWORD_FILE);
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(stored, null, 2) + '\n', { mode: 0o600 });
	renameSync(temporary, path);
}

/** Whether the password matches; null when no password has been set. */
export async function checkPassword(stateDir: string, password: string): Promise<boolean | null> {
	const stored = readStored(stateDir);
	if (!stored) return null;
	const expected = Buffer.from(stored.hash, 'base64');
	const given = await scryptAsync(password, Buffer.from(stored.salt, 'base64'), expected.length, {
		N: stored.N,
		r: stored.r,
		p: stored.p,
		maxmem: maxmem(stored.N, stored.r)
	});
	return timingSafeEqual(given, expected);
}
