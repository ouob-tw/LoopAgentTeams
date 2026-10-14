// Whether a folder is in a Git project, found the way LAT itself finds a workspace root: the
// nearest folder up the tree that holds a `.git` entry (a directory, or a file in a worktree).
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runExternal } from './external.ts';

const GIT_INIT_TIMEOUT_MS = 30_000;

/** The Git project root that holds this absolute folder, or null when there is none. */
export function gitRoot(folder: string): string | null {
	for (let path = folder; ; path = dirname(path)) {
		if (existsSync(join(path, '.git'))) return path;
		if (dirname(path) === path) return null;
	}
}

/** Run `git init` once in the folder. Resolves with why it failed, or null when it succeeded. */
export async function gitInit(folder: string): Promise<string | null> {
	const result = await runExternal(['git'], ['init'], { timeoutMs: GIT_INIT_TIMEOUT_MS, cwd: folder });
	return result.failure;
}
