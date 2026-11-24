// The 額度 tab's data: CPA's Codex accounts and claude-swap's cached list read into the few fields
// the tab shows, the poller that reads them, and how the tab words them. Test values only; CPA is a
// fake on a local port.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { CODEX_USAGE_INTERVAL_MS, CPA_REASONS, cpaState, createCodexQuotaReader, createQuotaPoller, parseClaudeList } from '../../src/lib/server/quota.ts';
import { FAKE_CPA_KEY, FAKE_CPA_SECRETS, startFakeCpa, usageBody, type FakeCpa, type FakeCpaAccount } from '../fake-cpa.ts';

const NOW = Date.parse('2026-10-21T08:00:00Z');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const dirs: string[] = [];
const fakes: FakeCpa[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	for (const fake of fakes.splice(0)) await fake.close();
});
function keyFile(content = `${FAKE_CPA_KEY}\n`): string {
	const dir = mkdtempSync(join(tmpdir(), 'lat-board-cpa-key-'));
	dirs.push(dir);
	const file = join(dir, 'key');
	writeFileSync(file, content, { mode: 0o600 });
	return file;
}
async function cpa(accounts: FakeCpaAccount[]): Promise<FakeCpa> {
	const fake = await startFakeCpa(accounts);
	fakes.push(fake);
	return fake;
}
/** A reader on the fake with a clock the test moves. */
function reader(fake: { url: string }, file = keyFile()) {
	const clock = { now: NOW };
	return { clock, read: createCodexQuotaReader({ url: fake.url, keyFile: file }, { now: () => clock.now }) };
}
const seconds = (time: number) => Math.floor(time / 1000) * 1000;
const plus = usageBody('plus', { used: 12, seconds: 18_000, resetAt: NOW + 4 * 60 * MIN }, { used: 18, seconds: 604_800, resetAt: NOW + 6 * DAY });
const proLite = usageBody('prolite', { used: 76, seconds: 604_800, resetAt: NOW + DAY });
const ready = (authIndex: string, email: string, body: unknown = plus, plan = 'plus'): FakeCpaAccount => ({
	authIndex,
	email,
	plan,
	status: 'active',
	disabled: false,
	unavailable: false,
	quotaBlocked: false,
	requiresSignIn: false,
	usage: { body }
});

test('codex accounts come from CPA: email, plan, state, 5 小時 and 7 天 used and reset; no secret kept, only the management key sent', async () => {
	const fake = await cpa([ready('a1', 'plus@example.com'), ready('b2', 'lite@example.com', proLite, 'prolite')]);
	const group = await reader(fake).read();
	expect(group).toEqual({
		ok: true,
		accounts: [
			{
				email: 'plus@example.com',
				current: false,
				plan: { label: 'Plus', source: 'live', observedAt: NOW },
				windows: [
					{ label: '5 小時', used: 12, resetsAt: seconds(NOW + 4 * 60 * MIN) },
					{ label: '7 天', used: 18, resetsAt: seconds(NOW + 6 * DAY) }
				],
				observedAt: NOW,
				state: { kind: 'ready' }
			},
			{
				email: 'lite@example.com',
				current: false,
				plan: { label: 'Pro Lite', source: 'live', observedAt: NOW },
				// A plan with one window: its 7 days alone.
				windows: [{ label: '7 天', used: 76, resetsAt: seconds(NOW + DAY) }],
				observedAt: NOW,
				state: { kind: 'ready' }
			}
		]
	});
	const kept = JSON.stringify(group);
	for (const secret of [...FAKE_CPA_SECRETS, 'upstream@example.com']) expect(kept).not.toContain(secret);
	// Only the management key went out; each usage ask left the account's token to CPA.
	expect(fake.calls.every((call) => call.authorization === `Bearer ${FAKE_CPA_KEY}`)).toBe(true);
	const asks = fake.calls.filter((call) => call.authIndex);
	expect(asks.map((call) => [call.authIndex, call.url, call.header?.Authorization])).toEqual([
		['a1', 'https://chatgpt.com/backend-api/wham/usage', 'Bearer $TOKEN$'],
		['b2', 'https://chatgpt.com/backend-api/wham/usage', 'Bearer $TOKEN$']
	]);
});

