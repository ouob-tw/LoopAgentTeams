// The 額度 tab's data: codex-multi-auth's files and claude-swap's cached list read into the few
// fields the tab shows, the poller that reads them, and how the tab words them. Test values only.
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import {
	groupObservedAt,
	isStale,
	level,
	ordered,
	percentText,
	planView,
	remaining,
	resetText,
	updatedText,
	waiting,
	type QuotaAccount,
	type QuotaGroup,
	type QuotaSnapshot
} from '../../src/lib/board/quota.ts';
import { codexMultiAuthDir, createQuotaPoller, parseClaudeList, readCodexQuota } from '../../src/lib/server/quota.ts';

const NOW = Date.parse('2026-10-21T08:00:00Z');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** Stand-ins for the secrets the account file holds; none may come out. */
const SECRETS = ['refresh-token-SECRET-1', 'access-token-SECRET-2', 'refresh-token-SECRET-3', 'access-token-SECRET-4'];

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function codexDir(accounts: unknown, cache?: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), 'lat-board-quota-'));
	dirs.push(dir);
	if (accounts !== undefined) writeFileSync(join(dir, 'openai-codex-accounts.json'), typeof accounts === 'string' ? accounts : JSON.stringify(accounts));
	if (cache !== undefined) writeFileSync(join(dir, 'quota-cache.json'), typeof cache === 'string' ? cache : JSON.stringify(cache));
	return dir;
}

const entry = (updatedAt: number, primary: number, secondary: number, planType = 'plus') => ({
	updatedAt,
	status: 200,
	model: 'gpt-5-codex',
	planType,
	primary: { usedPercent: primary, windowMinutes: 300, resetAtMs: NOW + 60 * MIN },
	secondary: { usedPercent: secondary, windowMinutes: 10080 }
});
/** One window only, as a Free or Pro Lite plan has: the second is 0 minutes long. */
const single = (updatedAt: number, used: number, planType: string) => ({
	...entry(updatedAt, used, 0, planType),
	primary: { usedPercent: used, windowMinutes: 43200, resetAtMs: NOW + DAY },
	secondary: { usedPercent: 0, windowMinutes: 0 }
});
const account = (fields: object) => ({
	accountIdSource: 'token',
	refreshToken: SECRETS[0],
	accessToken: SECRETS[1],
	expiresAt: NOW + DAY,
	addedAt: NOW - 30 * DAY,
	lastUsed: NOW - DAY,
	...fields
});
const workspaceKey = (recordId: string, workspaceId: string) =>
	createHash('sha256').update(JSON.stringify(['oauth', recordId, workspaceId])).digest('hex');

test('codex accounts come from the account file, joined with the quota cache, the active one current, no secret kept', async () => {
	const dir = codexDir(
		{
			version: 3,
			activeIndex: 1,
			accounts: [
				account({ recordId: 'record:a', accountId: 'acct-a', email: 'a@example.com' }),
				// Its selected workspace is not the stored binding: only the workspace's own entry counts.
				account({
					recordId: 'record:b',
					accountId: 'acct-b',
					email: 'b@example.com',
					workspaces: [{ id: 'ws-b2', name: 'B2', enabled: true, isDefault: false }],
					currentWorkspaceIndex: 0,
					refreshToken: SECRETS[2],
					accessToken: SECRETS[3]
				}),
				// Found by email: its account ID is not in the cache.
				account({ recordId: 'record:c', accountId: 'acct-c', email: 'C@Example.com' }),
				account({ recordId: 'record:d', accountId: 'acct-d', email: 'd@example.com' }),
				account({ recordId: 'record:e', accountId: 'acct-e', email: 'e@example.com' })
			]
		},
		{
			version: 1,
			byAccountId: {
				'acct-a': entry(NOW - 5 * MIN, 45, 82),
				'acct-b': entry(NOW - MIN, 1, 1),
				'acct-e': single(NOW - MIN, 3, 'prolite'),
				// Not in the account file: never listed.
				'acct-gone': entry(NOW, 99, 99)
			},
			byEmail: { 'c@example.com': entry(NOW - 2 * DAY, 96, 10, 'pro') },
			byWorkspace: { [workspaceKey('record:b', 'ws-b2')]: entry(NOW - 20 * MIN, 50, 60, 'team') }
		}
	);
	const group = await readCodexQuota(dir);
	expect(group.ok).toBe(true);
	if (!group.ok) return;
	expect(group.accounts.map((row) => [row.email, row.current])).toEqual([
		['a@example.com', false],
		['b@example.com', true],
		['C@Example.com', false],
		['d@example.com', false],
		['e@example.com', false]
	]);
	const [a, b, c, d, e] = group.accounts;
	expect(e.plan?.label).toBe('Pro Lite');
	expect(e.windows).toEqual([{ label: '30 天', used: 3, resetsAt: NOW + DAY }]);
	expect(a).toEqual({
		email: 'a@example.com',
		current: false,
		plan: { label: 'Plus', source: 'live', observedAt: NOW - 5 * MIN },
		windows: [
			{ label: '5 小時', used: 45, resetsAt: NOW + 60 * MIN },
			{ label: '7 天', used: 82, resetsAt: null }
		],
		observedAt: NOW - 5 * MIN
	});
	expect(b.observedAt).toBe(NOW - 20 * MIN);
	expect(b.plan?.label).toBe('Team');
	expect(b.windows.map((window) => window.used)).toEqual([50, 60]);
	// Recorded with its usage reading: as current as that, however old.
	expect(c.plan).toEqual({ label: 'Pro', source: 'live', observedAt: NOW - 2 * DAY });
	expect(d).toEqual({ email: 'd@example.com', current: false, plan: null, windows: [], observedAt: null });
	const sent = JSON.stringify(group);
	for (const secret of SECRETS) expect(sent).not.toContain(secret);
	expect(sent).not.toContain('record:');
	expect(sent).not.toContain('acct-');
});

