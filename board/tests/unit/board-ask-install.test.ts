// Installing the board-ask hook in Claude's settings, only ever in a temporary settings file.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'bun:test';

const HOOK = join(import.meta.dir, '../../hooks/board-ask.py');

let dir: string;
let settings: string;
const ORIGINAL = {
	model: 'opus',
	hooks: {
		PreToolUse: [{ matcher: 'Bash|Grep|Glob', hooks: [{ type: 'command', command: 'uv run --no-project python /x/host-guard.py hook' }] }],
		Stop: [{ hooks: [{ type: 'command', command: 'uv run --no-project python /x/turn-end.py' }] }]
	}
};
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'board-ask-install-'));
	settings = join(dir, 'settings.json');
	writeFileSync(settings, JSON.stringify(ORIGINAL, null, 2) + '\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function cli(...args: string[]) {
	const run = Bun.spawnSync(['uv', 'run', '--no-project', 'python', HOOK, ...args, '--client', 'claude', '--claude-settings', settings], {
		env: { PATH: Bun.env.PATH ?? '', HOME: Bun.env.HOME ?? '' }
	});
	return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}
const read = () => JSON.parse(readFileSync(settings, 'utf8'));

test('--preview shows the change and writes nothing', () => {
	const before = readFileSync(settings, 'utf8');
	const { code, stdout } = cli('install', '--preview');
	expect(code).toBe(0);
	expect(stdout).toContain('"matcher": "AskUserQuestion"');
	expect(readFileSync(settings, 'utf8')).toBe(before);
	expect(readdirSync(dir)).toEqual(['settings.json']);
});

test('install keeps every other hook, backs the file up, and again changes nothing', () => {
	const { code, stdout } = cli('install');
	expect(code).toBe(0);
	expect(stdout).toContain('Backup:');
	const installed = read();
	expect(installed.model).toBe('opus');
	expect(installed.hooks.Stop).toEqual(ORIGINAL.hooks.Stop);
	expect(installed.hooks.PreToolUse[0]).toEqual(ORIGINAL.hooks.PreToolUse[0]);
	expect(installed.hooks.PreToolUse[1]).toEqual({
		matcher: 'AskUserQuestion',
		hooks: [{ type: 'command', command: `uv run --no-project python ${HOOK} hook`, timeout: 660, statusMessage: '正在等看板作答，按 Esc 可中斷改在終端機回答' }]
	});
	const backup = readdirSync(dir).find((name) => name.startsWith('settings.json.board-ask-backup-'));
	expect(JSON.parse(readFileSync(join(dir, backup!), 'utf8'))).toEqual(ORIGINAL);

	expect(cli('install').stdout).toContain('No changes');
	expect(read()).toEqual(installed);
});

test('uninstall takes out only this hook', () => {
	cli('install');
	const { code } = cli('uninstall');
	expect(code).toBe(0);
	expect(read()).toEqual(ORIGINAL);
	expect(cli('uninstall').stdout).toContain('No changes');
});
