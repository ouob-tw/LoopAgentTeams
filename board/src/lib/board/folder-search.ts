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

/** What a key pressed in the folder box does to its list of `count` rows: the list open or
 *  closed, the row the arrows are on (-1 for none), the row taken as the folder (`choose`), or
 *  the row whose path goes into the box to look one level down (`complete`); `handled` keeps the
 *  key from doing anything else, such as sending the form. A row the list no longer has counts as
 *  none. */
export function listKey(
	key: string,
	shift: boolean,
	list: { open: boolean; active: number; count: number }
): { open: boolean; active: number; choose: number | null; complete: number | null; handled: boolean } {
	const { open, count } = list;
	const active = list.active < count ? list.active : -1;
	const none = { open, active, choose: null, complete: null, handled: false };
	if (key === 'ArrowDown' || key === 'ArrowUp') {
		if (!open) return { ...none, open: true, handled: true };
		if (!count) return { ...none, handled: true };
		const next = key === 'ArrowDown' ? (active + 1) % count : active <= 0 ? count - 1 : active - 1;
		return { ...none, active: next, handled: true };
	}
	if (key === 'Tab' && !shift && open && count) return { ...none, active: -1, complete: Math.max(active, 0), handled: true };
	if (key === 'Enter') return { ...none, open: false, active: -1, choose: open && active >= 0 ? active : null, handled: true };
	if (key === 'Escape' && open) return { ...none, open: false, active: -1, handled: true };
	return none;
}

/** Run a search each time the box changes, where an answer counts only when no later search has
 *  begun meanwhile: an earlier one that comes back last is not `current`. */
export function latestOnly<T, R>(run: (input: T) => Promise<R>): (input: T) => Promise<{ current: boolean; value: R }> {
	let begun = 0;
	return async (input) => {
		const mine = ++begun;
		const value = await run(input);
		return { current: mine === begun, value };
	};
}

/** The search answer the box shows: only the one for the text now in it. */
export const shownSearch = <S extends { input: string }>(search: S | null, input: string): S | null => (search?.input === input ? search : null);
