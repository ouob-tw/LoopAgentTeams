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

/** How the line reads: each part spelt out in Chinese, or short as the status line has it. */
export const USAGE_STYLES = ['detailed', 'compact'] as const;
export type UsageStyle = (typeof USAGE_STYLES)[number];

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

/** A quota window's length in words: 300 minutes is `5 小時`, 10080 is `7 天`. */
export function windowLabel(minutes: number): string {
	if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
	if (minutes % 60 === 0) return `${minutes / 60} 小時`;
	return `${minutes} 分鐘`;
}

/** The same, short as the status line has it: 300 minutes is `5h`, 10080 is `7d`. */
function windowShort(minutes: number): string {
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
	auto: '自動模式',
	default: '手動確認',
	acceptEdits: '自動接受修改',
	plan: '規劃模式',
	dontAsk: '不再詢問',
	bypassPermissions: '免確認'
};
/** The same by the names Claude Code gives them, for the compact line. */
const MODES_SHORT: Record<string, string> = {
	auto: 'Auto mode',
	default: 'Manual',
	acceptEdits: 'Accept edits',
	plan: 'Plan mode',
	dontAsk: "Don't ask",
	bypassPermissions: 'Bypass permissions'
};

/** Codex's approval policies and sandboxes in words; one not listed is shown as it is. */
const APPROVALS: Record<string, string> = {
	untrusted: '不信任的指令才詢問',
	'on-failure': '失敗時才詢問',
	'on-request': '需要時才詢問',
	never: '從不詢問'
};
const SANDBOXES: Record<string, string> = {
	'read-only': '唯讀',
	'workspace-write': '可寫入工作區',
	'danger-full-access': '不受限'
};
const named = (names: Record<string, string>, key: string) => (Object.hasOwn(names, key) ? names[key] : key);

/**
 * The permission in words, short for the line and long for the tip: a Claude mode by its name in
 * `MODES` (an unknown one as it is), a Codex one as `需要時才詢問` and
 * `需要時才詢問，檔案權限：可寫入工作區`; in the compact style, short only, by `MODES_SHORT` and as
 * `approval on-request`. Bypass is Claude's `bypassPermissions` or Codex never asking with full access.
 */
function permissionText(
	permission: NonNullable<Usage['permission']>,
	style: UsageStyle = 'detailed'
): { short: string; long: string; bypass: boolean } {
	const modes = style === 'compact' ? MODES_SHORT : MODES;
	if ('mode' in permission) {
		const name = named(modes, permission.mode);
		return { short: name, long: name, bypass: permission.mode === 'bypassPermissions' };
	}
	if (permission.approval === 'never' && permission.sandbox === 'danger-full-access') {
		return { short: modes.bypassPermissions, long: modes.bypassPermissions, bypass: true };
	}
	if (style === 'compact') {
		const short = `approval ${permission.approval}`;
		return { short, long: short, bypass: false };
	}
	const short = named(APPROVALS, permission.approval);
	return {
		short,
		long: permission.sandbox === null ? short : `${short}，檔案權限：${named(SANDBOXES, permission.sandbox)}`,
		bypass: false
	};
}

/** The percent of a quota left above which a window of that length is left off the line. */
const SAFE_LEFT: Record<number, number> = { 300: 45, 10080: 30 };

/**
 * The line's parts at `now`, e.g. `上下文已用 62%`, `5 小時額度剩 40%`, `快取命中 70%`, `20 分鐘後失效`
 * (until it expires, joined to the cache). Yellow from 80% context used, under 20% of a quota left and
 * 5 minutes or less of cache left; an expired cache in the alarm colour. A cold cache shows as
 * `快取尚未建立`, without hit or expiry. A part in its safe range is left off: context under 55% used,
 * over 45% of the 5-hour or 30% of the 7-day quota left (other windows always show), a cache hit over
 * 80%, over 30 minutes of cache left, bypass permissions; a countdown shown without its hit carries
 * the cache's name itself (`快取 20 分鐘後失效`, `快取已失效`). A cold or expired cache always shows. The
 * permission comes last, e.g. `權限：自動模式`. With `all`, nothing is left off.
 *
 * The compact style leaves off and colours the same parts, short as the status line has them:
 * `Ctx 62%`, `5h 40%`, `Cache 70%`, `⏳ 20 min` (always joined to a `Cache` part, which a countdown
 * shown without its hit keeps as its label), `⏳ expired`, `Cache cold`, and the permission by
 * itself, e.g. `Auto mode` or `approval on-request`.
 */
