// What the helper last printed for an ended controller, kept while the files it was read from stay
// the same: a full read then asks the helper only for the bound controllers and for what changed,
// not again for every session that still has a report file (#687).
import { statSync } from 'node:fs';

/** How long an entry is kept at most: some of what the helper prints comes from outside the files
 *  it is checked against (git, the tracker's settings, the panel journal), so even an entry whose
 *  files did not change is read again after a while. Each entry gets a time between half of this
 *  and all of it, so they do not all expire in the same read. */
export const CACHE_MAX_AGE_MS = 10 * 60_000;

/** A file changed this close to the start of the read, or after it, may have changed while the
 *  helper read it, so what it printed is not kept. */
const CHANGE_SLACK_MS = 1_000;

/** A file's size and change time, or null when it is not there. */
function stat(path: string): { size: number; mtimeMs: number } | null {
	try {
		return statSync(path);
	} catch {
		return null;
	}
}

const stampOf = (info: { size: number; mtimeMs: number } | null) => (info ? `${info.size}:${info.mtimeMs}` : '-');
const stamps = (files: string[]) => files.map((path) => stampOf(stat(path))).join('\n');

interface Entry<V> {
	value: V;
	files: string[];
	stamps: string;
	expires: number;
}

export interface FileCache<V> {
	/** The kept value, when every file it was read from is as it was then and it has not expired. */
	get(key: string, now: number): V | undefined;
	/** Keep `value`, read from `files` by a read that started at `startedAt` (real clock). A file may
	 *  be missing: one that appears later changes the stamp. Nothing is kept when a file changed
	 *  around or after `startedAt`. */
	set(key: string, value: V, files: string[], startedAt: number, maxAgeMs?: number): void;
	/** Forget every entry whose key is not in `keys`: its session is no longer read. */
	keepOnly(keys: Iterable<string>): void;
	readonly size: number;
}

export function createFileCache<V>(maxAgeMs = CACHE_MAX_AGE_MS, random: () => number = Math.random): FileCache<V> {
	const entries = new Map<string, Entry<V>>();
	return {
		get(key, now) {
			const entry = entries.get(key);
			if (!entry) return undefined;
			if (now >= entry.expires || stamps(entry.files) !== entry.stamps) {
				entries.delete(key);
				return undefined;
			}
			return entry.value;
		},
		set(key, value, files, startedAt, ownMaxAgeMs = maxAgeMs) {
			entries.delete(key);
			if (ownMaxAgeMs <= 0) return;
			const infos = files.map(stat);
			if (infos.some((info) => info && info.mtimeMs > startedAt - CHANGE_SLACK_MS)) return;
			entries.set(key, { value, files, stamps: infos.map(stampOf).join('\n'), expires: startedAt + ownMaxAgeMs * (0.5 + random() / 2) });
		},
		keepOnly(keys) {
			const kept = new Set(keys);
			for (const key of entries.keys()) if (!kept.has(key)) entries.delete(key);
		},
		get size() {
			return entries.size;
		}
	};
}
