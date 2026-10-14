// Listing the folders under a path for the new-controller folder picker.
import { existsSync, readdirSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrowseEntry, BrowseResult } from '#lib/board/launch.ts';
import { gitRoot } from './git.ts';

/** Whether a directory entry is a folder, following a symbolic link; one pointing at a file or nowhere is not. */
function isFolder(path: string, entry: Dirent): boolean {
	if (!entry.isSymbolicLink()) return entry.isDirectory();
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Whether a folder is in a Git project the way a launch judges it: by its real path, links resolved. */
function inGit(path: string): boolean {
	try {
		return gitRoot(realpathSync(path)) !== null;
	} catch {
		return gitRoot(path) !== null;
	}
}

/** The visible folders directly under an absolute, normalized path, sorted by name. */
export function browse(path = homedir()): BrowseResult {
	const git = inGit(path);
	const result: BrowseResult = {
		path,
		parent: dirname(path) === path ? null : dirname(path),
		home: homedir(),
		git,
		entries: [],
		error: null
	};
	try {
		const entries: BrowseEntry[] = [];
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			if (entry.name.startsWith('.')) continue;
			const child = join(path, entry.name);
			if (!isFolder(child, entry)) continue;
			// A link is judged by where it leads; any other folder is in Git when its parent is or it holds `.git`.
			const childGit = entry.isSymbolicLink() ? inGit(child) : git || existsSync(join(child, '.git'));
			entries.push({ name: entry.name, path: child, git: childGit });
		}
		result.entries = entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	} catch (error) {
		result.error = (error as NodeJS.ErrnoException).code ?? String(error);
	}
	return result;
}