test('the four states: 可用, 冷卻中 with a fixed note, 停用, 狀態不明', () => {
	// `active` is what CPA v8.1.2 calls a healthy credential; `ready` is the docs' word.
	expect(cpaState({ status: 'active', disabled: false, unavailable: false })).toEqual({ kind: 'ready' });
	expect(cpaState({ status: 'ready', disabled: false, unavailable: false })).toEqual({ kind: 'ready' });
	expect(cpaState({ status: 'active', disabled: true, unavailable: false })).toEqual({ kind: 'disabled' });
	expect(cpaState({ status: 'disabled' })).toEqual({ kind: 'disabled' });
	expect(cpaState({ status: 'active', unavailable: true, quota_blocked: true, status_message: 'raw' })).toEqual({ kind: 'cooling', note: '額度用完' });
	expect(cpaState({ status: 'error', unavailable: true, requires_sign_in: true })).toEqual({ kind: 'cooling', note: '需要重新登入' });
	expect(cpaState({ status: 'refreshing', unavailable: false })).toEqual({ kind: 'cooling', note: '正在更新登入' });
	expect(cpaState({ status: 'error', unavailable: false })).toEqual({ kind: 'cooling', note: '上次請求出錯' });
	expect(cpaState({ status: 'something-new', status_message: 'raw status text SECRET' })).toEqual({ kind: 'cooling', note: '暫停使用' });
	// CPA's fallback list, scanned off disk, has no runtime fields.
	expect(cpaState({ name: 'x.json', type: 'codex', email: 'a@example.com' })).toEqual({ kind: 'unknown' });
	// Available only when the list says so in full: any one field missing or odd leaves it unknown.
	expect(cpaState({ status: 'active', unavailable: false })).toEqual({ kind: 'unknown' });
	expect(cpaState({ status: 'active', disabled: false })).toEqual({ kind: 'unknown' });
	expect(cpaState({ disabled: false, unavailable: false })).toEqual({ kind: 'unknown' });
	expect(cpaState({ status: 'active', disabled: 'no', unavailable: false })).toEqual({ kind: 'unknown' });
	// A field that says cooling is enough on its own.
	expect(cpaState({ unavailable: true })).toEqual({ kind: 'cooling', note: '暫停使用' });
});

test('the four states reach the group from CPA\'s list', async () => {
	const fake = await cpa([
		ready('a', 'ready@example.com'),
		{ ...ready('b', 'cool@example.com'), unavailable: true, quotaBlocked: true },
		{ ...ready('c', 'off@example.com'), disabled: true },
		{ authIndex: 'd', email: 'unknown@example.com', usage: { body: plus } }
	]);
	const group = await reader(fake).read();
	expect(group.ok && group.accounts.map((account) => [account.email, account.state])).toEqual([
		['ready@example.com', { kind: 'ready' }],
		['cool@example.com', { kind: 'cooling', note: '額度用完' }],
		['off@example.com', { kind: 'disabled' }],
		['unknown@example.com', { kind: 'unknown' }]
	]);
	expect(JSON.stringify(group)).not.toContain('raw status text SECRET');
});

test('one account unreadable: the other as ever; it keeps its last numbers and their time with 額度查不到, or only that when never read; recovery replaces them', async () => {
	const fake = await cpa([
		ready('a', 'good@example.com'),
		ready('b', 'flaky@example.com'),
		{ ...ready('c', 'never@example.com'), usage: { status: 401, body: { detail: 'raw status text SECRET' } } }
	]);
	const { clock, read } = reader(fake);
	const first = await read();
	expect(first.ok && first.accounts[1]).toMatchObject({ email: 'flaky@example.com', observedAt: NOW, windows: [{ used: 12 }, { used: 18 }] });
	expect(first.ok && first.accounts[1].unreadable).toBeUndefined();
	expect(first.ok && first.accounts[2]).toMatchObject({ email: 'never@example.com', windows: [], observedAt: null, unreadable: true });

	// Every way an answer fails: non-200 upstream, no windows, not JSON, another shape.
	const good = (plus as { rate_limit: { primary_window: object; secondary_window: object } }).rate_limit;
	const malformed = [
		{ status: 500, body: {} },
		{ body: { plan_type: 'plus', rate_limit: { primary_window: null } } },
		{ body: 'not json' },
		{ body: { rate_limit: 'x' } },
		// A second window present but broken, or missing instead of null.
		{ body: { ...plus, rate_limit: { ...good, secondary_window: { used_percent: 'bad', limit_window_seconds: 604_800, reset_at: 1 } } } },
		{ body: { ...plus, rate_limit: { primary_window: good.primary_window } } },
		// A window without its reset or its length.
		{ body: { ...plus, rate_limit: { ...good, primary_window: { used_percent: 12, limit_window_seconds: 18_000 } } } },
		{ body: { ...plus, rate_limit: { ...good, primary_window: { used_percent: 12, reset_at: 1 } } } }
	];
	for (const usage of malformed) {
		fake.accounts[1].usage = usage;
		clock.now += CODEX_USAGE_INTERVAL_MS;
		const failed = await read();
		expect(failed.ok && failed.accounts[0]).toMatchObject({ email: 'good@example.com', observedAt: clock.now, windows: [{ used: 12 }, { used: 18 }] });
		expect(failed.ok && failed.accounts[0].unreadable).toBeUndefined();
		expect(failed.ok && failed.accounts[1]).toMatchObject({ email: 'flaky@example.com', observedAt: NOW, windows: [{ used: 12 }, { used: 18 }], unreadable: true, state: { kind: 'ready' } });
	}

	fake.accounts[1].usage = { body: usageBody('plus', { used: 50, seconds: 18_000, resetAt: NOW + DAY }) };
	clock.now += CODEX_USAGE_INTERVAL_MS;
	const back = await read();
	expect(back.ok && back.accounts[1]).toEqual({
		email: 'flaky@example.com',
		current: false,
		plan: { label: 'Plus', source: 'live', observedAt: clock.now },
		windows: [{ label: '5 小時', used: 50, resetsAt: seconds(NOW + DAY) }],
		observedAt: clock.now,
		state: { kind: 'ready' }
	});
});

