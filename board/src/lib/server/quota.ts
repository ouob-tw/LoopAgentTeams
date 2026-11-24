// The accounts' quotas for the 額度 tab, read on a timer and shared by every page. Claude's come
// from claude-swap's cached list, which reads its own files only and never goes online. Codex's
// come from CPA (CLIProxyAPI), which pools the Codex accounts: its management API lists them, and
// asks ChatGPT for each one's usage with the token it holds, so the board sends CPA its management
// key and nothing else, and no token ever reaches the board. Only the fields of board/quota.ts are
// kept from either source: no key, token, host path or upstream text leaves this module, and
// nothing here writes a log.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { QuotaAccount, QuotaGroup, QuotaSnapshot, QuotaState, QuotaWindow } from '../board/quota.ts';
import { runCommand } from './external.ts';

type Env = Record<string, string | undefined>;
type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const time = (value: unknown) => {
	if (typeof value !== 'string') return null;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? null : parsed;
};

/** A window's name by its length. */
function windowLabel(minutes: number): string {
	if (minutes === 7 * 24 * 60) return '7 天';
	if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} 天`;
	if (minutes % 60 === 0) return `${minutes / 60} 小時`;
	return `${minutes} 分鐘`;
}

/** A version as a reason may show it: a number, nothing taken from a file's text. */
const versionText = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : '不明');

/** ChatGPT's plan IDs the tab names; any other text from CPA or ChatGPT is not shown. */
const PLAN_LABELS: Record<string, string> = {
	free: 'Free',
	go: 'Go',
	plus: 'Plus',
	pro: 'Pro',
	prolite: 'Pro Lite',
	team: 'Team',
	business: 'Business',
	enterprise: 'Enterprise',
	edu: 'Edu'
};
const planLabel = (value: unknown) => (typeof value === 'string' && Object.hasOwn(PLAN_LABELS, value) ? PLAN_LABELS[value] : null);

// CPA's management API, v8 layout. The host pins CPA v8.1.2, which serves both /v0/management and
// /v8/management; v8 is the layout its docs build on (v0 is kept for old clients, near deprecation)
// and the one its config file already uses, and its credentials list has every runtime field the
// tab reads. Checked against that CPA's real answers (ouob-tw/LoopAgentTeams-work#711): `status` of a healthy credential is
// `active` (the docs' examples say `ready`), and ChatGPT's usage endpoint answers with
// `rate_limit.primary_window` / `secondary_window`, each `used_percent`, `limit_window_seconds` and
// `reset_at` in seconds; a plan with one window (Pro Lite: 7 days) has `secondary_window: null`.
const CREDENTIALS_PATH = '/v8/management/credentials';
const API_CALL_PATH = '/v8/management/requests/api-call';
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

/** Each account's usage is asked of ChatGPT at most this often; between, its last answer stands. */
export const CODEX_USAGE_INTERVAL_MS = 5 * 60_000;
const CPA_TIMEOUT_MS = 15_000;

/** What the Codex group says when CPA cannot be read: fixed words, never a path, key or CPA's text. */
export const CPA_REASONS = {
	unset: 'CPA 未設定',
	keyFile: 'CPA 金鑰檔讀不到',
	unreachable: 'CPA 連不上',
	rejected: 'CPA 金鑰被拒',
	remoteOff: 'CPA 未開放遠端管理',
	garbled: 'CPA 回應看不懂'
} as const;

/** A management request CPA answered 403: remote management off, or the key refused (banned). */
const forbidden = (body: unknown) => (isRecord(body) && body.error === 'remote management disabled' ? CPA_REASONS.remoteOff : CPA_REASONS.rejected);

/** The `status` values of a credential CPA routes to. */
export const CPA_READY_STATUSES = new Set(['active', 'ready']);

/** How CPA routes a credential, and why not when it does not, in the board's fixed words. */
export function cpaState(row: Json): QuotaState {
	const status = text(row.status)?.toLowerCase() ?? null;
	if (row.disabled === true || status === 'disabled') return { kind: 'disabled' };
	const cooling = row.unavailable === true || (status !== null && !CPA_READY_STATUSES.has(status));
	// Available only when the list says so in full: a missing or odd field leaves it unknown.
	if (!cooling) return status !== null && row.disabled === false && row.unavailable === false ? { kind: 'ready' } : { kind: 'unknown' };
	const note =
		row.requires_sign_in === true
			? '需要重新登入'
			: row.quota_blocked === true
				? '額度用完'
				: status === 'refreshing' || status === 'pending'
					? '正在更新登入'
					: status === 'error'
						? '上次請求出錯'
						: '暫停使用';
	return { kind: 'cooling', note };
}

/** A usage window with every field the tab shows; null when one is missing or not a number. */
function usageWindow(value: unknown): QuotaWindow | null {
	if (!isRecord(value)) return null;
	const used = number(value.used_percent);
	const seconds = number(value.limit_window_seconds);
	const resetAt = number(value.reset_at);
	if (used === null || seconds === null || seconds <= 0 || resetAt === null) return null;
	return { label: windowLabel(seconds / 60), used, resetsAt: resetAt * 1000 };
}

/** The windows ChatGPT's usage answer has; null when it is not one. The second window may be
 *  `null` (a plan with one window); missing or malformed, the whole answer is unreadable. */
function parseUsage(body: unknown): { windows: QuotaWindow[]; plan: string | null } | null {
	if (!isRecord(body) || !isRecord(body.rate_limit)) return null;
	const primary = usageWindow(body.rate_limit.primary_window);
	if (!primary) return null;
	if (body.rate_limit.secondary_window === null) return { windows: [primary], plan: planLabel(body.plan_type) };
	const secondary = usageWindow(body.rate_limit.secondary_window);
	return secondary ? { windows: [primary, secondary], plan: planLabel(body.plan_type) } : null;
}

interface UsageMemory {
	/** When ChatGPT was last asked for this account's usage, whatever came of it. */
	askedAt: number;
	failed: boolean;
	good: { windows: QuotaWindow[]; plan: string | null; observedAt: number } | null;
	/** When CPA's list last had the account. An account left out for a while keeps its memory, so
	 *  coming back within 5 minutes is not asked again and keeps its last good numbers. */
	listedAt: number;
}

/** How long an account CPA no longer lists is remembered. */
const FORGET_AFTER_MS = 24 * 60 * 60_000;

/** What one usage ask came to: the windows, a failure of that account alone, or a management
 *  refusal that stops the whole group. */
type UsageRead = { ok: true; usage: { windows: QuotaWindow[]; plan: string | null } } | { ok: false; refusal?: string };

interface CpaSettings {
	/** The management API's base, as `http://127.0.0.1:8317`; null when not set. */
	url: string | null;
	/** The file holding the management key alone; null when not set. */
	keyFile: string | null;
}

