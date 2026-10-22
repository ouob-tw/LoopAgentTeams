// What a resume adds to the arguments hcom stored, to keep a Claude session's permission mode.
import { expect, test } from 'bun:test';
import { permissionArgs } from '../../src/lib/server/permission.ts';

test('the mode is added when the stored arguments leave it to the default or give another', () => {
	expect(permissionArgs([], 'bypassPermissions')).toEqual(['--permission-mode', 'bypassPermissions']);
	expect(permissionArgs(['--model', 'claude-opus-5-5', '--effort', 'medium'], 'bypassPermissions')).toEqual(['--permission-mode', 'bypassPermissions']);
	expect(permissionArgs([], 'auto')).toEqual(['--permission-mode', 'auto']);
	// The last `--permission-mode` is the one Claude takes.
	expect(permissionArgs(['--permission-mode', 'auto', '--permission-mode', 'plan'], 'auto')).toEqual(['--permission-mode', 'auto']);
	expect(permissionArgs(['--permission-mode=bypassPermissions'], 'default')).toEqual(['--permission-mode', 'default']);
});

test('nothing is added when the stored arguments give the mode already', () => {
	expect(permissionArgs(['--dangerously-skip-permissions'], 'bypassPermissions')).toEqual([]);
	expect(permissionArgs(['--permission-mode', 'plan'], 'plan')).toEqual([]);
	expect(permissionArgs(['--permission-mode=auto'], 'auto')).toEqual([]);
});

test('nothing is added for a mode not known, or not recorded', () => {
	expect(permissionArgs([], null)).toEqual([]);
	expect(permissionArgs([], 'everything')).toEqual([]);
	expect(permissionArgs([], '--dangerously-skip-permissions')).toEqual([]);
});

test('stored with the bypass flag, which no argument overrides, nothing is added', () => {
	expect(permissionArgs(['--dangerously-skip-permissions', '--model', 'claude-opus-5-5'], 'auto')).toEqual([]);
});