test('a codex account ID shared by two accounts falls back to neither', async () => {
	const dir = codexDir(
		{
			version: 3,
			activeIndex: 0,
			accounts: [account({ accountId: 'same', email: 'x@example.com' }), account({ accountId: 'same', email: 'y@example.com' })]
		},
		{ version: 1, byAccountId: { same: entry(NOW, 10, 10) }, byEmail: {} }
	);
	const group = await readCodexQuota(dir);
	expect(group.ok && group.accounts.map((row) => row.windows.length)).toEqual([0, 0]);
});

test('codex files that are missing, unreadable or of another version say why', async () => {
	expect(await readCodexQuota(codexDir(undefined))).toEqual({ ok: false, reason: '找不到 Codex 帳號檔' });
	expect(await readCodexQuota(codexDir('{not json'))).toEqual({ ok: false, reason: 'Codex 帳號檔 不是有效的 JSON' });
	expect(await readCodexQuota(codexDir({ version: 2, accounts: [] }))).toEqual({
		ok: false,
		reason: 'Codex 帳號檔版本不符（是 2，看板認得 3）'
	});
	const accounts = { version: 3, activeIndex: 0, accounts: [account({ accountId: 'a', email: 'a@example.com' })] };
	expect(await readCodexQuota(codexDir(accounts, { version: 2 }))).toEqual({
		ok: false,
		reason: 'Codex 額度快取版本不符（是 2，看板認得 1）'
	});
	// A version is shown only as a number, never as the file's text.
	expect(await readCodexQuota(codexDir(accounts, { version: 'refresh-token-SECRET-1' }))).toEqual({
		ok: false,
		reason: 'Codex 額度快取版本不符（是 不明，看板認得 1）'
	});
	expect(await readCodexQuota(codexDir(accounts, '{'))).toEqual({ ok: false, reason: 'Codex 額度快取 不是有效的 JSON' });
	expect(await readCodexQuota(codexDir(accounts))).toEqual({ ok: false, reason: '找不到 Codex 額度快取' });
});

test('the codex folder follows CODEX_MULTI_AUTH_DIR, then CODEX_HOME', () => {
	expect(codexMultiAuthDir({ CODEX_MULTI_AUTH_DIR: '/x/auth', CODEX_HOME: '/y' })).toBe('/x/auth');
	expect(codexMultiAuthDir({ CODEX_HOME: '/y' })).toBe('/y/multi-auth');
	expect(codexMultiAuthDir({})).toEndWith('/.codex/multi-auth');
});