type Answer = { ok: true; status: number; body: unknown } | { ok: false };

/** The Codex group from CPA. Keeps each account's last good usage, so a failed read shows it with
 *  its time; asks ChatGPT for an account at most every CODEX_USAGE_INTERVAL_MS. A key CPA refused
 *  is not sent again until the key file changes: five refusals in a row ban the host for 30 minutes. */
export function createCodexQuotaReader(settings: CpaSettings, options: { now(): number; fetch?: typeof fetch }): () => Promise<QuotaGroup> {
	const send = options.fetch ?? fetch;
	const usage = new Map<string, UsageMemory>();
	let refused: string | null = null;

	async function ask(base: string, key: string, path: string, body?: unknown): Promise<Answer> {
		try {
			const response = await send(base + path, {
				method: body === undefined ? 'GET' : 'POST',
				headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(CPA_TIMEOUT_MS)
			});
			const raw = await response.text();
			let parsed: unknown = null;
			try {
				parsed = JSON.parse(raw);
			} catch {
				// Left null: only the status counts.
			}
			return { ok: true, status: response.status, body: parsed };
		} catch {
			return { ok: false };
		}
	}

	/** One account's usage through CPA's api-call. CPA refusing the management request itself
	 *  (401, 403) stops the group; 401 also marks the key refused. ChatGPT's own status is the
	 *  account's alone. */
	async function readUsage(base: string, key: string, row: Json, authIndex: string, keyHash: string): Promise<UsageRead> {
		const idToken = isRecord(row.id_token) ? row.id_token : {};
		const accountId = text(idToken.chatgpt_account_id);
		const answer = await ask(base, key, API_CALL_PATH, {
			auth_index: authIndex,
			method: 'GET',
			url: USAGE_URL,
			// CPA puts the account's own token in place of $TOKEN$; the board never sees it.
			header: { Authorization: 'Bearer $TOKEN$', Accept: 'application/json', ...(accountId ? { 'Chatgpt-Account-Id': accountId } : {}) }
		});
		if (!answer.ok) return { ok: false };
		if (answer.status === 401) {
			refused = keyHash;
			return { ok: false, refusal: CPA_REASONS.rejected };
		}
		if (answer.status === 403) return { ok: false, refusal: forbidden(answer.body) };
		if (answer.status !== 200 || !isRecord(answer.body) || answer.body.status_code !== 200 || typeof answer.body.body !== 'string') return { ok: false };
		let usage: ReturnType<typeof parseUsage> = null;
		try {
			usage = parseUsage(JSON.parse(answer.body.body));
		} catch {
			// Not JSON: unreadable.
		}
		return usage ? { ok: true, usage } : { ok: false };
	}

	return async function readCodex(): Promise<QuotaGroup> {
		if (!settings.url || !settings.keyFile) return { ok: false, reason: CPA_REASONS.unset };
		let key: string;
		try {
			key = (await readFile(settings.keyFile, 'utf8')).split('\n')[0].trim();
		} catch {
			return { ok: false, reason: CPA_REASONS.keyFile };
		}
		if (!key) return { ok: false, reason: CPA_REASONS.keyFile };
		const keyHash = createHash('sha256').update(key).digest('hex');
		if (refused === keyHash) return { ok: false, reason: CPA_REASONS.rejected };
		const base = settings.url.replace(/\/+$/, '');
		const list = await ask(base, key, CREDENTIALS_PATH);
		if (!list.ok) return { ok: false, reason: CPA_REASONS.unreachable };
		if (list.status === 401) {
			refused = keyHash;
			return { ok: false, reason: CPA_REASONS.rejected };
		}
		// Not counted toward CPA's ban: tried again at the next read.
		if (list.status === 403) return { ok: false, reason: forbidden(list.body) };
		if (list.status !== 200 || !isRecord(list.body) || !Array.isArray(list.body.files)) return { ok: false, reason: CPA_REASONS.garbled };
		refused = null;
		const rows = list.body.files.filter((row): row is Json => isRecord(row) && (row.provider === 'codex' || row.type === 'codex'));
		const now = options.now();
		const accounts: QuotaAccount[] = [];
		for (const row of rows) {
			const authIndex = text(row.auth_index);
			let memory = authIndex ? usage.get(authIndex) : undefined;
			if (authIndex) {
				if (!memory || now - memory.askedAt >= CODEX_USAGE_INTERVAL_MS) {
					const read = await readUsage(base, key, row, authIndex, keyHash);
					if (read.ok === false && read.refusal) return { ok: false, reason: read.refusal };
					memory = { askedAt: now, failed: !read.ok, good: read.ok ? { ...read.usage, observedAt: now } : (memory?.good ?? null), listedAt: now };
				}
				memory.listedAt = now;
				usage.set(authIndex, memory);
			}
			const good = memory?.good ?? null;
			const idToken = isRecord(row.id_token) ? row.id_token : {};
			const plan = planLabel(idToken.plan_type) ?? good?.plan ?? null;
			accounts.push({
				email: text(row.email) ?? '（沒有 email）',
				// CPA pools the accounts: none is the one in use.
				current: false,
				plan: plan ? { label: plan, source: 'live', observedAt: now } : null,
				windows: good?.windows ?? [],
				observedAt: good?.observedAt ?? null,
				state: cpaState(row),
				...(!memory || memory.failed ? { unreadable: true as const } : {})
			});
		}
		for (const [id, memory] of usage) if (now - memory.listedAt > FORGET_AFTER_MS) usage.delete(id);
		return { ok: true, accounts };
	};
}