test('ChatGPT\'s usage is asked at most once per 5 minutes per account, failed or not; between, the last answer stands', async () => {
	const fake = await cpa([ready('a', 'one@example.com'), { ...ready('b', 'two@example.com'), usage: { status: 429, body: {} } }]);
	const { clock, read } = reader(fake);
	// Eleven reads 30 s apart: 0 to 5 minutes.
	for (let step = 0; step <= 10; step++) {
		clock.now = NOW + step * 30_000;
		const group = await read();
		expect(group.ok && group.accounts[0].observedAt).toBe(step < 10 ? NOW : NOW + CODEX_USAGE_INTERVAL_MS);
		if (step === 9) expect([fake.usageCalls('a'), fake.usageCalls('b')]).toEqual([1, 1]);
	}
	// The list each time; usage again only at the 5-minute mark, not a moment before.
	expect(fake.calls.filter((call) => call.path === '/v8/management/credentials').length).toBe(11);
	expect([fake.usageCalls('a'), fake.usageCalls('b')]).toEqual([2, 2]);
});

test('not set, key file unreadable, unreachable, key refused, remote management off: one fixed reason, nothing of the key, path or CPA\'s text', async () => {
	const fake = await cpa([ready('a', 'one@example.com')]);
	const reasons: string[] = [];
	const failed = (group: QuotaGroup) => {
		if (!group.ok) reasons.push(group.reason);
		return group;
	};
	expect(failed(await createCodexQuotaReader({ url: null, keyFile: keyFile() }, { now: () => NOW })())).toEqual({ ok: false, reason: CPA_REASONS.unset });
	expect(failed(await createCodexQuotaReader({ url: fake.url, keyFile: null }, { now: () => NOW })())).toEqual({ ok: false, reason: CPA_REASONS.unset });
	const missing = join(tmpdir(), 'lat-board-no-such-dir', 'cpa-key');
	expect(failed(await reader(fake, missing).read())).toEqual({ ok: false, reason: CPA_REASONS.keyFile });
	const locked = keyFile();
	chmodSync(locked, 0o000);
	if (process.getuid?.() !== 0) expect(failed(await reader(fake, locked).read())).toEqual({ ok: false, reason: CPA_REASONS.keyFile });
	expect(failed(await reader(fake, keyFile('\n')).read())).toEqual({ ok: false, reason: CPA_REASONS.keyFile });
	// A closed port: nothing listens there.
	const closed = await startFakeCpa();
	await closed.close();
	expect(failed(await reader(closed).read())).toEqual({ ok: false, reason: CPA_REASONS.unreachable });
	expect(failed(await reader(fake, keyFile('wrong-key-SECRET\n')).read())).toEqual({ ok: false, reason: CPA_REASONS.rejected });
	fake.remoteOff = true;
	expect(failed(await reader(fake).read())).toEqual({ ok: false, reason: CPA_REASONS.remoteOff });
	expect(reasons.length).toBe(process.getuid?.() === 0 ? 7 : 8);
	for (const reason of reasons) for (const secret of [...FAKE_CPA_SECRETS, 'wrong-key-SECRET', missing, locked, fake.url, '127.0.0.1', 'remote management disabled']) expect(reason).not.toContain(secret);
});

