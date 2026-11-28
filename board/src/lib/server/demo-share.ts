// The demos shared without the board's login: anyone with such a demo's address can read its files,
// and only that (GET and HEAD under `<name>/`; hooks.server.ts, demo-site.ts). Every other demo
// still needs the login. A share holds for the very folder that was published when it was turned
// on (demoFolderId): `demo.py` deletes old demos and names get reused, so a page published later
// under a shared name, or the same page published again, is not shared until someone turns it on.
// Board state, shared by every logged-in device, kept as one file in the board's state directory.
// It is read at each request that needs it, so a change takes effect at once.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { demoFolderId, demoName, isDemoName, listDemos } from './demo.ts';

const FILE = 'demo-share.json';

/** Shared demo name → the folder it was shared as. */
type Shares = Map<string, string>;

/** The shares as saved; none when there is no file or it holds nothing usable: a file that cannot
 *  be read keeps every demo behind the login. */
function loadShares(stateDir: string): Shares {
	try {
		const shared = (JSON.parse(readFileSync(join(stateDir, FILE), 'utf8')) as { shared?: unknown } | null)?.shared;
		const shares: Shares = new Map();
		if (Array.isArray(shared))
			for (const entry of shared as { name?: unknown; folder?: unknown }[])
				if (isDemoName(entry?.name) && typeof entry.folder === 'string') shares.set(entry.name, entry.folder);
		return shares;
	} catch {
		return new Map();
	}
}

function saveShares(stateDir: string, shares: Shares): void {
	const path = join(stateDir, FILE);
	const temporary = `${path}.${process.pid}.tmp`;
	const shared = [...shares].sort(([a], [b]) => a.localeCompare(b)).map(([name, folder]) => ({ name, folder }));
	writeFileSync(temporary, JSON.stringify({ shared }) + '\n', { mode: 0o600 });
	renameSync(temporary, path);
}

/** Whether a share is in force: the demo's folder is still the one that was shared. */
const inForce = (siteDir: string, name: string, folder: string | undefined) => folder !== undefined && demoFolderId(siteDir, name) === folder;

/** The names shared right now. */
function sharedNow(stateDir: string, siteDir: string): Set<string> {
	return new Set([...loadShares(stateDir)].filter(([name, folder]) => inForce(siteDir, name, folder)).map(([name]) => name));
}

/** Whether `rest` (as the address has it, after the demo base) is inside a shared demo. */
export function isSharedDemo(stateDir: string, siteDir: string, rest: string): boolean {
	const name = demoName(rest);
	if (name === null) return false;
	return inForce(siteDir, name, loadShares(stateDir).get(name));
}

/** Each published demo with whether it is shared: shared ones first, then the newest. */
export function sharedDemoList(stateDir: string, siteDir: string): { name: string; shared: boolean }[] {
	const shared = sharedNow(stateDir, siteDir);
	const listed = listDemos(siteDir);
	return [...listed.filter((name) => shared.has(name)), ...listed.filter((name) => !shared.has(name))].map((name) => ({ name, shared: shared.has(name) }));
}

/** Share the demo `name` as it is published now, or stop sharing it. `as` pins the share to a
 *  folder (demoFolderId) the caller read before checking that version; a folder put in place since
 *  is then not shared. Shares no longer in force (their folder gone or replaced) are dropped at
 *  each change. False, with nothing written, when sharing a demo that is not published. Throws
 *  when the file cannot be written. */
export function setDemoShared(stateDir: string, siteDir: string, name: string, shared: boolean, as?: string | null): boolean {
	const shares: Shares = new Map([...loadShares(stateDir)].filter(([each, folder]) => inForce(siteDir, each, folder)));
	if (shared) {
		const folder = as === undefined ? demoFolderId(siteDir, name) : as;
		if (folder === null) return false;
		shares.set(name, folder);
	} else shares.delete(name);
	saveShares(stateDir, shares);
	return true;
}