const iso = (time: number) => new Date(time).toISOString();
const claudeList = (accounts: object[]) => JSON.stringify({ schemaVersion: 1, activeAccountNumber: 1, accounts, cachedOnly: true, generatedAt: iso(NOW) });
const plan = (id: string, label: string, observedAt: number | null) => ({ id, label, multiplier: 5, observedAt: observedAt === null ? null : iso(observedAt) });
const windowOf = (pct: number, resetsAt: number) => ({ pct, resetsAt: new Date(resetsAt).toISOString().replace('Z', '+00:00'), countdown: '1h', clock: '09:00' });

test('claude-swap rows: fresh, last good and no usage, with their plans', () => {
	const group = parseClaudeList(
		claudeList([
			{
				number: 1,
				email: 'one@example.com',
				active: true,
				usageStatus: 'ok',
				usage: { fiveHour: windowOf(12, NOW + 60 * MIN), sevenDay: { ...windowOf(81.4, NOW + 3 * DAY), expectedPct: 30 }, scoped: [{ name: 'Fable', ...windowOf(96, NOW + 2 * DAY) }] },
				usageFetchedAt: iso(NOW - MIN),
				usageAgeSeconds: 60,
				plan: plan('max_5x', 'Max 5x', NOW - 10 * MIN)
			},
			{
				number: 2,
				email: 'two@example.com',
				active: false,
				usageStatus: 'unavailable',
				usage: null,
				lastGoodUsage: { fiveHour: windowOf(70, NOW - MIN) },
				lastGoodFetchedAt: iso(NOW - 6 * 60 * MIN),
				usageError: 'http-429',
				plan: plan('pro', 'Pro', NOW - 3 * DAY)
			},
			{ number: 3, email: 'three@example.com', active: false, usageStatus: 'unavailable', usage: null, plan: plan('unknown', 'Unknown', null) },
			{ number: 4, email: 'key@example.com', active: false, usageStatus: 'api_key', usage: null, plan: plan('max_20x', 'Max 20x', null) }
		]),
		0,
		false
	);
	expect(group).toEqual({
		ok: true,
		accounts: [
			{
				email: 'one@example.com',
				current: true,
				// Recorded when claude-swap switched to it: the account in use's plan is the current one.
				plan: { label: 'Max 5x', source: 'live', observedAt: NOW - 10 * MIN },
				windows: [
					{ label: '5 小時', used: 12, resetsAt: NOW + 60 * MIN },
					{ label: '7 天', used: 81.4, resetsAt: NOW + 3 * DAY },
					{ label: 'Fable', used: 96, resetsAt: NOW + 2 * DAY }
				],
				observedAt: NOW - MIN
			},
			{
				email: 'two@example.com',
				current: false,
				plan: { label: 'Pro', source: 'recorded', observedAt: NOW - 3 * DAY },
				windows: [{ label: '5 小時', used: 70, resetsAt: NOW - MIN }],
				observedAt: NOW - 6 * 60 * MIN
			},
			{ email: 'three@example.com', current: false, plan: null, windows: [], observedAt: null },
			// A plan with no time it was seen is unknown too.
			{ email: 'key@example.com', current: false, plan: null, windows: [], observedAt: null, note: 'API 金鑰帳號，沒有額度時段' }
		]
	});
});

test('claude-swap failures say why, in the board\'s own words only', () => {
	expect(parseClaudeList(JSON.stringify({ schemaVersion: 1, error: { type: 'ConfigError', message: 'token=refresh-token-SECRET-1' } }), 1, false)).toEqual({
		ok: false,
		reason: 'claude-swap 讀取失敗：它的檔案讀不出來或格式不對'
	});
	expect(parseClaudeList(JSON.stringify({ schemaVersion: 1, error: { type: 'refresh_token_SECRET_1' } }), 1, false)).toEqual({
		ok: false,
		reason: 'claude-swap 讀取失敗'
	});
	expect(parseClaudeList(JSON.stringify({ schemaVersion: 2, accounts: [] }), 0, false)).toEqual({
		ok: false,
		reason: 'claude-swap 的資料版本不符（是 2，看板認得 1）'
	});
	expect(parseClaudeList(JSON.stringify({ schemaVersion: 'refresh-token-SECRET-1' }), 0, false)).toEqual({
		ok: false,
		reason: 'claude-swap 的資料版本不符（是 不明，看板認得 1）'
	});
	// A claude-swap from before the cached list rejects the argument.
	expect(parseClaudeList('', 2, false)).toEqual({ ok: false, reason: 'claude-swap 尚未提供唯讀額度指令（需更新 claude-swap）' });
	expect(parseClaudeList('refresh-token-SECRET-1', 1, false)).toEqual({ ok: false, reason: 'claude-swap 沒有回答（結束碼 1）' });
	expect(parseClaudeList('', null, true)).toEqual({ ok: false, reason: 'claude-swap 沒有回答（逾時）' });
});