/** What `cswap list --json --cached-only` printed, for the tab; see claude-swap's schema version 1.
 *  A reason never repeats the command's own words, which reach every page: only its exit, and what
 *  an error type it is known to report means. */
export function parseClaudeList(stdout: string, code: number | null, timedOut: boolean): QuotaGroup {
	const ended = timedOut ? '逾時' : code === null ? '沒有正常結束' : `結束碼 ${code}`;
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		// argparse's exit for an argument it does not know: a claude-swap from before the cached list.
		if (code === 2) return { ok: false, reason: 'claude-swap 尚未提供唯讀額度指令（需更新 claude-swap）' };
		return { ok: false, reason: `claude-swap 沒有回答（${ended}）` };
	}
	if (!isRecord(parsed)) return { ok: false, reason: 'claude-swap 的回答看不懂' };
	if (parsed.schemaVersion !== 1) return { ok: false, reason: `claude-swap 的資料版本不符（是 ${versionText(parsed.schemaVersion)}，看板認得 1）` };
	if (isRecord(parsed.error)) return { ok: false, reason: `claude-swap 讀取失敗${parsed.error.type === 'ConfigError' ? '：它的檔案讀不出來或格式不對' : ''}` };
	if (code !== 0 || !Array.isArray(parsed.accounts)) return { ok: false, reason: `claude-swap 沒有回答（${ended}）` };
	return {
		ok: true,
		// An account held out with `cswap disable` is not in use: the tab leaves it out.
		accounts: parsed.accounts.filter((row) => isRecord(row) && row.disabled !== true).map((row): QuotaAccount => {
			const fresh = row.usageStatus === 'ok' && isRecord(row.usage);
			const usage = fresh ? (row.usage as Json) : isRecord(row.lastGoodUsage) ? row.lastGoodUsage : null;
			const observedAt = fresh ? time(row.usageFetchedAt) : usage ? time(row.lastGoodFetchedAt) : null;
			const plan = isRecord(row.plan) ? row.plan : {};
			// claude-swap records a plan when it switches to, adds or confirms an account: the one in use's
			// is its current plan, another's as last seen in use.
			const label = text(plan.id) && plan.id !== 'unknown' ? text(plan.label) : null;
			const planAt = time(plan.observedAt);
			const windows: QuotaWindow[] = [];
			const add = (label: string, value: unknown) => {
				if (!isRecord(value)) return;
				windows.push({ label, used: number(value.pct), resetsAt: time(value.resetsAt) });
			};
			if (usage) {
				add('5 小時', usage.fiveHour);
				add('7 天', usage.sevenDay);
				for (const scoped of Array.isArray(usage.scoped) ? usage.scoped : []) {
					if (isRecord(scoped)) add(text(scoped.name) ?? '模型專屬', scoped);
				}
			}
			return {
				email: text(row.email) ?? '（沒有 email）',
				current: row.active === true,
				plan: label && planAt !== null ? { label, source: row.active === true ? 'live' : 'recorded', observedAt: planAt } : null,
				windows,
				observedAt,
				...(row.usageStatus === 'api_key' ? { note: 'API 金鑰帳號，沒有額度時段' } : {})
			};
		})
	};
}

