// Listing the folders under a path for the new-controller folder picker.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrowseEntry, BrowseResult } from '#lib/board/launch.ts';
import { gitRoot } from './git.ts';

/** Whether a directory entry is a folder, following a symbolic link; one pointing at a file or nowhere is not. */
function isFolder(path: string, symlink: boolean, directory: boolean): boolean {
	if (!symlink) return directory;
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** The visible folders directly under an absolute, normalized path, sorted by name. */
export function browse(path: string): BrowseResult {
	const git = gitRoot(path) !== null;
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
			if (!isFolder(child, entry.isSymbolicLink(), entry.isDirectory())) continue;
			entries.push({ name: entry.name, path: child, git: git || existsSync(join(child, '.git')) });
		}
		result.entries = entries.sort((a, b) => a.name.localeCompare(b.name));
	} catch (error) {
		result.error = (error as NodeJS.ErrnoException).code ?? String(error);
	}
	return result;
}
