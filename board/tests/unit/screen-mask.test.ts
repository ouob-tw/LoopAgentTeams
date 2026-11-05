// What the 畫面分頁 hides before a pane's screen leaves the server: strings that look like passwords
// and keys, replaced with marks as wide as they were, colour codes and the layout left as they are.
import { expect, test } from 'bun:test';
import { MASK, maskScreen, wrapMatters } from '../../src/lib/server/screen-mask.ts';

const ESC = '\x1b';
/** The screen as it shows, without colour codes. */
const plain = (screen: string) => screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const masked = (length: number) => MASK.repeat(length);
/** A fake key put together from pieces, so no key-like literal sits in the source for secret scanners to flag. */
const fake = (...parts: string[]) => parts.join('');

test('common key shapes are hidden, the text around them stays', () => {
	const keys = [
		fake('sk-', 'proj-AbCdEf0123456789ghijKLMNopqrstuv'),
		fake('sk-', 'ant-api03-ZZZ_aaaa-bbbbccccddddeeeeffff'),
		fake('gh', 'p_', '0123456789abcdefABCDEF0123456789abcd'),
		fake('github', '_pat_', '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz'),
		fake('AK', 'IAIOSFODNN7EXAMPLE'),
		fake('xo', 'xb-', '123456789012-abcdefghijkl'),
		fake('AI', 'za', 'SyA-1234567890abcdefghijklmnopqrstu'),
		['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'].join('.')
	];
	for (const key of keys) {
		const screen = `export KEY=x; echo ${key} done`;
		expect(maskScreen(screen)).toBe(`export KEY=x; echo ${masked(key.length)} done`);
	}
});

test('the value after password=, token: and the like is hidden, the name stays', () => {
	expect(maskScreen('password=hunter2abc next')).toBe(`password=${masked(10)} next`);
	expect(maskScreen('  token: "abc123def456"')).toBe(`  token: "${masked(12)}"`);
	expect(maskScreen('API_KEY = s3cr3t-value')).toBe(`API_KEY = ${masked(12)}`);
	expect(maskScreen(fake('aws_secret_access_key=', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'))).toBe(`aws_secret_access_key=${masked(40)}`);
	expect(maskScreen('Authorization: Bearer abcdefghijklmnop0123')).toBe(`Authorization: Bearer ${masked(20)}`);
});

test('a key cut into pieces by colour codes is hidden, and the codes stay where they were', () => {
	const key = fake('gh', 'p_', '0123456789abcdefABCDEF0123456789abcd');
	const screen = `x ${ESC}[31m${key.slice(0, 10)}${ESC}[1;32m${key.slice(10, 25)}${ESC}[0m${key.slice(25)} y`;
	const out = maskScreen(screen);
	expect(out).toBe(`x ${ESC}[31m${masked(10)}${ESC}[1;32m${masked(15)}${ESC}[0m${masked(key.length - 25)} y`);
	expect(out).not.toContain(key.slice(4, 14));
});

test('a key the pane wrapped at its edge is hidden on both lines', () => {
	const key = fake('sk-', 'proj-AbCdEf0123456789ghijKLMNopqrstuvWXYZ');
	const width = 30;
	const first = `key ${key}`.slice(0, width);
	const rest = `key ${key}`.slice(width);
	const screen = ['$ cat .env', first, `${rest} end`, '$ '].join('\r\n');
	const expected = ['$ cat .env', `key ${masked(width - 4)}`, `${masked(rest.length)} end`, '$ '].join('\r\n');
	expect(wrapMatters(screen)).toBe(true);
	// Herdr's text with the wrapped lines joined tells they were one.
	const unwrapped = ['$ cat .env', `key ${key} end`, '$ '].join('\r\n');
	const out = maskScreen(screen, { unwrapped });
	expect(out).toBe(expected);
	expect(plain(out)).not.toContain(key.slice(-8));
	// Without it, every line that may have been wrapped is taken as wrapped.
	expect(maskScreen(screen, 'all')).toBe(expected);
});

test('a line after a named value is not taken as part of it when the pane did not wrap it', () => {
	const screen = ['token=abc123secretvalue', 'swy@host:/tmp$ '].join('\r\n');
	const unwrapped = screen;
	expect(maskScreen(screen, { unwrapped })).toBe([`token=${masked(17)}`, 'swy@host:/tmp$ '].join('\r\n'));
	expect(maskScreen(screen, 'none')).toBe(maskScreen(screen, { unwrapped }));
});

test('a private key block is hidden from its first line of body to its last, its markers stay', () => {
	const body = ['MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun', 'VTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK', 'LxoS2tFczGkPLPgizskuemMghRniWaoLcyehkd3qqGElvW/VDL5AaWTg0nLVkjRo'];
	const screen = ['$ cat id_rsa', fake('-----BEGIN RSA PRIVATE', ' KEY-----'), ...body, '-----END RSA PRIVATE KEY-----', '$ '].join('\n');
	const out = maskScreen(screen);
	expect(out).toBe(['$ cat id_rsa', fake('-----BEGIN RSA PRIVATE', ' KEY-----'), ...body.map((line) => masked(line.length)), '-----END RSA PRIVATE KEY-----', '$ '].join('\n'));
	// Its top scrolled off: the body above the end marker is still hidden.
	const cut = [...body.slice(1), '-----END PRIVATE KEY-----'].join('\n');
	expect(maskScreen(cut)).toBe([...body.slice(1).map((line) => masked(line.length)), '-----END PRIVATE KEY-----'].join('\n'));
	// Its end not on the screen yet: everything after the start marker is hidden.
	const open = [fake('-----BEGIN OPENSSH PRIVATE', ' KEY-----'), body[0]].join('\n');
	expect(maskScreen(open)).toBe([fake('-----BEGIN OPENSSH PRIVATE', ' KEY-----'), masked(body[0].length)].join('\n'));
});

test('ordinary long strings stay as they are', () => {
	const screens = [
		'commit 3f9c2a7d1e4b5c6a8f0e9d2c1b3a4f5e6d7c8b9a',
		'/home/someone/LoopAgentTeams/.worktrees/t475/board/src/lib/server/screen-mask.ts',
		'id 0b8e5c1e-4f6a-4c3b-9d2e-7a1f3c5b8e90 ready',
		'https://github.com/ouob-tw/LoopAgentTeams/pull/123/files#diff-abcdef0123456789',
		'npm WARN deprecated some-package-name-that-is-very-long@1.2.3',
		'Do you want to proceed?  ❯ 1. Yes  2. Yes, and don\'t ask again',
		'password policy: at least 12 characters',
		'skeleton-loader-component-implementation'
	];
	for (const screen of screens) expect(maskScreen(screen)).toBe(screen);
});

test('a wide character in a masked value takes two marks, a combining mark none, so the line keeps its width', () => {
	expect(maskScreen('password=密碼abc1')).toBe(`password=${masked(8)}`);
	expect(maskScreen('password=e\u0301abc next')).toBe(`password=${masked(4)} next`);
	expect(maskScreen('password=\u05d0\u05b0abc next')).toBe(`password=${masked(4)} next`);
	// An emoji sequence joined into one takes two columns, so two marks.
	expect(maskScreen('password=ab\u{1f469}\u200d\u{1f4bb}cd next')).toBe(`password=${masked(6)} next`);
});

test('a screen with only colour codes and box lines is left alone', () => {
	const screen = `${ESC}[38;5;4m╭────╮${ESC}[0m\r\n${ESC}[7m│ ok │${ESC}[0m`;
	expect(maskScreen(screen)).toBe(screen);
});
