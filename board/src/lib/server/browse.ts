// The folder box of the new-controller and new-agent forms: the folders under the typed level
// that match what is typed, how the typed folder stands, and creating it when a launch asks for
// one that is not there yet, only ever under the home folder.
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, statSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { nameMatches, typedFolder, typedLevel } from '#lib/board/folder-search.ts';
import type { FolderEntry, FolderSearch, FolderTarget } from '#lib/board/launch.ts';
import { gitRoot } from './git.ts';

/** How many folders one search lists at most. */
const LISTED = 50;

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

/** The nearest path at or above an absolute one that is there (a dangling link counts), and the
 *  levels below it that are not, the topmost first. */
function existingAbove(path: string): { base: string; missing: string[] } {
	const missing: string[] = [];
	for (let level = path; ; level = dirname(level)) {
		try {
			lstatSync(level);
			return { base: level, missing: missing.reverse() };
		} catch {
			missing.push(level);
		}
		if (dirname(level) === level) return { base: level, missing: missing.reverse() };
	}
}

/** Why the board will not create this absolute, normalized folder; null when it will. It is
 *  judged by where the nearest existing folder above it really is, links resolved, so a link
 *  cannot lead out of the home folder. */
export function cannotCreate(path: string): string | null {
	const { base } = existingAbove(path);
	let real: string;
	try {
		real = realpathSync(base);
	} catch {
		return `${base} 讀不到或是指向不存在位置的連結，不能在那裡建立資料夾`;
	}
	if (!statSync(real).isDirectory()) return `${base} 不是資料夾，不能在那裡建立資料夾`;
	let home = homedir();
	try {
		home = realpathSync(home);
	} catch {
		// A home folder that is not there holds nothing to create in either.
	}
	if (real !== home && !real.startsWith(`${home}/`)) return `看板只會在家目錄（${homedir()}）底下建立新資料夾`;
	return null;
}

/** Create a missing folder with the levels above it that are missing too. Resolves with why it
 *  was not created, or null when it was; a failure part way removes the levels this call made. */
export function createFolder(path: string): string | null {
	const refused = cannotCreate(path);
	if (refused) return refused;
	const made: string[] = [];
	try {
		for (const level of existingAbove(path).missing) {
			mkdirSync(level);
			made.push(level);
		}
		return null;
	} catch (error) {
		for (const level of made.reverse()) {
			try {
				rmdirSync(level);
			} catch {
				// Something was put in it meanwhile; it stays.
			}
		}
		return `建立資料夾失敗：${(error as NodeJS.ErrnoException).code ?? String(error)}`;
	}
}

/** How an absolute, normalized folder stands now. */
function folderTarget(path: string): FolderTarget {
	try {
		const folder = statSync(path).isDirectory();
		return { state: folder ? 'folder' : 'not-folder', git: folder && inGit(path), cannotCreate: null };
	} catch {
		const why = cannotCreate(path);
		return { state: 'missing', git: why === null && inGit(existingAbove(path).base), cannotCreate: why };
	}
}

/** What `GET /api/browse?q=` answers; null for text that is not a full path. */
export function searchFolders(input: string): FolderSearch | null {
	const home = homedir();
	const path = typedFolder(input, home);
	const level = typedLevel(input, home);
	if (path === null || level === null) return null;
	const result: FolderSearch = { input, home, path, target: folderTarget(path), entries: [], error: null };
	try {
		const git = inGit(level.dir);
		const part = level.part.toLowerCase();
		const entries: FolderEntry[] = [];
		for (const entry of readdirSync(level.dir, { withFileTypes: true })) {
			if (!nameMatches(entry.name, level.part)) continue;
			const child = join(level.dir, entry.name);
			if (!isFolder(child, entry)) continue;
			// A link is judged by where it leads; any other folder is in Git when its level is or it holds `.git`.
			const childGit = entry.isSymbolicLink() ? inGit(child) : git || existsSync(join(child, '.git'));
			entries.push({ name: entry.name, path: child, git: childGit });
		}
		// Names that start with the typed part first, then by name.
		const rank = (entry: FolderEntry) => (entry.name.toLowerCase().startsWith(part) ? 0 : 1);
		result.entries = entries
			.sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
			.slice(0, LISTED);
	} catch (error) {
		result.error = (error as NodeJS.ErrnoException).code ?? String(error);
	}
	return result;
}
