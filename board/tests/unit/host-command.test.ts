import { expect, test } from 'bun:test';
import { hostCommand } from '#lib/host-command.ts';

test('an ordinary board path is written plainly', () => {
	expect(hostCommand('/srv/lat/board', 'totp')).toBe('cd /srv/lat/board && bun run board totp');
});

test('a path with spaces or quotes stays one word in the shell', () => {
	expect(hostCommand('/srv/my lat/board', 'totp')).toBe("cd '/srv/my lat/board' && bun run board totp");
	expect(hostCommand("/srv/o'neil", 'totp')).toBe(`cd '/srv/o'\\''neil' && bun run board totp`);
});
