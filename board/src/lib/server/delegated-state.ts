// Which delegated decision cards the user has opened (#663): board state, shared by every
// logged-in device, kept as one file in the board's state directory as inbox.json is.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = 'delegated-seen.json';
/** A seen mark older than this belongs to a round long over; it is dropped at the next write. */
const KEEP_MS = 60 * 24 * 60 * 60 * 1000;

/** Card key (`seenKey`) → when it was opened. */
export type DelegatedSeen = Record<string, string>;

const isTimes = (value: unknown): value is DelegatedSeen =>
	typeof value === 'object' &&
	value !== null &&
	!Array.isArray(value) &&
	Object.values(value).every((time) => typeof time === 'string' && !Number.isNaN(Date.parse(time)));

/** Throws when the file exists but cannot be used: starting over would show every card again. */
export function loadDelegatedSeen(stateDir: string): DelegatedSeen {
	const path = join(stateDir, FILE);
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
		throw error;
	}
	const parsed = JSON.parse(text) as { seen?: unknown } | null;
	if (!isTimes(parsed?.seen)) throw new Error(`${path} 的格式不正確`);
	return parsed.seen;
}

/** Mark one card seen now; throws when the file cannot be read or written. */
export function markDelegatedSeen(stateDir: string, key: string, now: number): DelegatedSeen {
	const seen = loadDelegatedSeen(stateDir);
	const kept = Object.fromEntries(Object.entries(seen).filter(([, time]) => now - Date.parse(time) < KEEP_MS));
	kept[key] = new Date(now).toISOString();
	const path = join(stateDir, FILE);
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify({ seen: kept }, null, 2) + '\n', { mode: 0o600 });
	renameSync(temporary, path);
	return kept;
}
