// Wrong-password limit per source address. The counts and locks are kept in the board's state
// directory, so a restart does not clear them; attempts still being checked live in memory only.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_FAILURES = 5;
// Past this many sources a new one makes room by forgetting the oldest that are neither locked nor
// mid-check; locked ones stay, so the list can briefly grow beyond it.
const MAX_SOURCES = 10_000;

interface Source {
	/** Wrong passwords since the last right one or the last lock. */
	failures: number;
	/** Attempts admitted and still being checked. */
	pending: number;
	lockedUntil: number;
}

/** What is kept of a source across restarts. */
export interface StoredSource {
	failures: number;
	lockedUntil: number;
}

/** Where the counts are kept between restarts. */
export interface LimitStore {
	load(): Record<string, StoredSource>;
	save(sources: Record<string, StoredSource>): void;
}

export const LOGIN_LIMIT_FILE = 'login-limit.json';

/** The counts as a file in the board's state directory, readable by its owner only. A file that
 *  cannot be read starts the counts afresh, as a restart did before they were kept. */
export function fileStore(stateDir: string): LimitStore {
	const path = join(stateDir, LOGIN_LIMIT_FILE);
	return {
		load() {
			try {
				const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
				return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, StoredSource>) : {};
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`看板登入鎖定紀錄讀不出來，從頭計算：${(error as Error).message}`);
				return {};
			}
		},
		save(sources) {
			mkdirSync(stateDir, { recursive: true, mode: 0o700 });
			const temporary = `${path}.${process.pid}.tmp`;
			writeFileSync(temporary, JSON.stringify(sources) + '\n', { mode: 0o600 });
			renameSync(temporary, path);
		}
	};
}

/** Each attempt is admitted first and then ends in exactly one of the other three calls. Every call
 *  returns the seconds the source has to wait, or 0. */
export interface LoginLimit {
	/** May this attempt be checked? A source that would go past 5 tries with those still being
	 *  checked is locked here, so sending many at once gets no more tries. */
	admit(source: string): number;
	/** The password was wrong; the fifth in a row locks the source. */
	failed(source: string): number;
	/** The password was right. Still refused when other attempts locked the source meanwhile.
	 *  Clears the source's count: a login with a later step calls it only once every step passed,
	 *  and ends a step that passed short of that with `refund`. */
	succeeded(source: string): number;
	/** The password could not be checked at all: the attempt does not count. */
	refund(source: string): void;
}

/** `onLock` hears of each lock as it starts, once per lock. */
export function createLoginLimit(lockMs: number, now: () => number = Date.now, store?: LimitStore, onLock?: (source: string) => void): LoginLimit {
	const sources = new Map<string, Source>();
	const waitSeconds = (entry: Source) =>
		entry.lockedUntil > now() ? Math.max(1, Math.ceil((entry.lockedUntil - now()) / 1000)) : 0;

	for (const [source, kept] of Object.entries(store?.load() ?? {})) {
		const failures = Number.isInteger(kept?.failures) && kept.failures > 0 ? Math.min(kept.failures, MAX_FAILURES) : 0;
		const lockedUntil = Number.isFinite(kept?.lockedUntil) ? kept.lockedUntil : 0;
		const entry = { failures, pending: 0, lockedUntil };
		if (failures || waitSeconds(entry)) sources.set(source, entry);
	}

	/** Keep what a restart must not forget: every source with wrong passwords or a lock. */
	function save(): void {
		if (!store) return;
		const kept: Record<string, StoredSource> = {};
		for (const [source, { failures, lockedUntil }] of sources) {
			if (failures || waitSeconds({ failures, pending: 0, lockedUntil })) kept[source] = { failures, lockedUntil };
		}
		store.save(kept);
	}

	function lock(source: string, entry: Source): number {
		entry.failures = 0;
		entry.lockedUntil = now() + lockMs;
		save();
		onLock?.(source);
		return waitSeconds(entry);
	}

	function entryFor(source: string): Source {
		let entry = sources.get(source);
		if (entry) return entry;
		if (sources.size >= MAX_SOURCES) {
			for (const [key, old] of sources) {
				if (sources.size < MAX_SOURCES) break;
				if (!old.pending && !waitSeconds(old)) sources.delete(key);
			}
		}
		entry = { failures: 0, pending: 0, lockedUntil: 0 };
		sources.set(source, entry);
		return entry;
	}

	/** Ends one admitted attempt. */
	function settle(source: string): Source {
		const entry = sources.get(source);
		if (!entry) throw new Error('a login attempt ended that was never admitted');
		entry.pending = Math.max(0, entry.pending - 1);
		return entry;
	}

	/** Forgets the source once nothing about it is left to remember. */
	function forgetIfClear(source: string, entry: Source): void {
		if (!entry.failures && !entry.pending && !waitSeconds(entry)) sources.delete(source);
	}

	return {
		admit(source) {
			const entry = entryFor(source);
			const wait = waitSeconds(entry);
			if (wait) return wait;
			if (entry.failures + entry.pending >= MAX_FAILURES) return lock(source, entry);
			entry.pending++;
			return 0;
		},
		failed(source) {
			const entry = settle(source);
			const wait = waitSeconds(entry);
			if (wait) return wait;
			if (++entry.failures >= MAX_FAILURES) return lock(source, entry);
			save();
			return 0;
		},
		succeeded(source) {
			const entry = settle(source);
			const wait = waitSeconds(entry);
			if (wait) return wait;
			const had = entry.failures;
			entry.failures = 0;
			forgetIfClear(source, entry);
			if (had) save();
			return 0;
		},
		refund(source) {
			forgetIfClear(source, settle(source));
		}
	};
}
