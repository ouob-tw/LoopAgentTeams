// The demos shared without the board's login: anyone with such a demo's address can read its files,
// and only that (GET and HEAD under `<name>/`; hooks.server.ts, demo-site.ts). Every other demo
// still needs the login. Board state, shared by every logged-in device, kept as one file in the
// board's state directory. It is read at each request that needs it, so a change takes effect at once.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { demoName, isDemoName } from './demo.ts';

const FILE = 'demo-share.json';

/** The shared demos' names; none when there is no file or it holds nothing usable: a file that
 *  cannot be read keeps every demo behind the login. */
export function loadSharedDemos(stateDir: string): Set<string> {
	try {
		const names = (JSON.parse(readFileSync(join(stateDir, FILE), 'utf8')) as { shared?: unknown } | null)?.shared;
		return new Set(Array.isArray(names) ? names.filter(isDemoName) : []);
	} catch {
		return new Set();
	}
}

export function saveSharedDemos(stateDir: string, names: Iterable<string>): void {
	const path = join(stateDir, FILE);
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify({ shared: [...names].sort() }) + '\n', { mode: 0o600 });
	renameSync(temporary, path);
}

/** Whether `rest` (as the address has it, after the demo base) is inside a shared demo. */
export function isSharedDemo(stateDir: string, rest: string): boolean {
	const name = demoName(rest);
	return name !== null && loadSharedDemos(stateDir).has(name);
}