const CLAUDE_LIST_ARGS = ['list', '--json', '--cached-only'];

export async function readClaudeQuota(command: string[], timeoutMs: number): Promise<QuotaGroup> {
	const result = await runCommand(command, CLAUDE_LIST_ARGS, { timeoutMs });
	if (result.code === null && !result.timedOut && !result.stdout) return { ok: false, reason: '找不到或無法啟動 cswap 指令' };
	return parseClaudeList(result.stdout, result.code, result.timedOut);
}

interface QuotaSources {
	claude(): Promise<QuotaGroup>;
	codex(): Promise<QuotaGroup>;
}

interface QuotaPoller {
	/** The last reading; null until the first one is done. */
	current(): QuotaSnapshot | null;
	close(): void;
}

/** Read both sources now and then every `intervalMs`; a read still under way is not started again.
 *  `onChange` gets each reading that differs from the one before. */
export function createQuotaPoller(sources: QuotaSources, options: { intervalMs: number; now(): number; onChange(snapshot: QuotaSnapshot): void }): QuotaPoller {
	let latest: QuotaSnapshot | null = null;
	let reading = false;
	let closed = false;
	// The error's own words stay on the server, as a reason's do.
	const settle = (read: () => Promise<QuotaGroup>) => read().catch((): QuotaGroup => ({ ok: false, reason: '讀取失敗（看板內部錯誤）' }));
	async function poll() {
		if (reading || closed) return;
		reading = true;
		try {
			const [claude, codex] = await Promise.all([settle(sources.claude), settle(sources.codex)]);
			const next: QuotaSnapshot = { readAt: options.now(), claude, codex };
			const changed = !latest || JSON.stringify({ ...latest, readAt: 0 }) !== JSON.stringify({ ...next, readAt: 0 });
			latest = next;
			if (changed && !closed) options.onChange(next);
		} finally {
			reading = false;
		}
	}
	void poll();
	const timer = setInterval(() => void poll(), options.intervalMs);
	return {
		current: () => latest,
		close() {
			closed = true;
			clearInterval(timer);
		}
	};
}
