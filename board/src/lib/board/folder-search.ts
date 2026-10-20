// Searching for a folder as it is typed in the new-controller and new-agent forms: the rules the
// page and the server share. `~` stands for the home folder; matching ignores case.

/** How many folders the box lists before anything is typed. */
export const SUGGESTED = 5;

/** A path with `.`, `..` and repeated or trailing slashes taken out; it must start with `/`. */
export function normalizePath(path: string): string {
	const parts: string[] = [];
	for (const part of path.split('/')) {
		if (part === '' || part === '.') continue;
		if (part === '..') parts.pop();
		else parts.push(part);
	}
	return `/${parts.join('/')}`;
}

/** The typed text with a leading `~` replaced by the home folder; anything else as typed. */
export function expandHome(input: string, home: string): string {
	if (input === '~') return home;
	if (input.startsWith('~/')) return `${home}${input.slice(1)}`;
	return input;
}

/** The folder a typed path names, normalized; null when it is not a full path (`/` or `~` first). */
export function typedFolder(input: string, home: string): string | null {
	const expanded = expandHome(input.trim(), home);
	return expanded.startsWith('/') ? normalizePath(expanded) : null;
}

/**
 * The level a typed path is in and the last part to match there: everything up to the last `/`
 * is the level, so `~/pro` looks in the home folder for `pro`, and `~/projects/` lists the whole
 * of `projects`. Null when it is not a full path.
 */
export function typedLevel(input: string, home: string): { dir: string; part: string } | null {
	const expanded = expandHome(input.trim(), home);
	if (!expanded.startsWith('/')) return null;
	const cut = expanded.lastIndexOf('/');
	return { dir: normalizePath(expanded.slice(0, cut + 1)), part: expanded.slice(cut + 1) };
}

/** Whether a folder's name matches the last typed part. Hidden folders only match a part that
 *  starts with `.`. */
export function nameMatches(name: string, part: string): boolean {
	if (name.startsWith('.') && !part.startsWith('.')) return false;
	return name.toLowerCase().includes(part.toLowerCase());
}

export const folderName = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path;

/** Whether a known folder matches what is typed: its name, or its path, contains the text. */
export function pathMatches(path: string, input: string, home: string): boolean {
	const text = expandHome(input.trim(), home).toLowerCase();
	if (!text) return true;
	return folderName(path).toLowerCase().includes(text) || path.toLowerCase().includes(text);
}

/** The folders listed before anything is typed: for a plain agent its workspace's folders, then
 *  the most recent projects, `SUGGESTED` at most and each once. */
export function suggestedFolders(workspaceFolders: readonly string[], projects: readonly string[]): string[] {
	return [...new Set([...workspaceFolders, ...projects])].slice(0, SUGGESTED);
}
