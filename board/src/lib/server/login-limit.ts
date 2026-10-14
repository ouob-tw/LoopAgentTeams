// Wrong-password limit per source address, kept in memory: a restart of the board clears it.
export const MAX_FAILURES = 5;

interface Source {
	failures: number;
	lockedUntil: number;
}

export interface LoginLimit {
	/** Seconds the source still has to wait, or 0 when it may try now. Counts the attempt. */
	begin(source: string): number;
	/** The attempt failed; returns the seconds to wait when this failure locked the source, else 0. */
	failed(source: string): number;
	succeeded(source: string): void;
	/** The password could not be checked at all: the attempt does not count. */
	uncounted(source: string): void;
}

export function createLoginLimit(lockMs: number, now: () => number = Date.now): LoginLimit {
	const sources = new Map<string, Source>();
	const waitSeconds = (until: number) => Math.max(1, Math.ceil((until - now()) / 1000));

	function lock(entry: Source): number {
		entry.failures = 0;
		entry.lockedUntil = now() + lockMs;
		return waitSeconds(entry.lockedUntil);
	}

	return {
		begin(source) {
			const entry = sources.get(source) ?? { failures: 0, lockedUntil: 0 };
			sources.set(source, entry);
			if (entry.lockedUntil > now()) return waitSeconds(entry.lockedUntil);
			// Attempts still being checked count too, so sending many at once gets no more tries.
			if (++entry.failures > MAX_FAILURES) return lock(entry);
			return 0;
		},
		failed(source) {
			const entry = sources.get(source);
			if (!entry || entry.lockedUntil > now()) return entry ? waitSeconds(entry.lockedUntil) : 0;
			return entry.failures >= MAX_FAILURES ? lock(entry) : 0;
		},
		succeeded(source) {
			sources.delete(source);
		},
		uncounted(source) {
			const entry = sources.get(source);
			if (entry && entry.failures > 0) entry.failures--;
		}
	};
}
