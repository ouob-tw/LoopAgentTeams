// The TOTP second step: RFC 6238's own test values, the window either side, codes that cannot be
// used twice, and a secret file only its owner can read.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	base32Decode,
	base32Encode,
	clearTotp,
	hasTotp,
	matchingStep,
	newTotpSecret,
	otpauthUrl,
	saveTotp,
	TOTP_FILE,
	totpCode,
	useTotp
} from '../../src/lib/server/totp.ts';

// RFC 6238 appendix B: the SHA-1 secret is the ASCII text "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'lat-board-totp-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('codes match RFC 6238 appendix B (its 8-digit values, last 6 digits)', () => {
	expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
	const vectors: [number, string][] = [
		[59, '287082'],
		[1111111109, '081804'],
		[1111111111, '050471'],
		[1234567890, '005924'],
		[2000000000, '279037'],
		[20000000000, '353130']
	];
	for (const [seconds, code] of vectors) expect([seconds, totpCode(RFC_SECRET, seconds * 1000)]).toEqual([seconds, code]);
});

test('base32 goes both ways for any length', () => {
	for (let length = 0; length < 25; length++) {
		const bytes = Buffer.from(Array.from({ length }, (_, i) => (i * 37 + 11) & 255));
		expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
	}
	expect(() => base32Decode('NOT-BASE32!')).toThrow();
});

test('a code from the step before or after is taken, two steps off is not, and spaces do not matter', () => {
	const now = 1_800_000_015_000;
	const secret = newTotpSecret();
	expect(base32Decode(secret).length).toBe(20);
	expect(matchingStep(secret, totpCode(secret, now - 30_000), now)).not.toBeNull();
	expect(matchingStep(secret, totpCode(secret, now + 30_000), now)).not.toBeNull();
	expect(matchingStep(secret, totpCode(secret, now - 60_000), now)).toBeNull();
	expect(matchingStep(secret, totpCode(secret, now + 60_000), now)).toBeNull();
	const code = totpCode(secret, now);
	expect(matchingStep(secret, `${code.slice(0, 3)} ${code.slice(3)}`, now)).not.toBeNull();
	for (const bad of ['', '12345', '1234567', 'abcdef']) expect(matchingStep(secret, bad, now)).toBeNull();
});

test('the secret file is readable by its owner only, and a right code works once', () => {
	const now = 1_800_000_000_000;
	const secret = newTotpSecret();
	expect(hasTotp(dir)).toBe(false);
	expect(useTotp(dir, '123456', now)).toBeNull();

	saveTotp(dir, secret, now);
	expect(hasTotp(dir)).toBe(true);
	expect(statSync(join(dir, TOTP_FILE)).mode & 0o777).toBe(0o600);
	expect(statSync(dir).mode & 0o777).toBe(0o700);

	expect(useTotp(dir, totpCode(secret, now), now)).toBe(true);
	// The same code again, or one from the step before it, is refused.
	expect(useTotp(dir, totpCode(secret, now), now)).toBe(false);
	expect(useTotp(dir, totpCode(secret, now - 30_000), now)).toBe(false);
	// The next step's code still works.
	expect(useTotp(dir, totpCode(secret, now + 30_000), now + 30_000)).toBe(true);
	expect(statSync(join(dir, TOTP_FILE)).mode & 0o777).toBe(0o600);
});

test('a new secret replaces the old one at once, and a clear removes it', () => {
	const now = 1_800_000_000_000;
	const old = newTotpSecret();
	saveTotp(dir, old, now);
	const replacement = newTotpSecret();
	saveTotp(dir, replacement, now);
	expect(useTotp(dir, totpCode(old, now), now)).toBe(false);
	expect(useTotp(dir, totpCode(replacement, now), now)).toBe(true);

	expect(clearTotp(dir)).toBe(true);
	expect(hasTotp(dir)).toBe(false);
	expect(clearTotp(dir)).toBe(false);
	expect(useTotp(dir, totpCode(replacement, now + 30_000), now + 30_000)).toBeNull();
});

test('a damaged secret file is an error, not a missing secret', () => {
	saveTotp(dir, newTotpSecret(), 0);
	Bun.write(join(dir, TOTP_FILE), '{"secret": ""}');
	expect(() => hasTotp(dir)).toThrow();
	expect(readFileSync(join(dir, TOTP_FILE), 'utf8')).toContain('secret');
});

test('the otpauth link names the board, the secret and the code settings', () => {
	const url = new URL(otpauthUrl('JBSWY3DPEHPK3PXP', 'host-a'));
	expect(url.protocol).toBe('otpauth:');
	expect(url.host).toBe('totp');
	expect(decodeURIComponent(url.pathname)).toBe('/LAT 看板:host-a');
	expect(Object.fromEntries(url.searchParams)).toEqual({ secret: 'JBSWY3DPEHPK3PXP', issuer: 'LAT 看板', algorithm: 'SHA1', digits: '6', period: '30' });
});
