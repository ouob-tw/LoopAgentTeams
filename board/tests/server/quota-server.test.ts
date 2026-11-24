// The 額度 tab's data as the built board serves it: Claude's from a fake claude-swap, Codex's from a
// fake CPA management API on a local port, pushed over the event stream, with no secret in it or in
// the server's output, and no command run but claude-swap's read-only list. Failing sources leave
// the board and the other group alone.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import type { QuotaSnapshot } from '../../src/lib/board/quota.ts';
import { FAKE_CPA_KEY, FAKE_CPA_SECRETS, startFakeCpa, usageBody, type FakeCpa, type FakeCpaAccount } from '../fake-cpa.ts';
import { startFixture, until, type Fixture } from '../harness.ts';

const MIN = 60_000;

let fixture: Fixture | undefined;
let cpa: FakeCpa | undefined;
/** Where the trap commands log; made before the board, so they are on its PATH from the start. */
let trapDir = '';
afterEach(async () => {
	await fixture?.cleanup();
	fixture = undefined;
	await cpa?.close();
	cpa = undefined;
	rmSync(trapDir, { recursive: true, force: true });
});

/** A folder of commands that only log being run: codex-multi-auth's, Codex's and claude-swap's
 *  own names, so a board that ran any of them from PATH would be caught. */
