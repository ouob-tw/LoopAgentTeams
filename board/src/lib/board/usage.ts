// A controller's context use, subscription quota and prompt cache, the way its status line shows
// them: the shape the server sends, and the one line the information page makes of it.

/** What one controller's latest turn left: any part may be missing. */
export interface Usage {
	/** Percent of the context window used. */
	context: number | null;
	/** Each quota window, by its length in minutes, and the percent of it used. */
	limits: { minutes: number; used: number }[];
	/** The prompt cache; `hit` is a ratio from 0 to 1, `expires` a time in milliseconds. */
	cache: { warm: boolean; hit: number | null; expires: number | null } | null;
}

/** One part of the line; `level` colours it. */
export interface UsagePart {
	text: string;
	level: 'normal' | 'warn' | 'danger';
}

const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** A usage as received, or null when it is not one or holds nothing to show. */
export function usageFrom(value: unknown): Usage | null {
	if (typeof value !== 'object' || value === null) return null;
	const given = value as Record<string, unknown>;
	const limits = Array.isArray(given.limits)
		? given.limits.filter((limit): limit is Usage['limits'][number] => number(limit?.minutes) && limit.minutes > 0 && number(limit?.used))
		: [];
	const cache = given.cache as Record<string, unknown> | null | undefined;
	const usage: Usage = {
		context: number(given.context) ? given.context : null,
		limits,
		cache:
			typeof cache?.warm === 'boolean'
				? { warm: cache.warm, hit: number(cache.hit) ? cache.hit : null, expires: number(cache.expires) ? cache.expires : null }
				: null
	};
	return usage.context !== null || usage.limits.length || usage.cache ? usage : null;
}

/** A quota window's name by its length: 300 minutes is `5h`, 10080 is `7d`. */
export function windowLabel(minutes: number): string {
	if (minutes % 1440 === 0) return `${minutes / 1440}d`;
	if (minutes % 60 === 0) return `${minutes / 60}h`;
	return `${minutes}m`;
}

/** Rounded as the status line's `printf '%.0f'` does: an exact half goes to the even number. */
function rounded(value: number): number {
	const whole = Math.round(value);
	return Math.abs(value % 1) === 0.5 && whole % 2 !== 0 ? whole - 1 : whole;
}

/**
 * The line's parts at `now`, e.g. `Ctx 42% used`, `5h 剩 63%`, `快取 命中 97%`, `38 分後過期`.
 * Yellow from 80% context used, under 20% of a quota left and 5 minutes or less of cache left; an
 * expired cache in the alarm colour. A cold cache shows as `快取 冷`, without hit or expiry.
 */
export function usageParts(usage: Usage, now: number): UsagePart[] {
	const parts: UsagePart[] = [];
	if (usage.context !== null) {
		const used = rounded(usage.context);
		parts.push({ text: `Ctx ${used}% used`, level: used >= 80 ? 'warn' : 'normal' });
	}
	for (const limit of usage.limits.toSorted((a, b) => a.minutes - b.minutes)) {
		const left = rounded(Math.max(0, 100 - limit.used));
		parts.push({ text: `${windowLabel(limit.minutes)} 剩 ${left}%`, level: left < 20 ? 'warn' : 'normal' });
	}
	const cache = usage.cache;
	if (cache && !cache.warm) parts.push({ text: '快取 冷', level: 'normal' });
	else if (cache) {
		if (cache.hit !== null) parts.push({ text: `快取 命中 ${Math.round(cache.hit * 100)}%`, level: 'normal' });
		if (cache.expires !== null) {
			// Whole minutes left, as the status line counts them.
			const minutes = Math.floor((cache.expires - now) / 60_000);
			if (cache.expires <= now) parts.push({ text: '已過期', level: 'danger' });
			else parts.push({ text: `${minutes} 分後過期`, level: minutes <= 5 ? 'warn' : 'normal' });
		}
	}
	return parts;
}