test('a refused key is not sent again until the key file changes: five refusals in a row would ban the host', async () => {
	const fake = await cpa([ready('a', 'one@example.com')]);
	const file = keyFile('wrong-key-SECRET\n');
	const { read } = reader(fake, file);
	for (let step = 0; step < 6; step++) expect(await read()).toEqual({ ok: false, reason: CPA_REASONS.rejected });
	expect(fake.calls.length).toBe(1);
	writeFileSync(file, `${FAKE_CPA_KEY}\n`);
	const fixed = await read();
	expect(fixed.ok && fixed.accounts.length).toBe(1);
	// The list and the one usage ask.
	expect(fake.calls.length).toBe(3);
});

test('a plan the board does not know is not shown: CPA\'s or ChatGPT\'s text never becomes the label', async () => {
	const odd = '/home/someone/auths/codex-secret-path.json';
	const fake = await cpa([{ ...ready('a', 'odd@example.com', usageBody(odd, { used: 1, seconds: 18_000, resetAt: NOW + MIN })), plan: odd }, ready('b', 'plus@example.com')]);
	const group = await reader(fake).read();
	expect(group.ok && group.accounts.map((account) => account.plan?.label ?? null)).toEqual([null, 'Plus']);
	expect(JSON.stringify(group)).not.toContain('codex-secret-path');
});

test('an account CPA leaves out of its list for a while keeps its numbers and is not asked again before 5 minutes', async () => {
	const fake = await cpa([ready('a', 'one@example.com'), ready('b', 'two@example.com')]);
	const { clock, read } = reader(fake);
	await read();
	const away = fake.accounts.splice(1, 1)[0];
	clock.now = NOW + 30_000;
	const without = await read();
	expect(without.ok && without.accounts.map((account) => account.email)).toEqual(['one@example.com']);
	fake.accounts.push({ ...away, usage: { status: 500, body: {} } });
	clock.now = NOW + 60_000;
	const back = await read();
	expect(fake.usageCalls('b')).toBe(1);
	expect(back.ok && back.accounts[1]).toMatchObject({ email: 'two@example.com', observedAt: NOW, windows: [{ used: 12 }, { used: 18 }] });
	expect(back.ok && back.accounts[1].unreadable).toBeUndefined();
});

test('CPA refusing the usage ask itself stops the group; ChatGPT refusing it is that account\'s alone', async () => {
	const fake = await cpa([ready('a', 'one@example.com'), { ...ready('b', 'two@example.com'), usage: { status: 403, body: { detail: 'raw status text SECRET' } } }]);
	const { clock, read } = reader(fake);
	const upstream = await read();
	expect(upstream.ok && upstream.accounts.map((account) => account.unreadable ?? false)).toEqual([false, true]);
	fake.apiCallStatus = 403;
	clock.now += CODEX_USAGE_INTERVAL_MS;
	expect(await read()).toEqual({ ok: false, reason: CPA_REASONS.rejected });
	// A 403 is not a refusal of the key toward CPA's ban: the next read tries again.
	fake.apiCallStatus = null;
	clock.now += CODEX_USAGE_INTERVAL_MS;
	expect((await read()).ok).toBe(true);
	fake.apiCallStatus = 401;
	clock.now += CODEX_USAGE_INTERVAL_MS;
	expect(await read()).toEqual({ ok: false, reason: CPA_REASONS.rejected });
	const calls = fake.calls.length;
	expect(await read()).toEqual({ ok: false, reason: CPA_REASONS.rejected });
	expect(fake.calls.length).toBe(calls);
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
	codex = { ok: false, reason: 'CPA 連不上' };
	await Bun.sleep(50);
	poller.close();
	expect(seen.length).toBe(2);
	expect(poller.current()?.codex).toEqual(codex);
});

test('claude-swap rows: a disabled account is left out', () => {
	const group = parseClaudeList(claudeList([{ number: 1, email: 'on@example.com', active: true, usageStatus: 'ok' }, { number: 2, email: 'off@example.com', active: false, usageStatus: 'unavailable', disabled: true }]), 0, false);
	expect(group.ok && group.accounts.map((account) => account.email)).toEqual(['on@example.com']);
});
