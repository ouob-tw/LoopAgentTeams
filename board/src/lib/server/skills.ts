// The skills a client can call in a folder, for the hints in the command line and the new form.
// Only skills: none of a client's own commands. Claude Code's built-in skills and those the
// claude.ai account gives are not listed either: they have no files, and only a Claude session
// (which runs its start-up hooks) could list them.
//
// Claude, as Claude Code 2.1 lists them at start: `~/.claude/skills/<dir>/SKILL.md`, then
// `.claude/skills` in the folder and each folder above it up to its Git project's root (up to `/`
// outside one), then the skills of each plugin its settings enable, as `<plugin>:<dir>`, unless Claude
// ignores the plugin's marketplace for not coming from where the user's settings say. A skill is
// called by its folder's name.
//
// Codex is asked itself (`skills/list` of its app server): which of its plugins count, and which
// skills its settings turn off, depends on its own state. Its `system` skills are files it
// installs itself (`~/.codex/skills/.system`), so they are listed too.
import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { firstSentence, type Skill } from '../board/skills.ts';
import { gitRoot } from './git.ts';
import { ownEnv } from './hcom.ts';

/** How long a Codex answer is used again for the same folder. */
const CODEX_KEEP_MS = 60_000;

/** The `description` of a SKILL.md's front matter; empty when it has none. */
export function skillDescription(text: string): string {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
	if (!match) return '';
	const fields: Record<string, string> = {};
	const lines = match[1]!.split(/\r?\n/);
	for (let at = 0; at < lines.length; at++) {
		const field = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[at]!);
		if (!field) continue;
		let value = field[2]!.trim();
		// A block (`|`, `>`) or a plain value going on over indented lines.
		const block = /^[|>][+-]?$/.test(value);
		const more: string[] = [];
		while (at + 1 < lines.length && /^\s+\S|^\s*$/.test(lines[at + 1]!) && !/^[A-Za-z_-]+:/.test(lines[at + 1]!)) more.push(lines[++at]!.trim());
		if (block) value = more.join(value.startsWith('|') ? '\n' : ' ').trim();
		else if (more.length) value = [value, ...more].join(' ').trim();
		if (/^(['"]).*\1$/s.test(value)) value = value.slice(1, -1).replace(value[0] === "'" ? /''/g : /\\"/g, value[0]!);
		fields[field[1]!] = value;
	}
	return fields.description ?? '';
}

const isDir = (path: string) => {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
};

/** The skills in one skills folder, each named by its folder (with `prefix` before it). */
function skillsIn(folder: string, prefix = ''): Skill[] {
	let entries: string[];
	try {
		entries = readdirSync(folder);
	} catch {
		return [];
	}
	const skills: Skill[] = [];
	for (const entry of entries.sort()) {
		if (entry.startsWith('.') || !isDir(join(folder, entry))) continue;
		let text: string;
		try {
			text = readFileSync(join(folder, entry, 'SKILL.md'), 'utf8');
		} catch {
			continue;
		}
		skills.push({ name: `${prefix}${entry}`, summary: firstSentence(skillDescription(text)) });
	}
	return skills;
}

/** A JSON file's contents; null when it is not there or cannot be read. */
function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return null;
	}
}

const isTable = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The plugins Claude's settings turn on for the folder, the folder's own settings beating the user's. */
function claudePlugins(folder: string | null, home: string): string[] {
	const paths = [join(home, '.claude/settings.json')];
	if (folder) paths.push(join(folder, '.claude/settings.json'), join(folder, '.claude/settings.local.json'));
	const enabled: Record<string, boolean> = {};
	for (const path of paths) {
		const settings = readJson(path);
		if (!isTable(settings) || !isTable(settings.enabledPlugins)) continue;
		for (const [key, on] of Object.entries(settings.enabledPlugins)) enabled[key] = on === true;
	}
	return Object.keys(enabled).filter((key) => enabled[key]);
}

