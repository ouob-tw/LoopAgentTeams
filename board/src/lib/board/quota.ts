// The 額度 tab's data: every Claude and Codex account with its quota windows, as the server last
// read them from claude-swap's cached list and codex-multi-auth's files, and how the tab words them.
// Only these fields ever reach a page: no token, no account file text.

export type QuotaClient = 'claude' | 'codex';

/** One quota window: 5 小時, 7 天, or a model's own. */
export interface QuotaWindow {
	label: string;
	/** Percent used, 0–100; null when nothing was recorded for it. */
	used: number | null;
	/** When it resets, in milliseconds; null when not known. */
	resetsAt: number | null;
}

export interface QuotaPlan {
	label: string;
	/** `live`: current (Claude's account in use, whose plan claude-swap recorded when switching to it;
	 *  Codex's, recorded with each usage reading); `recorded`: only as last seen in use (Claude's
	 *  other accounts). */
	source: 'live' | 'recorded';
	observedAt: number | null;
}

export interface QuotaAccount {
	email: string;
	current: boolean;
	/** null when no plan was ever recorded: 方案未知. */
	plan: QuotaPlan | null;
	/** Empty when no usage was ever recorded: 沒有紀錄. */
	windows: QuotaWindow[];
	/** When the windows were read, in milliseconds; null without any. */
	observedAt: number | null;
	/** Why the account has no windows, when that is not simply no record. */
	note?: string;
}

export type QuotaGroup = { ok: true; accounts: QuotaAccount[] } | { ok: false; reason: string };

export interface QuotaSnapshot {
	/** When the server read the sources. */
	readAt: number;
	claude: QuotaGroup;
	codex: QuotaGroup;
}

/** Past this age a reading's time turns yellow. */
export const STALE_MS: Record<QuotaClient, number> = { claude: 3 * 60_000, codex: 15 * 60_000 };

export const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The account in use first, the others in their own order. */
export const ordered = (accounts: QuotaAccount[]) => [...accounts.filter((account) => account.current), ...accounts.filter((account) => !account.current)];

/** The time a group's header shows: the account in use's reading, or with none in use the newest. */
export function groupObservedAt(accounts: QuotaAccount[]): number | null {
	const current = accounts.find((account) => account.current);
	if (current) return current.observedAt;
	const times = accounts.flatMap((account) => (account.observedAt === null ? [] : [account.observedAt]));
	return times.length ? Math.max(...times) : null;
}

export const isStale = (at: number | null, now: number, client: QuotaClient) => at !== null && now - at > STALE_MS[client];

/** How long ago, in the largest whole unit: 剛剛, 5 分鐘前, 2 小時前, 3 天前. */
export function agoText(at: number, now: number): string {
	const age = Math.max(0, now - at);
	if (age < MINUTE) return '剛剛';
	if (age < HOUR) return `${Math.floor(age / MINUTE)} 分鐘前`;
	if (age < DAY) return `${Math.floor(age / HOUR)} 小時前`;
	return `${Math.floor(age / DAY)} 天前`;
}

export const updatedText = (at: number | null, now: number) => (at === null ? '沒有紀錄' : `${agoText(at, now)}更新`);

/** What is left of a window, 0–100: 100 − used. */
export const remaining = (used: number) => Math.min(100, Math.max(0, 100 - used));

/** 20% left and under is a warning, 5% left and under the danger color. */
export const level = (left: number) => (left <= 5 ? 'danger' : left <= 20 ? 'warn' : null);

/** 剩 N%; N rounds the used percent as before, so 81.5 used reads 剩 18%, not 剩 19%. */
export const percentText = (used: number) => `剩 ${100 - Math.round(Math.min(100, Math.max(0, used)))}%`;

/** A window whose reset has passed: its number is the last window's, not this one's. */
export const waiting = (window: QuotaWindow, now: number) => window.resetsAt !== null && window.resetsAt <= now;

/** When a window resets, on the clock: today's time alone, another day's with its date. */
export function resetText(resetsAt: number, now: number): string {
	const at = new Date(resetsAt);
	const time = at.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
	const sameDay = new Date(now).toDateString() === at.toDateString();
	return `${sameDay ? time : `${at.getMonth() + 1}/${at.getDate()} ${time}`} 重置`;
}

/** The plan as the card shows it: faded with its age when only recorded; null (nothing shown) when unknown. */
export function planView(plan: QuotaPlan | null, now: number): { text: string; recorded: boolean; title?: string } | null {
	if (!plan) return null;
	if (plan.source === 'live') return { text: plan.label, recorded: false };
	const days = plan.observedAt === null ? null : Math.floor(Math.max(0, now - plan.observedAt) / DAY);
	return {
		text: plan.label,
		recorded: true,
		title: `上次使用時記錄${days === null ? '' : days === 0 ? '（今天）' : `（${days} 天前）`}`
	};
}
