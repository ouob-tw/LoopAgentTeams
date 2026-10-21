// The accounts' quotas for the 額度 tab, read on a timer and shared by every page. Nothing here
// goes online or refreshes a login: Claude's come from claude-swap's cached list, which reads its
// own files only; Codex's straight from codex-multi-auth's account file and quota cache, never
// through its commands. Only the fields of board/quota.ts are kept from either: tokens and the
// files' text never leave this module.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { QuotaAccount, QuotaGroup, QuotaSnapshot, QuotaWindow } from '../board/quota.ts';
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

/** codex-multi-auth's folder, as it finds it: CODEX_MULTI_AUTH_DIR, else CODEX_HOME's multi-auth. */
export function codexMultiAuthDir(env: Env = process.env): string {
	const given = env.CODEX_MULTI_AUTH_DIR?.trim();
	if (given) return given;
	return join(env.CODEX_HOME?.trim() || join(homedir(), '.codex'), 'multi-auth');
}

const CODEX_ACCOUNTS_FILE = 'openai-codex-accounts.json';
const CODEX_QUOTA_FILE = 'quota-cache.json';

/** A window's name by its length; codex-multi-auth names none. */
function windowLabel(minutes: number | null, fallback: string): string {
	if (minutes === null) return fallback;
	if (minutes === 7 * 24 * 60) return '7 天';
	if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} 天`;
	if (minutes % 60 === 0) return `${minutes / 60} 小時`;
	return `${minutes} 分鐘`;
}

/** A version as a reason may show it: a number, nothing taken from a file's text. */
const versionText = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : '不明');

const PLAN_LABELS: Record<string, string> = { prolite: 'Pro Lite' };
const capitalized = (value: string) => PLAN_LABELS[value] ?? value.charAt(0).toUpperCase() + value.slice(1);

/** Read a JSON file; a reason when it is missing or not JSON. */
async function readJson(path: string, name: string): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
	let content: string;
	try {
		content = await readFile(path, 'utf8');
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return { ok: false, reason: code === 'ENOENT' ? `找不到 ${name}` : `${name} 讀不出來（${code ?? 'error'}）` };
	}
	try {
		return { ok: true, value: JSON.parse(content) };
	} catch {
		return { ok: false, reason: `${name} 不是有效的 JSON` };
	}
}

/** The cache's identity of an account's workspace, as codex-multi-auth keys it; only from a stored
 *  record ID: one derived from the refresh token is never worked out here. */
function workspaceKey(account: Json, workspaceId: string): string | null {
	const recordId = text(account.recordId);
	return recordId ? createHash('sha256').update(JSON.stringify(['oauth', recordId, workspaceId])).digest('hex') : null;
}

/** The workspace an account is shown with: its selected one, else its account ID. */
function workspaceIdOf(account: Json): string | null {
	const workspaces = Array.isArray(account.workspaces) ? account.workspaces : [];
	if (workspaces.length) {
		const index = number(account.currentWorkspaceIndex) ?? 0;
		const selected = workspaces[index];
		return isRecord(selected) ? text(selected.id) : null;
	}
	return text(account.accountId);
}

/** An account's cache entry, joined as codex-multi-auth's quota readiness does: the workspace's
 *  own entry, or for the stored binding the older ones by account ID or by email when they name
 *  this account alone, whichever is newer. */
function entryFor(cache: Json, account: Json, accounts: Json[]): Json | null {
	const map = (name: string): Json => (isRecord(cache[name]) ? cache[name] : {});
	const workspaceId = workspaceIdOf(account);
	const key = workspaceId && workspaceKey(account, workspaceId);
	const scoped = key && isRecord(map('byWorkspace')[key]) ? (map('byWorkspace')[key] as Json) : null;
	const accountId = text(account.accountId);
	if (workspaceId !== accountId) return scoped;
	const newer = (legacy: Json) => (scoped && (number(scoped.updatedAt) ?? 0) >= (number(legacy.updatedAt) ?? 0) ? scoped : legacy);
	if (accountId && accounts.filter((other) => text(other.accountId) === accountId).length === 1) {
		const legacy = map('byAccountId')[accountId];
		if (isRecord(legacy)) return newer(legacy);
	}
	const email = text(account.email)?.toLowerCase();
	if (email) {
		const same = accounts.filter((other) => text(other.email)?.toLowerCase() === email);
		const ids = new Set(same.flatMap((other) => (text(other.accountId) ? [text(other.accountId)] : [])));
		const legacy = map('byEmail')[email];
		if (same.length === 1 && ids.size <= 1 && isRecord(legacy)) return newer(legacy);
	}
	return scoped;
}

function codexWindow(value: unknown, fallback: string): QuotaWindow | null {
	if (!isRecord(value)) return null;
	const used = number(value.usedPercent);
	const resetsAt = number(value.resetAtMs);
	const minutes = number(value.windowMinutes);
	// A plan without a second window has one 0 minutes long.
	if ((used === null && resetsAt === null) || minutes === 0) return null;
	return { label: windowLabel(minutes, fallback), used, resetsAt };
}

/** Every account the account file lists, with what the quota cache has for it. */
export async function readCodexQuota(dir: string): Promise<QuotaGroup> {
	const accountsFile = await readJson(join(dir, CODEX_ACCOUNTS_FILE), 'Codex 帳號檔');
	if (!accountsFile.ok) return { ok: false, reason: accountsFile.reason };
	const storage = accountsFile.value;
	if (!isRecord(storage) || storage.version !== 3 || !Array.isArray(storage.accounts)) {
		return { ok: false, reason: `Codex 帳號檔版本不符（是 ${versionText(isRecord(storage) ? storage.version : null)}，看板認得 3）` };
	}
	const quotaFile = await readJson(join(dir, CODEX_QUOTA_FILE), 'Codex 額度快取');
	if (!quotaFile.ok) return { ok: false, reason: quotaFile.reason };
	const cache = quotaFile.value;
	if (!isRecord(cache) || cache.version !== 1) {
		return { ok: false, reason: `Codex 額度快取版本不符（是 ${versionText(isRecord(cache) ? cache.version : null)}，看板認得 1）` };
	}
	const rows = storage.accounts.filter(isRecord);
	const active = number(storage.activeIndex);
	return {
		ok: true,
		accounts: rows.map((account, index): QuotaAccount => {
			const entry = entryFor(cache, account, rows);
			const observedAt = entry ? number(entry.updatedAt) : null;
			const planType = entry ? text(entry.planType) : null;
			const windows = entry
				? [codexWindow(entry.primary, '主要時段'), codexWindow(entry.secondary, '次要時段')].filter((window) => window !== null)
				: [];
			return {
				email: text(account.email) ?? '（沒有 email）',
				current: index === active,
				// Recorded with each usage reading: as current as the usage, whose age the card shows.
				plan: planType ? { label: capitalized(planType), source: 'live', observedAt } : null,
				windows,
				observedAt
			};
		})
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
		accounts: parsed.accounts.filter(isRecord).map((row): QuotaAccount => {
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
