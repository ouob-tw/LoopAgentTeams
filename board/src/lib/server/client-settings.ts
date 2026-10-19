// What a client started without a model or effort argument uses, read from its own settings files,
// so the launch forms can name it instead of just saying "the default". Only the files: no
// environment variables, no Codex project settings, no managed settings.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import type { ClientDefaults, LaunchDefaults } from '../board/models.ts';

/** The models Claude Code's aliases stand for, as its `/model` lists them. */
const CLAUDE_ALIASES: Record<string, string> = {
	opus: 'claude-opus-5-5',
	sonnet: 'claude-sonnet-5-5',
	haiku: 'claude-haiku-5-5',
	fable: 'claude-fable-5-1'
};

/** A model as Claude names it, an alias as the model it stands for: `opus` and `opus[1m]` as
 *  `claude-opus-5-5` and `claude-opus-5-5[1m]`. */
export function claudeModel(name: string): string {
	const alias = /^([a-z]+)(\[[^\]]*\])?$/.exec(name);
	return alias && CLAUDE_ALIASES[alias[1]] ? CLAUDE_ALIASES[alias[1]] + (alias[2] ?? '') : name;
}

const none = (): ClientDefaults => ({ model: null, effort: null, modelEfforts: {} });

const isTable = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown) => (typeof value === 'string' && value ? value : null);

/** A settings file's contents; null when there is none, undefined when it cannot be read or parsed. */
function readSettings(path: string, parseText: (text: string) => unknown): Record<string, unknown> | null | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, 'utf8');
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
	}
	try {
		const parsed = parseText(raw);
		return isTable(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Claude's: the user's `~/.claude/settings.json`, then the folder's `.claude/settings.json` and
 * `.claude/settings.local.json`, each later one beating the ones before. One that is there but
 * cannot be read leaves every value unknown: the client may not use the others as they are.
 */
export function claudeDefaults(folder: string | null, home = homedir()): ClientDefaults {
	const paths = [join(home, '.claude/settings.json')];
	if (folder) paths.push(join(folder, '.claude/settings.json'), join(folder, '.claude/settings.local.json'));
	const result = none();
	for (const path of paths) {
		const settings = readSettings(path, JSON.parse);
		if (settings === undefined) return none();
		if (settings === null) continue;
		const model = text(settings.model);
		if (model) result.model = claudeModel(model);
		result.effort = text(settings.effortLevel) ?? result.effort;
		if (isTable(settings.modelSettings)) {
			for (const [name, entry] of Object.entries(settings.modelSettings)) {
				const effort = isTable(entry) ? text(entry.effortLevel) : null;
				if (effort) result.modelEfforts[claudeModel(name)] = effort;
			}
		}
	}
	return result;
}

/**
 * Codex's: `model` and `model_reasoning_effort` of `~/.codex/config.toml`, those of the profile
 * its top-level `profile` names first. A profile it names but does not define leaves both unknown:
 * Codex will not start with it.
 */
export function codexDefaults(home = homedir()): ClientDefaults {
	const config = readSettings(join(home, '.codex/config.toml'), parse);
	if (!config) return none();
	const name = text(config.profile);
	const profiles = isTable(config.profiles) ? config.profiles : {};
	const profile = name === null ? {} : profiles[name];
	if (!isTable(profile)) return none();
	return {
		model: text(profile.model) ?? text(config.model),
		effort: text(profile.model_reasoning_effort) ?? text(config.model_reasoning_effort),
		modelEfforts: {}
	};
}

/** Both clients' defaults for a launch in this folder (the user's settings only when null). */
export const launchDefaults = (folder: string | null, home = homedir()): LaunchDefaults => ({
	claude: claudeDefaults(folder, home),
	codex: codexDefaults(home)
});
