// Whether an agent task's client trusts the task's folder, read from the client's own settings file
// and never written (#703). A run in a folder its client has not trusted stops at the client's
// trust question until its time limit. The rules follow the clients themselves:
// - Claude Code (2.1.331): `projects[<folder>].hasTrustDialogAccepted` in `~/.claude.json`, for the
//   folder or any folder above it up to its git repository's root (every folder up to `/` outside a
//   repository), or for the repository's main checkout when the folder is in a worktree.
// - Codex: `[projects."<folder>"] trust_level` in `~/.codex/config.toml`, for the folder, its
//   repository's root or the main checkout. A folder with any recorded answer is not asked again,
//   so only "no answer at all" warns; a trusted folder further up, which Codex is not known to
//   honour, counts as "cannot tell" rather than warn falsely.
// A settings file that is missing or cannot be read or parsed is "cannot tell": no warning.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parse } from 'smol-toml';
import type { AgentClient } from '../board/automation.ts';

export type FolderTrust = 'trusted' | 'untrusted' | 'unknown';

/** The clients' settings files: Claude's `.claude.json` and Codex's `config.toml`. */
export interface TrustFiles {
	claude: string;
	codex: string;
}

const isTable = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The folder and every folder above it, nearest first, ending at `/`. */
function upwards(folder: string): string[] {
	const list = [folder];
	for (let at = folder; dirname(at) !== at; at = dirname(at)) list.push(dirname(at));
	return list;
}

const exists = (path: string) => {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
};

/** The nearest folder at or above `folder` holding a `.git` folder or file; null outside a repository. */
function gitRoot(folder: string): string | null {
	return upwards(folder).find((at) => exists(join(at, '.git'))) ?? null;
}

/** A worktree's main checkout: `.git` is a file naming the worktree's git folder, whose `commondir`
 *  names the main `.git`. Null when `root` is not a worktree or it cannot be followed. */
function mainCheckout(root: string): string | null {
	try {
		const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(root, '.git'), 'utf8'))?.[1]?.trim();
		if (!pointer) return null;
		const gitDir = resolve(root, pointer);
		const common = resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim());
		return basename(common) === '.git' ? dirname(common) : null;
	} catch {
		return null;
	}
}

/** The folder as written and as the system resolves it: a client started there may see either. */
function spellings(folder: string): string[] {
	const full = resolve(folder);
	try {
		const real = realpathSync(full);
		return real === full ? [full] : [full, real];
	} catch {
		return [full];
	}
}

/** The folders, by spelling, whose answer the client takes for `folder`: `[folder, …up to the repository root]`,
 *  the root and the main checkout. */
function lookedAt(folder: string): { chain: string[]; root: string | null; main: string | null }[] {
	return spellings(folder).map((at) => {
		const root = gitRoot(at);
		const all = upwards(at);
		const chain = root === null ? all : all.slice(0, all.indexOf(root) + 1);
		return { chain, root, main: root === null ? null : mainCheckout(root) };
	});
}

interface Cached {
	key: string;
	projects: Record<string, unknown> | undefined;
}

/**
 * The check, with each settings file parsed again only when its size or time changed: Claude's file
 * is large and the list is built on every change and every minute.
 */
export function createFolderTrust(files: TrustFiles): (client: AgentClient, folder: string) => FolderTrust {
	const cache = new Map<string, Cached>();

	/** The file's `projects` table; undefined when the file is missing or cannot be read or parsed. */
	function projectsOf(path: string, parseText: (text: string) => unknown): Record<string, unknown> | undefined {
		let key: string;
		try {
			const stat = statSync(path);
			key = `${stat.size}:${stat.mtimeMs}`;
		} catch {
			cache.delete(path);
			return undefined;
		}
		const cached = cache.get(path);
		if (cached?.key === key) return cached.projects;
		let projects: Record<string, unknown> | undefined;
		try {
			const parsed = parseText(readFileSync(path, 'utf8'));
			projects = isTable(parsed) ? (isTable(parsed.projects) ? parsed.projects : {}) : undefined;
		} catch {
			projects = undefined;
		}
		cache.set(path, { key, projects });
		return projects;
	}

	function claude(folder: string): FolderTrust {
		const projects = projectsOf(files.claude, JSON.parse);
		if (!projects) return 'unknown';
		const accepted = (at: string | null) => at !== null && isTable(projects[at]) && projects[at].hasTrustDialogAccepted === true;
		return lookedAt(folder).some(({ chain, main }) => accepted(main) || chain.some(accepted)) ? 'trusted' : 'untrusted';
	}

	function codex(folder: string): FolderTrust {
		const projects = projectsOf(files.codex, parse);
		if (!projects) return 'unknown';
		const level = (at: string | null) => (at !== null && isTable(projects[at]) ? projects[at].trust_level : undefined);
		const places = lookedAt(folder);
		const known = places.flatMap(({ chain, root, main }) => [chain[0], root, main]);
		if (known.some((at) => level(at) === 'trusted')) return 'trusted';
		// Any other recorded answer: Codex does not ask again.
		if (known.some((at) => level(at) !== undefined)) return 'unknown';
		// A trusted folder further up: Codex is not known to honour it, nor known not to.
		if (places.some(({ chain }) => upwards(chain[0]).some((at) => level(at) === 'trusted'))) return 'unknown';
		return 'untrusted';
	}

	return (client, folder) => {
		if (!isAbsolute(folder)) return 'unknown';
		try {
			return client === 'claude' ? claude(folder) : codex(folder);
		} catch {
			return 'unknown';
		}
	};
}
