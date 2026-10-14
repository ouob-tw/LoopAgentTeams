// Wrong-password limit per source address, kept in memory: a restart of the board clears it.
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

/** Each attempt is admitted first and then ends in exactly one of the other three calls. Every call
 *  returns the seconds the source has to wait, or 0. */
export interface LoginLimit {
	/** May this attempt be checked? A source that would go past 5 tries with those still being
	 *  checked is locked here, so sending many at once gets no more tries. */
	admit(source: string): number;
	/** The password was wrong; the fifth in a row locks the source. */
	failed(source: string): number;
	/** The password was right. Still refused when other attempts locked the source meanwhile. */
	succeeded(source: string): number;
	/** The password could not be checked at all: the attempt does not count. */
	refund(source: string): void;
}

export function createLoginLimit(lockMs: number, now: () => number = Date.now): LoginLimit {
	const sources = new Map<string, Source>();
	const waitSeconds = (entry: Source) =>
		entry.lockedUntil > now() ? Math.max(1, Math.ceil((entry.lockedUntil - now()) / 1000)) : 0;

	function lock(entry: Source): number {
		entry.failures = 0;
		entry.lockedUntil = now() + lockMs;
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
			if (entry.failures + entry.pending >= MAX_FAILURES) return lock(entry);
			entry.pending++;
			return 0;
		},
		failed(source) {
			const entry = settle(source);
			const wait = waitSeconds(entry);
			if (wait) return wait;
			return ++entry.failures >= MAX_FAILURES ? lock(entry) : 0;
		},
		succeeded(source) {
			const entry = settle(source);
			const wait = waitSeconds(entry);
			if (wait) return wait;
			entry.failures = 0;
			forgetIfClear(source, entry);
			return 0;
		},
		refund(source) {
			forgetIfClear(source, settle(source));
		}
	};
}