export function usageParts(
	usage: Usage,
	now: number,
	{ all = false, style = 'detailed' }: { all?: boolean; style?: UsageStyle } = {}
): UsagePart[] {
	const compact = style === 'compact';
	const parts: UsagePart[] = [];
	if (usage.context !== null) {
		const used = rounded(usage.context);
		if (all || used >= 55) parts.push({ text: compact ? `Ctx ${used}%` : `上下文已用 ${used}%`, level: used >= 80 ? 'warn' : 'normal' });
	}
	for (const limit of usage.limits.toSorted((a, b) => a.minutes - b.minutes)) {
		const left = rounded(Math.max(0, 100 - limit.used));
		if (!all && left > (SAFE_LEFT[limit.minutes] ?? Infinity)) continue;
		parts.push({
			text: compact ? `${windowShort(limit.minutes)} ${left}%` : `${windowLabel(limit.minutes)}額度剩 ${left}%`,
			level: left < 20 ? 'warn' : 'normal'
		});
	}
	const cache = usage.cache;
	if (cache && !cache.warm) parts.push({ text: compact ? 'Cache cold' : '快取尚未建立', level: 'normal' });
	else if (cache) {
		const hit = cache.hit !== null ? Math.round(cache.hit * 100) : null;
		const hitShown = hit !== null && (all || hit <= 80);
		// Whole minutes left, as the status line counts them.
		const minutes = cache.expires !== null ? Math.floor((cache.expires - now) / 60_000) : null;
		const expired = cache.expires !== null && cache.expires <= now;
		const countdownShown = minutes !== null && (all || expired || minutes <= 30);
		if (compact && (hitShown || countdownShown)) parts.push({ text: hitShown ? `Cache ${hit}%` : 'Cache', level: 'normal' });
		else if (hitShown) parts.push({ text: `快取命中 ${hit}%`, level: 'normal' });
		if (countdownShown) {
			const level = expired ? 'danger' : minutes! <= 5 ? 'warn' : 'normal';
			if (compact) parts.push({ text: expired ? '⏳ expired' : `⏳ ${minutes} min`, level, joined: true });
			else {
				const text = expired ? '已失效' : `${minutes} 分鐘後失效`;
				parts.push({ text: hitShown ? text : expired ? `快取${text}` : `快取 ${text}`, level, joined: hitShown });
			}
		}
	}
	if (usage.permission) {
		const permission = permissionText(usage.permission, style);
		if (all || !permission.bypass) parts.push({ text: compact ? permission.short : `權限：${permission.short}`, level: 'normal' });
	}
	return parts;
}

/**
 * The same at `now`, one line each, for the line's info tip: spelt out in the detailed style
 * (`上下文已用 42%`, `5 小時額度剩 63%`, `快取命中 97%`, `快取 38 分鐘後失效`, `權限：自動模式`; a cold cache as
 * `快取尚未建立`, an expired one as `快取已失效`), short in the compact style, the line's own wording with
 * nothing left off (`Ctx 42%`, `5h 63%`, `Cache 97% ⏳ 38 min`, `Cache cold`, `Auto mode`).
 */
export function usageDetails(usage: Usage, now: number, style: UsageStyle = 'detailed'): string[] {
	if (style === 'compact') {
		const lines: string[] = [];
		for (const part of usageParts(usage, now, { all: true, style })) {
			if (part.joined && lines.length) lines[lines.length - 1] += ` ${part.text}`;
			else lines.push(part.text);
		}
		return lines;
	}
	const lines: string[] = [];
	if (usage.context !== null) lines.push(`上下文已用 ${rounded(usage.context)}%`);
	for (const limit of usage.limits.toSorted((a, b) => a.minutes - b.minutes)) {
		lines.push(`${windowLabel(limit.minutes)}額度剩 ${rounded(Math.max(0, 100 - limit.used))}%`);
	}
	const cache = usage.cache;
	if (cache && !cache.warm) lines.push('快取尚未建立');
	else if (cache) {
		if (cache.hit !== null) lines.push(`快取命中 ${Math.round(cache.hit * 100)}%`);
		if (cache.expires !== null) {
			lines.push(cache.expires <= now ? '快取已失效' : `快取 ${Math.floor((cache.expires - now) / 60_000)} 分鐘後失效`);
		}
	}
	if (usage.permission) lines.push(`權限：${permissionText(usage.permission).long}`);
	return lines;
}
