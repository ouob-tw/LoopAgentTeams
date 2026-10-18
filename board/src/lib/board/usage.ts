// A controller's context use, subscription quota and prompt cache, the way its status line shows
// them, and its permission mode: the shape the server sends, and the one line the information page
// makes of it.

/** What one controller's latest turn left: any part may be missing. */
export interface Usage {
	/** Percent of the context window used. */
	context: number | null;
	/** Each quota window, by its length in minutes, and the percent of it used. */
	limits: { minutes: number; used: number }[];
	/** The prompt cache; `hit` is a ratio from 0 to 1, `expires` a time in milliseconds. */
	cache: { warm: boolean; hit: number | null; expires: number | null } | null;
	/** As of the latest turn: a Claude permission mode, or a Codex approval policy and sandbox. */
	permission: { mode: string } | { approval: string; sandbox: string | null } | null;
}

/** One part of the line; `level` colours it, and a `joined` part follows the one before it without a dot. */
export interface UsagePart {
	text: string;
	level: 'normal' | 'warn' | 'danger';
	joined?: boolean;
}

const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const text = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** A usage as received, or null when it is not one or holds nothing to show. */
export function usageFrom(value: unknown): Usage | null {
	if (typeof value !== 'object' || value === null) return null;
	const given = value as Record<string, unknown>;
	const limits = Array.isArray(given.limits)
		? given.limits.filter((limit): limit is Usage['limits'][number] => number(limit?.minutes) && limit.minutes > 0 && number(limit?.used))
		: [];
	const cache = given.cache as Record<string, unknown> | null | undefined;
	const permission = given.permission as Record<string, unknown> | null | undefined;
	const usage: Usage = {
		context: number(given.context) ? given.context : null,
		limits,
		cache:
			typeof cache?.warm === 'boolean'
				? { warm: cache.warm, hit: number(cache.hit) ? cache.hit : null, expires: number(cache.expires) ? cache.expires : null }
				: null,
		permission: text(permission?.mode)
			? { mode: permission.mode }
			: text(permission?.approval)
				? { approval: permission.approval, sandbox: text(permission.sandbox) ? permission.sandbox : null }
				: null
	};
	return usage.context !== null || usage.limits.length || usage.cache || usage.permission ? usage : null;
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

const MODES: Record<string, string> = {
	auto: 'Auto mode',
	default: 'Manual',
	acceptEdits: 'Accept edits',
	plan: 'Plan mode',
	dontAsk: "Don't ask",
	bypassPermissions: 'Bypass permissions'
};

/**
 * The permission in words, short for the line and long for the tip: a Claude mode by its name in
 * `MODES` (an unknown one as it is), a Codex one as `approval on-request` and
 * `approval on-request, sandbox workspace-write`. Bypass is Claude's `bypassPermissions` or Codex
 * never asking with full access.
 */
function permissionText(permission: NonNullable<Usage['permission']>): { short: string; long: string; bypass: boolean } {
	if ('mode' in permission) {
		const name = Object.hasOwn(MODES, permission.mode) ? MODES[permission.mode] : permission.mode;
		return { short: name, long: name, bypass: permission.mode === 'bypassPermissions' };
	}
	if (permission.approval === 'never' && permission.sandbox === 'danger-full-access') {
		return { short: MODES.bypassPermissions, long: MODES.bypassPermissions, bypass: true };
	}
	const short = `approval ${permission.approval}`;
	return { short, long: permission.sandbox === null ? short : `${short}, sandbox ${permission.sandbox}`, bypass: false };
}

/** The percent of a quota left above which a window of that length is left off the line. */
const SAFE_LEFT: Record<number, number> = { 300: 45, 10080: 30 };

/**
 * The line's parts at `now`, e.g. `Ctx 62%`, `5h 40%` (left), `Cache 70%`, `⏳ 20 min` (until it expires,
 * joined to the cache). Yellow from 80% context used, under 20% of a quota left and 5 minutes or less
 * of cache left; an expired cache in the alarm colour. A cold cache shows as `Cache cold`, without hit
 * or expiry. A part in its safe range is left off: context under 55% used, over 45% of the 5h or 30%
 * of the 7d quota left (other windows always show), a cache hit over 80%, over 30 minutes of cache
 * left, bypass permissions; a countdown shown without its hit keeps the `Cache` label. A cold or
 * expired cache always shows. The permission mode comes last, e.g. `Auto mode`. With `all`, nothing
 * is left off.
 */
export function usageParts(usage: Usage, now: number, all = false): UsagePart[] {
	const parts: UsagePart[] = [];
	if (usage.context !== null) {
		const used = rounded(usage.context);
		if (all || used >= 55) parts.push({ text: `Ctx ${used}%`, level: used >= 80 ? 'warn' : 'normal' });
	}
	for (const limit of usage.limits.toSorted((a, b) => a.minutes - b.minutes)) {
		const left = rounded(Math.max(0, 100 - limit.used));
		if (!all && left > (SAFE_LEFT[limit.minutes] ?? Infinity)) continue;
		parts.push({ text: `${windowLabel(limit.minutes)} ${left}%`, level: left < 20 ? 'warn' : 'normal' });
	}
	const cache = usage.cache;
	if (cache && !cache.warm) parts.push({ text: 'Cache cold', level: 'normal' });
	else if (cache) {
		const hit = cache.hit !== null ? Math.round(cache.hit * 100) : null;
		const hitShown = hit !== null && (all || hit <= 80);
		// Whole minutes left, as the status line counts them.
		const minutes = cache.expires !== null ? Math.floor((cache.expires - now) / 60_000) : null;
		const expired = cache.expires !== null && cache.expires <= now;
		const countdownShown = minutes !== null && (all || expired || minutes <= 30);
		if (hitShown || countdownShown) parts.push({ text: hitShown ? `Cache ${hit}%` : 'Cache', level: 'normal' });
		if (countdownShown) {
			if (expired) parts.push({ text: '⏳ expired', level: 'danger', joined: true });
			else parts.push({ text: `⏳ ${minutes} min`, level: minutes <= 5 ? 'warn' : 'normal', joined: true });
		}
	}
	if (usage.permission) {
		const permission = permissionText(usage.permission);
		if (all || !permission.bypass) parts.push({ text: permission.short, level: 'normal' });
	}
	return parts;
}

/**
 * The same at `now` spelt out, one line each, for the line's info tip: `Context 42% used`, `5h 63%`,
 * `Cache hit 97%`, `expires in 38 min`, `Permission: Auto mode`; a cold cache as `Cache cold`, an
 * expired one as `Cache expired`.
 */
export function usageDetails(usage: Usage, now: number): string[] {
	const lines: string[] = [];
	if (usage.context !== null) lines.push(`Context ${rounded(usage.context)}% used`);
	for (const limit of usage.limits.toSorted((a, b) => a.minutes - b.minutes)) {
		lines.push(`${windowLabel(limit.minutes)} ${rounded(Math.max(0, 100 - limit.used))}%`);
	}
	const cache = usage.cache;
	if (cache && !cache.warm) lines.push('Cache cold');
	else if (cache) {
		if (cache.hit !== null) lines.push(`Cache hit ${Math.round(cache.hit * 100)}%`);
		if (cache.expires !== null) {
			lines.push(cache.expires <= now ? 'Cache expired' : `expires in ${Math.floor((cache.expires - now) / 60_000)} min`);
		}
	}
	if (usage.permission) lines.push(`Permission: ${permissionText(usage.permission).long}`);
	return lines;
}
