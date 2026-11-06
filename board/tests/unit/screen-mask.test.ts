// What the 終端分頁 hides before a pane's screen leaves the server: strings that look like passwords
// and keys, replaced with marks as wide as they were, colour codes and the layout left as they are.
import { join } from 'node:path';
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
	// A flag is two columns; a symbol shown as text by default, one; the same asked as emoji, two.
	expect(maskScreen('password=\u{1f1f9}\u{1f1fc}abc next')).toBe(`password=${masked(5)} next`);
	expect(maskScreen('password=\u00a9abc next')).toBe(`password=${masked(4)} next`);
	expect(maskScreen('password=\u00a9\ufe0fabc next')).toBe(`password=${masked(5)} next`);
});

test('a screen with only colour codes and box lines is left alone', () => {
	const screen = `${ESC}[38;5;4m╭────╮${ESC}[0m\r\n${ESC}[7m│ ok │${ESC}[0m`;
	expect(maskScreen(screen)).toBe(screen);
});

test('a name is judged whole, and the value after a name that fails to have one is still looked for', () => {
	const hunter = fake('hun', 'ter22');
	expect(maskScreen(`my.TOKEN_x = "${hunter}" done`)).toBe(`my.TOKEN_x = "${masked(hunter.length)}" done`);
	expect(maskScreen(`note=password=${hunter} done`)).toBe(`note=password=${masked(hunter.length)} done`);
	expect(maskScreen(`token=ab password=${hunter} done`)).toBe(`token=ab password=${masked(hunter.length)} done`);
	expect(maskScreen(`password=${hunter}=token=${hunter}`)).toBe(`password=${masked(hunter.length * 2 + 7)}`);
	expect(maskScreen(`passwordpassword nothing=${hunter}`)).toBe(`passwordpassword nothing=${hunter}`);
});

test('a JWT starts at its first eyJ with room for its first part, and one that does not go on is left', () => {
	const part = (name: string) => `eyJ${name}abcdefgh`;
	const key = `${part('a')}.${part('b')}.signature`;
	expect(maskScreen(`x-eyJ-${key} done`)).toBe(`x-${masked('eyJ-'.length + key.length)} done`);
	expect(maskScreen(`x-eyJ-a.${key} done`)).toBe(`x-eyJ-a.${masked(key.length)} done`);
	expect(maskScreen(`${part('a')}.${part('b')}.short done`)).toBe(`${part('a')}.${part('b')}.short done`);
	expect(maskScreen(`eyJ-short.${part('b')}.signature done`)).toBe(`eyJ-short.${part('b')}.signature done`);
});

test('when the pane cannot tell, a key split over two lines and a key right under another line are both hidden', () => {
	const key = fake('sk-', 'proj-AbCdEf0123456789ghijKLMNopqrstuv');
	const access = fake('AK', 'IAIOSFODNN7EXAMPLE');
	const jwt = `eyJaabcdefgh.eyJbabcdefgh.signature`;
	const screens: [string, string][] = [
		[`${key.slice(0, 20)}\r\n${key.slice(20)}`, `${masked(20)}\r\n${masked(key.length - 20)}`],
		[`$ cat key\r\n${key}`, `$ cat key\r\n${masked(key.length)}`],
		[`${access}\r\nnext line`, `${masked(access.length)}\r\nnext line`],
		[`Bearer\r\n${key}`, `Bearer\r\n${masked(key.length)}`],
		[`decoded\r\n${jwt}`, `decoded\r\n${masked(jwt.length)}`]
	];
	for (const [screen, hidden] of screens) expect(maskScreen(screen, 'all')).toBe(hidden);
});

test('a key wrapped over several lines under another line is hidden on all of them, as a read does it', () => {
	const key = fake('sk-', 'proj-', 'AbCdEf0123456789ghijKLMNopqrstuv'.repeat(6));
	const width = 80;
	const rows = key.match(new RegExp(`.{1,${width}}`, 'g'))!;
	const screen = ['$ cat key', ...rows].join('\r\n');
	const hidden = ['$ cat key', ...rows.map((row) => masked(row.length))].join('\r\n');
	const text = `$ cat key\r\n${key}\r\n`;
	expect(wrapMatters(screen)).toBe(true);
	expect(maskScreen(screen, { unwrapped: text })).toBe(hidden);
	// More of the pane's text than is searched: the screen's lines are at its end.
	expect(maskScreen(screen, { unwrapped: `${'x'.repeat(300_000)}\r\n${text}` })).toBe(hidden);
});

test('pane text is searched for two wrapped lines exactly', () => {
	const key = fake('sk-', 'proj-AbCdEf0123456789ghijKLMNopqrstuv');
	const screen = `${key.slice(0, 20)}\r\n${key.slice(20)}`;
	const hidden = `${masked(20)}\r\n${masked(key.length - 20)}`;
	expect(maskScreen(screen, { unwrapped: `abab${key}` })).toBe(hidden);
	expect(maskScreen(screen, { unwrapped: `${key.slice(0, 20)}\r\n${key.slice(20)}` })).toBe(screen);
	expect(maskScreen(screen, { unwrapped: `${key.slice(0, -1)}!` })).toBe(screen);
});

// Masking runs on the board's only thread at every read of an open 終端分頁, about once a second: a
// screen that needs longer than a read's interval leaves the board answering nobody. CPU time, so a
// busy host does not count against it; far over what any of these needs here (at most a few hundred ms), and far
// under the minutes a pattern that backtracks takes.
const SCREEN_CPU_LIMIT_MS = 1_000;
/** The screens with four times the characters, where the search of the pane's text is slowest. */
const LARGER_SCREEN = 'pane text that almost holds every pair of lines of a larger screen';
const LARGER_SCREEN_CPU_LIMIT_MS = 3_000;
/** A screen stuck masking is ended here. Long enough for all of them on a very busy host. */
const ALL_SCREENS_MS = 60_000;

test('the worst screens each mask within the time between two reads, under the runtime the board uses', async () => {
	const node = Bun.which('node');
	if (!node) throw new Error('this test needs node, which runs the board');
	const child = Bun.spawn([node, '--experimental-strip-types', '--no-warnings', join(import.meta.dir, 'screen-mask-time-case.ts')], { stdout: 'pipe', stderr: 'pipe' });
	const timer = setTimeout(() => child.kill('SIGKILL'), ALL_SCREENS_MS);
	const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	clearTimeout(timer);
	expect({ code, errors, output }).toMatchObject({ code: 0, errors: '' });
	const times = output.trim().split('\n').map((row) => row.split(/ (.*)/s));
	expect(times.filter(([ms, name]) => Number(ms) > (name === LARGER_SCREEN ? LARGER_SCREEN_CPU_LIMIT_MS : SCREEN_CPU_LIMIT_MS))).toEqual([]);
}, ALL_SCREENS_MS + 10_000);