function trapCommands(dir: string): string {
	const bin = join(dir, 'trap-bin');
	mkdirSync(bin, { recursive: true });
	for (const name of ['codex', 'codex-multi-auth', 'codex-auth', 'cswap', 'claude-swap', 'curl']) {
		const file = join(bin, name);
		writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "${join(dir, 'trapped.log')}"\nexit 1\n`);
		chmodSync(file, 0o755);
	}
	return bin;
}

async function start(accounts: FakeCpaAccount[] | null): Promise<Fixture> {
	trapDir = mkdtempSync(join(tmpdir(), 'lat-board-quota-trap-'));
	const bin = trapCommands(trapDir);
	if (accounts) cpa = await startFakeCpa(accounts);
	fixture = await startFixture({
		env: { LAT_BOARD_QUOTA_SECONDS: '1', PATH: `${bin}:${process.env.PATH ?? ''}` },
		...(cpa ? { cpa: { url: cpa.url, key: FAKE_CPA_KEY } } : {})
	});
	return fixture;
}

function setClaude(board: Fixture, now: number) {
	writeFileSync(
		join(board.dir, 'cswap.json'),
		JSON.stringify({
			output: {
				schemaVersion: 1,
				activeAccountNumber: 1,
				cachedOnly: true,
				generatedAt: new Date(now).toISOString(),
				accounts: [
					{
						number: 1,
						email: 'claude@example.com',
						organizationName: 'Org',
						organizationUuid: 'org-uuid-1',
						isOrganization: true,
						active: true,
						usageStatus: 'ok',
						usage: { fiveHour: { pct: 40, resetsAt: new Date(now + 3_600_000).toISOString() } },
						usageFetchedAt: new Date(now).toISOString(),
						usageAgeSeconds: 0,
						plan: { id: 'max_5x', label: 'Max 5x', multiplier: 5, observedAt: new Date(now).toISOString() }
					}
				]
			}
		})
	);
}
const claudeOk = (reading: QuotaSnapshot) => reading.claude.ok && reading.claude.accounts.length === 1;

const pooled = (authIndex: string, email: string, used: number, now: number): FakeCpaAccount => ({
	authIndex,
	email,
	plan: 'plus',
	status: 'active',
	disabled: false,
	unavailable: false,
	usage: { body: usageBody('plus', { used, seconds: 18_000, resetAt: now + 60 * MIN }, { used: 10, seconds: 604_800, resetAt: now + 5 * 24 * 60 * MIN }) }
});

test('the quotas reach the page over the event stream with no key, token or path, in it or in the server\'s output', async () => {
	const now = Date.now();
	const board = await start([pooled('a', 'codex@example.com', 85, now), { ...pooled('b', 'cool@example.com', 100, now), unavailable: true, quotaBlocked: true }]);
	setClaude(board, now);
	const cookie = await board.login();
	const watch = board.watch(cookie);
	const quota = await until(
		() => watch.quotas.findLast((reading) => claudeOk(reading) && reading.codex.ok && reading.codex.accounts.length === 2),
		10_000,
		'both groups read'
	);
	expect(quota.claude.ok && quota.claude.accounts[0]).toMatchObject({ email: 'claude@example.com', current: true, plan: { label: 'Max 5x', source: 'live' } });
	expect(quota.codex.ok && quota.codex.accounts.map((account) => [account.email, account.state, account.windows.map((window) => [window.label, window.used])])).toEqual([
		['codex@example.com', { kind: 'ready' }, [['5 小時', 85], ['7 天', 10]]],
		['cool@example.com', { kind: 'cooling', note: '額度用完' }, [['5 小時', 100], ['7 天', 10]]]
	]);
	const sent = JSON.stringify(watch.quotas);
	const page = await (await board.fetch('/', { cookie })).text();
	for (const text of [sent, page, board.serverOutput()]) {
		for (const secret of [...FAKE_CPA_SECRETS, 'org-uuid-1', cpa!.url, join(board.dir, 'cpa-key')]) expect(text).not.toContain(secret);
	}

	// claude-swap was only ever asked for its cached list; nothing else ran from PATH.
	const calls = readFileSync(join(board.dir, 'cswap-calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
	expect(calls.length).toBeGreaterThan(0);
	for (const args of calls) expect(args).toEqual(['list', '--json', '--cached-only']);
	expect(existsSync(join(trapDir, 'trapped.log'))).toBe(false);
});

test('one account unreadable keeps its last numbers with 額度查不到 while the other reads on; usage asked once per 5 board minutes; recovery drops the note', async () => {
	const now = Date.now();
	const board = await start([pooled('a', 'good@example.com', 20, now), pooled('b', 'flaky@example.com', 30, now)]);
	setClaude(board, now);
	const cookie = await board.login();
	const watch = board.watch(cookie);
	const first = await until(() => watch.quotas.findLast((reading) => reading.codex.ok && reading.codex.accounts.length === 2), 10_000, 'the first reading');
	// The board's clock from here on: the first reading's time, then moved by hand.
	const at = (first.codex.ok && first.codex.accounts[1].observedAt) as number;
	board.setClock(at + 1);
	// Polled every second, the list each time; ChatGPT asked once per account all the while.
	const lists = () => cpa!.calls.filter((call) => call.path === '/v8/management/credentials').length;
	const before = lists();
	await until(() => lists() >= before + 3 || null, 10_000, 'three more polls');
	expect([cpa!.usageCalls('a'), cpa!.usageCalls('b')]).toEqual([1, 1]);

	cpa!.accounts[1].usage = { status: 503, body: 'upstream raw status text SECRET' };
	board.setClock(at + 5 * MIN - 1);
	await until(() => lists() >= before + 6 || null, 10_000, 'polls just short of 5 minutes');
	expect([cpa!.usageCalls('a'), cpa!.usageCalls('b')]).toEqual([1, 1]);
	board.setClock(at + 5 * MIN);
	const failed = await until(
		() => watch.quotas.findLast((reading) => reading.codex.ok && reading.codex.accounts[1]?.unreadable === true),
		10_000,
		'the failed read'
	);
	expect(failed.codex.ok && failed.codex.accounts[0]).toMatchObject({ email: 'good@example.com', observedAt: at + 5 * MIN, windows: [{ used: 20 }, { used: 10 }] });
	expect(failed.codex.ok && failed.codex.accounts[1]).toMatchObject({ email: 'flaky@example.com', observedAt: at, windows: [{ used: 30 }, { used: 10 }], unreadable: true });
	expect([cpa!.usageCalls('a'), cpa!.usageCalls('b')]).toEqual([2, 2]);

	cpa!.accounts[1].usage = { body: usageBody('plus', { used: 55, seconds: 18_000, resetAt: now + 2 * 60 * MIN }) };
	board.setClock(at + 10 * MIN);
	const back = await until(
		() => watch.quotas.findLast((reading) => reading.codex.ok && reading.codex.accounts[1]?.observedAt === at + 10 * MIN),
		10_000,
		'the recovered read'
	);
	expect(back.codex.ok && back.codex.accounts[1]).toMatchObject({ email: 'flaky@example.com', windows: [{ label: '5 小時', used: 55 }] });
	expect(back.codex.ok && back.codex.accounts[1].unreadable).toBeUndefined();
	expect([cpa!.usageCalls('a'), cpa!.usageCalls('b')]).toEqual([3, 3]);
	expect(JSON.stringify(watch.quotas)).not.toContain('SECRET');
});

test('not set up, key file unreadable, key refused, CPA unreachable: a fixed reason in the Codex group, Claude\'s and the board as ever', async () => {
	// Not set up: no CPA address or key file.
	let board = await start(null);
	setClaude(board, Date.now());
	let cookie = await board.login();
	let watch = board.watch(cookie);
	const unset = await until(() => watch.quotas.findLast((reading) => claudeOk(reading) && !reading.codex.ok), 10_000, 'the group not set up');
	expect(unset.codex).toEqual({ ok: false, reason: 'CPA 未設定' });
	expect((await board.refresh(cookie)).errors).toEqual([]);
	await fixture!.cleanup();
	fixture = undefined;
	rmSync(trapDir, { recursive: true, force: true });

	board = await start([pooled('a', 'one@example.com', 10, Date.now())]);
	setClaude(board, Date.now());
	cookie = await board.login();
	watch = board.watch(cookie);
	await until(() => watch.quotas.findLast((reading) => claudeOk(reading) && reading.codex.ok), 10_000, 'a good reading');
	const keyFile = join(board.dir, 'cpa-key');
	const reasonOf = async (reason: string) =>
		(await until(() => watch.quotas.findLast((reading) => claudeOk(reading) && !reading.codex.ok && reading.codex.reason === reason), 10_000, reason)).codex;

	rmSync(keyFile);
	expect(await reasonOf('CPA 金鑰檔讀不到')).toEqual({ ok: false, reason: 'CPA 金鑰檔讀不到' });
	writeFileSync(keyFile, 'wrong-key-SECRET\n', { mode: 0o600 });
	expect(await reasonOf('CPA 金鑰被拒')).toEqual({ ok: false, reason: 'CPA 金鑰被拒' });
	// A refused key is sent once, not on every poll.
	const refusals = () => cpa!.calls.filter((call) => call.authorization === 'Bearer wrong-key-SECRET').length;
	await Bun.sleep(2_500);
	expect(refusals()).toBe(1);
	writeFileSync(keyFile, `${FAKE_CPA_KEY}\n`, { mode: 0o600 });
	await until(() => watch.quotas.findLast((reading) => reading.codex.ok), 10_000, 'the key fixed');
	await cpa!.close();
	cpa = undefined;
	expect(await reasonOf('CPA 連不上')).toEqual({ ok: false, reason: 'CPA 連不上' });

	expect((await board.refresh(cookie)).errors).toEqual([]);
	for (const text of [JSON.stringify(watch.quotas), board.serverOutput()]) {
		for (const secret of [...FAKE_CPA_SECRETS, 'wrong-key-SECRET', keyFile]) expect(text).not.toContain(secret);
	}
});