/** The same JSON value, whatever the order of its keys. */
const sameJson = (a: unknown, b: unknown): boolean => {
	const sorted = (value: unknown): unknown =>
		Array.isArray(value) ? value.map(sorted) : isTable(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value;
	return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
};

/** Whether Claude ignores this marketplace: the user's settings name it with another source than
 *  the one it was added from (`claude plugin list` says "added but ignored"). */
function ignoredMarketplace(market: string, home: string): boolean {
	const settings = readJson(join(home, '.claude/settings.json'));
	const wanted = isTable(settings) && isTable(settings.extraKnownMarketplaces) ? settings.extraKnownMarketplaces[market] : undefined;
	if (!isTable(wanted)) return false;
	const known = readJson(join(home, '.claude/plugins/known_marketplaces.json'));
	const added = isTable(known) ? known[market] : undefined;
	return !isTable(added) || !sameJson(wanted.source, added.source);
}

/** Each skill once, the first one found kept. */
function once(skills: Skill[]): Skill[] {
	const seen = new Set<string>();
	return skills.filter((skill) => !seen.has(skill.name) && !!seen.add(skill.name));
}

/** The skills Claude can call in the folder (absolute; the user's alone when null). */
export function claudeSkills(folder: string | null, home = homedir()): Skill[] {
	const skills = skillsIn(join(home, '.claude/skills'));
	if (folder) {
		const root = gitRoot(folder);
		for (let path = folder; ; path = dirname(path)) {
			skills.push(...skillsIn(join(path, '.claude/skills')));
			if (path === root || dirname(path) === path) break;
		}
	}
	const installed = readJson(join(home, '.claude/plugins/installed_plugins.json'));
	const plugins = isTable(installed) && isTable(installed.plugins) ? installed.plugins : {};
	for (const key of claudePlugins(folder, home)) {
		const copies = plugins[key];
		if (!Array.isArray(copies) || ignoredMarketplace(key.split('@')[1] ?? '', home)) continue;
		const copy = copies.find((entry) => isTable(entry) && (entry.scope === 'user' || (folder !== null && entry.projectPath === folder)));
		if (isTable(copy) && typeof copy.installPath === 'string') skills.push(...skillsIn(join(copy.installPath, 'skills'), `${key.split('@')[0]}:`));
	}
	return once(skills);
}

/** End a Codex app server and everything it started. */
function end(child: ChildProcess): void {
	try {
		process.kill(-child.pid!, 'SIGKILL');
	} catch {
		// Already gone.
	}
}

/** The skills Codex turns on for the folder, as its app server lists them; null when it could not
 *  be asked or did not answer in time. */
export function askCodex(command: string[], folder: string, timeoutMs: number): Promise<Skill[] | null> {
	const [program, ...args] = command;
	return new Promise((resolve) => {
		let child: ChildProcess;
		try {
			child = spawn(program!, args, { cwd: tmpdir(), env: ownEnv(), detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
		} catch {
			return resolve(null);
		}
		let settled = false;
		const finish = (skills: Skill[] | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			end(child);
			resolve(skills);
		};
		const timer = setTimeout(() => finish(null), timeoutMs);
		child.on('error', () => finish(null));
		child.on('close', () => finish(null));
		child.stdin!.on('error', () => finish(null));
		const write = (message: object) => child.stdin!.write(JSON.stringify(message) + '\n');
		createInterface({ input: child.stdout! }).on('line', (line) => {
			let message: { id?: number; method?: string; result?: { data?: { skills?: { name?: unknown; description?: unknown; enabled?: unknown }[] }[] } };
			try {
				message = JSON.parse(line);
			} catch {
				return finish(null);
			}
			if (message.method !== undefined) return;
			if (message.id === 1) {
				write({ method: 'initialized' });
				write({ id: 2, method: 'skills/list', params: { cwds: [folder] } });
			} else if (message.id === 2) {
				const listed = message.result?.data?.[0]?.skills;
				if (!Array.isArray(listed)) return finish(null);
				const skills = listed
					.filter((skill) => skill.enabled !== false && typeof skill.name === 'string' && skill.name)
					.map((skill) => ({ name: skill.name as string, summary: firstSentence(typeof skill.description === 'string' ? skill.description : '') }));
				finish(once(skills));
			}
		});
		write({ id: 1, method: 'initialize', params: { clientInfo: { name: 'lat-board', title: 'LAT 看板', version: '1' }, capabilities: null } });
	});
}

/** Codex's answers by folder, kept a while: the app server takes a moment to start. */
const asked = new Map<string, { at: number; skills: Promise<Skill[] | null> }>();

/** The skills Codex turns on for the folder, asked again once the last answer is old. A failed
 *  ask is not kept. */
export function codexSkills(command: string[], folder: string, timeoutMs: number, now = Date.now()): Promise<Skill[] | null> {
	const kept = asked.get(folder);
	if (kept && now - kept.at < CODEX_KEEP_MS) return kept.skills;
	const skills = askCodex(command, folder, timeoutMs);
	asked.set(folder, { at: now, skills });
	void skills.then((answer) => {
		if (answer === null && asked.get(folder)?.skills === skills) asked.delete(folder);
	});
	return skills;
}