const row = (fields: Partial<QuotaAccount>): QuotaAccount => ({ email: 'x', current: false, plan: null, windows: [], observedAt: null, ...fields });

test('the tab: the account in use first, its reading the group\'s, the thresholds and the plan\'s three ways', () => {
	const accounts = [row({ email: 'a', observedAt: NOW - 1 }), row({ email: 'b', current: true, observedAt: NOW - 10 * MIN }), row({ email: 'c', observedAt: NOW })];
	expect(ordered(accounts).map((account) => account.email)).toEqual(['b', 'a', 'c']);
	expect(groupObservedAt(accounts)).toBe(NOW - 10 * MIN);
	// No account in use: the newest reading.
	expect(groupObservedAt(accounts.map((account) => ({ ...account, current: false })))).toBe(NOW);
	expect(groupObservedAt([])).toBeNull();

	expect(isStale(NOW - 3 * MIN, NOW, 'claude')).toBe(false);
	expect(isStale(NOW - 3 * MIN - 1, NOW, 'claude')).toBe(true);
	expect(isStale(NOW - 15 * MIN, NOW, 'codex')).toBe(false);
	expect(isStale(NOW - 15 * MIN - 1, NOW, 'codex')).toBe(true);
	expect(isStale(null, NOW, 'codex')).toBe(false);
	expect(updatedText(NOW - 5 * MIN - 1, NOW)).toBe('5 分鐘前更新');
	expect(updatedText(NOW - 10, NOW)).toBe('剛剛更新');
	expect(updatedText(null, NOW)).toBe('沒有紀錄');

	expect([100, 20.1, 20, 5.1, 5, 0].map(level)).toEqual([null, null, 'warn', 'warn', 'danger', 'danger']);
	expect([0, 20, 79.6, 94.6, 95, 100].map(remaining)).toEqual([100, 80, 20, 5, 5, 0]);
	expect([79.6, 94.6].map((used) => level(remaining(used)))).toEqual(['warn', 'danger']);
	expect([0, 11, 81.4, 81.5, 100].map(percentText)).toEqual(['100%', '89%', '19%', '18%', '0%']);
	expect(waiting({ label: '', used: 50, resetsAt: NOW }, NOW)).toBe(true);
	expect(waiting({ label: '', used: 50, resetsAt: NOW + 1 }, NOW)).toBe(false);
	expect(waiting({ label: '', used: 50, resetsAt: null }, NOW)).toBe(false);
	expect(resetText(NOW + 60 * MIN, NOW)).toMatch(/^\d\d:\d\d 重置$/);
	expect(resetText(NOW + 3 * DAY, NOW)).toMatch(/^\d+\/\d+ \d\d:\d\d 重置$/);

	expect(planView({ label: 'Max 5x', source: 'live', observedAt: NOW }, NOW)).toEqual({ text: 'Max 5x', recorded: false });
	expect(planView({ label: 'Pro', source: 'recorded', observedAt: NOW - 3 * DAY - 1 }, NOW)).toEqual({ text: 'Pro', recorded: true, title: '上次使用時記錄（3 天前）' });
	expect(planView(null, NOW)).toBeNull();
});

test('the poller reads both sources, keeps one failing from the other, and tells only of changes', async () => {
	let codex: QuotaGroup = { ok: true, accounts: [] };
	const seen: QuotaSnapshot[] = [];
	const poller = createQuotaPoller(
		{
			claude: async () => {
				throw new Error('boom');
			},
			codex: async () => codex
		},
		{ intervalMs: 20, now: () => NOW, onChange: (snapshot) => seen.push(snapshot) }
	);
	await Bun.sleep(70);
	expect(seen.length).toBe(1);
	expect(seen[0]).toEqual({ readAt: NOW, claude: { ok: false, reason: '讀取失敗（看板內部錯誤）' }, codex: { ok: true, accounts: [] } });
	codex = { ok: false, reason: '找不到 Codex 帳號檔' };
	await Bun.sleep(50);
	poller.close();
	expect(seen.length).toBe(2);
	expect(poller.current()?.codex).toEqual(codex);
});
