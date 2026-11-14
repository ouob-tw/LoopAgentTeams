import { expect, test } from 'bun:test';
import { BOARD_FOLDER, hostCommand } from '#lib/host-command.ts';

test('a host command is the board command alone, run from the board folder the hint names', () => {
	expect(hostCommand('totp')).toBe('bun run board totp');
	expect(BOARD_FOLDER).toBe('主機的看板資料夾（board/）');
});
