// What a client started without model or effort arguments uses, as the launch forms name it: read
// from settings files in temporary home and project folders, never the real ones.
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultEffort, readsCurrentAgain } from '../src/lib/board/models.ts';
import { claudeDefaults, claudeModel, codexDefaults } from '../src/lib/server/client-settings.ts';

const base = mkdtempSync(join(tmpdir(), 'lat-board-client-settings-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let dirs = 0;
/** A new folder with these files in it, by path relative to it. */
function tree(files: Record<string, string | object>): string {
	const dir = join(base, String(++dirs));
	mkdirSync(dir);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), typeof content === 'string' ? content : JSON.stringify(content));
	}
	return dir;
}

test('aliases stand for the full model ID; a full ID or an unknown name stays as it is', () => {
	expect(claudeModel('opus')).toBe('claude-opus-5-5');
	expect(claudeModel('sonnet')).toBe('claude-sonnet-5-5');
	expect(claudeModel('haiku')).toBe('claude-haiku-5-5');
	expect(claudeModel('fable')).toBe('claude-fable-5-1');
	expect(claudeModel('opus[1m]')).toBe('claude-opus-5-5[1m]');
	expect(claudeModel('claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
	expect(claudeModel('opusplan')).toBe('opusplan');
});

test("Claude: the user's settings, with the alias as its full ID and modelSettings by model", () => {
	const home = tree({
		'.claude/settings.json': { model: 'opus', effortLevel: 'medium', modelSettings: { 'claude-sonnet-5-5': { effortLevel: 'low' }, haiku: { effortLevel: 'high' } } }
	});
	const defaults = claudeDefaults(null, home);
	expect(defaults).toEqual({
		model: 'claude-opus-5-5',
		effort: 'medium',
		modelEfforts: { 'claude-sonnet-5-5': 'low', 'claude-haiku-5-5': 'high' }
	});
	// Only the model chosen: its effort is what modelSettings gives it, otherwise the effortLevel.
	expect(defaultEffort(defaults, null)).toBe('medium');
	expect(defaultEffort(defaults, 'claude-sonnet-5-5')).toBe('low');
	expect(defaultEffort(defaults, 'claude-haiku-5-5')).toBe('high');
	expect(defaultEffort(defaults, 'claude-fable-5-1')).toBe('medium');
});

test("Claude: modelSettings for the default model beats the effortLevel", () => {
	const home = tree({ '.claude/settings.json': { model: 'sonnet', effortLevel: 'medium', modelSettings: { 'claude-sonnet-5-5': { effortLevel: 'low' } } } });
	expect(defaultEffort(claudeDefaults(null, home), null)).toBe('low');
});

test("Claude: the folder's settings.json beats the user's, and its settings.local.json beats both", () => {
	const home = tree({ '.claude/settings.json': { model: 'opus', effortLevel: 'medium' } });
	const shared = tree({ '.claude/settings.json': { model: 'sonnet' } });
	expect(claudeDefaults(shared, home)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' });
	const local = tree({ '.claude/settings.json': { model: 'sonnet', effortLevel: 'high' }, '.claude/settings.local.json': { model: 'claude-haiku-5-5' } });
	expect(claudeDefaults(local, home)).toMatchObject({ model: 'claude-haiku-5-5', effort: 'high' });
	const onlyLocal = tree({ '.claude/settings.local.json': { effortLevel: 'low', modelSettings: { opus: { effortLevel: 'xhigh' } } } });
	const layered = claudeDefaults(onlyLocal, home);
	expect(layered).toMatchObject({ model: 'claude-opus-5-5', effort: 'low' });
	expect(defaultEffort(layered, null)).toBe('xhigh');
	// A folder without its own settings is the user's alone.
	expect(claudeDefaults(tree({}), home)).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium' });
});

test('Claude: no settings, settings without the values, or a file that cannot be read give nothing', () => {
	expect(claudeDefaults(null, tree({}))).toEqual({ model: null, effort: null, modelEfforts: {} });
	expect(claudeDefaults(null, tree({ '.claude/settings.json': { theme: 'dark' } }))).toEqual({ model: null, effort: null, modelEfforts: {} });
	const home = tree({ '.claude/settings.json': { model: 'opus', effortLevel: 'medium' } });
	// Broken anywhere: the client may not use the rest as they are, so nothing is guessed.
	expect(claudeDefaults(tree({ '.claude/settings.local.json': '{ not json' }), home)).toEqual({ model: null, effort: null, modelEfforts: {} });
	expect(claudeDefaults(null, tree({ '.claude/settings.json': '[1, 2]' }))).toEqual({ model: null, effort: null, modelEfforts: {} });
	const unreadable = tree({ '.claude/settings.json': '{}' });
	mkdirSync(join(unreadable, '.claude/settings.local.json'));
	expect(claudeDefaults(unreadable, home).model).toBeNull();
});

test("Codex: the config's model and effort, those of the profile it names first", () => {
	expect(codexDefaults(tree({ '.codex/config.toml': 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "medium"\n' }))).toEqual({
		model: 'gpt-6.1-sol',
		effort: 'medium',
		modelEfforts: {}
	});
	const profiled = tree({
		'.codex/config.toml': [
			'profile = "deep"',
			'model = "gpt-6.1-sol"',
			'model_reasoning_effort = "medium"',
			'instructions = """',
			'[profiles.fake]',
			'model = "not-this"',
			'"""',
			'[profiles.deep]',
			'model_reasoning_effort = "xhigh"',
			'[profiles.fast]',
			'model = "gpt-6-astra"'
		].join('\n')
	});
	// The profile's own value first, the top level for what it leaves out.
	expect(codexDefaults(profiled)).toMatchObject({ model: 'gpt-6.1-sol', effort: 'xhigh' });
	expect(codexDefaults(tree({ '.codex/config.toml': 'profile = "fast"\nmodel = "gpt-6.1-sol"\n[profiles.fast]\nmodel = "gpt-6-astra"\n' }))).toMatchObject({
		model: 'gpt-6-astra',
		effort: null
	});
});

test('Codex: no config, one without the values, a profile it does not define, or one that cannot be parsed give nothing', () => {
	const nothing = { model: null, effort: null, modelEfforts: {} };
	expect(codexDefaults(tree({}))).toEqual(nothing);
	expect(codexDefaults(tree({ '.codex/config.toml': 'approval_policy = "never"\n' }))).toEqual(nothing);
	expect(codexDefaults(tree({ '.codex/config.toml': 'profile = "gone"\nmodel = "gpt-6.1-sol"\n' }))).toEqual(nothing);
	expect(codexDefaults(tree({ '.codex/config.toml': 'model = "gpt-6.1-sol\n' }))).toEqual(nothing);
});

test('the command line reads the settings again while none were read, and while a switch waits', () => {
	expect(readsCurrentAgain(null, false)).toBe(true);
	expect(readsCurrentAgain({ model: 'claude-opus-5-5', effort: 'medium', time: '2026-10-20T00:00:00Z' }, false)).toBe(false);
	expect(readsCurrentAgain({ model: 'claude-opus-5-5', effort: 'medium', time: '2026-10-20T00:00:00Z' }, true)).toBe(true);
	// Never read yet: the first read is the one made when the recipient is shown.
	expect(readsCurrentAgain(undefined, false)).toBe(false);
});
