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

test('Claude gets the permission request hook too, for every tool', () => {
	cli('install');
	expect(read().hooks.PermissionRequest).toEqual([
		{ hooks: [{ type: 'command', command: `uv run --no-project python ${HOOK} hook`, timeout: 660, statusMessage: '正在等看板作答，按 Esc 可中斷改在終端機回答' }] }
	]);
});

// Codex's hooks.json, in a temporary Codex home only.
const CODEX_ORIGINAL = {
	hooks: {
		Stop: [{ hooks: [{ type: 'command', command: 'uv run --no-project python /x/lat-session.py hook' }], name: 'lat-codex-recovery' }],
		PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'uv run --no-project python /x/host-guard.py hook' }], name: 'host-guard' }]
	}
};
function codex(...args: string[]) {
	const run = Bun.spawnSync(['uv', 'run', '--no-project', 'python', HOOK, ...args, '--client', 'codex', '--codex-home', dir], {
		env: { PATH: Bun.env.PATH ?? '', HOME: Bun.env.HOME ?? '' }
	});
	return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}
const hooksJson = () => join(dir, 'hooks.json');

test('Codex: --preview writes nothing; install adds PermissionRequest, Stop and PostToolUse with a name and keeps the rest; again changes nothing; uninstall takes out only these', () => {
	writeFileSync(hooksJson(), JSON.stringify(CODEX_ORIGINAL, null, 2) + '\n');
	const before = readFileSync(hooksJson(), 'utf8');
	const preview = codex('install', '--preview');
	expect(preview.code).toBe(0);
	expect(preview.stdout).toContain('"PermissionRequest"');
	expect(readFileSync(hooksJson(), 'utf8')).toBe(before);
	expect(readdirSync(dir).filter((name) => name.startsWith('hooks.json'))).toEqual(['hooks.json']);

	const { code, stdout } = codex('install');
	expect(code).toBe(0);
	expect(stdout).toContain('/hooks');
	const installed = JSON.parse(readFileSync(hooksJson(), 'utf8'));
	const command = `uv run --no-project python ${HOOK} hook --client codex`;
	expect(installed.hooks.PreToolUse).toEqual(CODEX_ORIGINAL.hooks.PreToolUse);
	expect(installed.hooks.Stop).toEqual([...CODEX_ORIGINAL.hooks.Stop, { name: 'board-ask', hooks: [{ type: 'command', command, timeout: 10 }] }]);
	expect(installed.hooks.PostToolUse).toEqual([{ name: 'board-ask', hooks: [{ type: 'command', command, timeout: 10 }] }]);
	expect(installed.hooks.PermissionRequest).toEqual([
		{ name: 'board-ask', hooks: [{ type: 'command', command, timeout: 660, statusMessage: '正在等看板作答，按 Esc 可中斷改在終端機回答' }] }
	]);

	expect(codex('install').stdout).toContain('No changes');
	expect(JSON.parse(readFileSync(hooksJson(), 'utf8'))).toEqual(installed);

	expect(codex('uninstall').code).toBe(0);
	expect(JSON.parse(readFileSync(hooksJson(), 'utf8'))).toEqual(CODEX_ORIGINAL);
	expect(codex('uninstall').stdout).toContain('No changes');
});

test('Codex: install into a home with no hooks.json yet', () => {
	expect(codex('install').code).toBe(0);
	expect(Object.keys(JSON.parse(readFileSync(hooksJson(), 'utf8')).hooks).toSorted()).toEqual(['PermissionRequest', 'PostToolUse', 'Stop']);
	codex('uninstall');
	expect(JSON.parse(readFileSync(hooksJson(), 'utf8'))).toEqual({ hooks: {} });
});
