// The 額度 tab's data as the built board serves it: read from a fake claude-swap and from
// codex-multi-auth's files in a temporary folder, pushed over the event stream, with no secret in it
// and no command run but claude-swap's read-only list. Failing sources leave the board alone.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import type { QuotaSnapshot } from '../src/lib/board/quota.ts';
import { startFixture, until, type Fixture } from './harness.ts';

const SECRETS = ['refresh-token-SECRET-1', 'access-token-SECRET-2'];

let fixture: Fixture | undefined;
/** Where the trap commands log; made before the board, so they are on its PATH from the start. */
let trapDir = '';
afterEach(async () => {
	await fixture?.cleanup();
	fixture = undefined;
	rmSync(trapDir, { recursive: true, force: true });
});

/** A folder of commands that only log being run: codex-multi-auth's, Codex's and claude-swap's
 *  own names, so a board that ran any of them from PATH would be caught. */
function trapCommands(dir: string): string {
	const bin = join(dir, 'trap-bin');
	mkdirSync(bin, { recursive: true });
	for (const name of ['codex', 'codex-multi-auth', 'codex-auth', 'cswap', 'claude-swap']) {
		const file = join(bin, name);
		writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "${join(dir, 'trapped.log')}"\nexit 1\n`);
		chmodSync(file, 0o755);
	}
	return bin;
}

async function start(offset: number): Promise<Fixture> {
	trapDir = mkdtempSync(join(tmpdir(), 'lat-board-quota-trap-'));
	const bin = trapCommands(trapDir);
	fixture = await startFixture(offset, { env: { LAT_BOARD_QUOTA_SECONDS: '1', PATH: `${bin}:${process.env.PATH ?? ''}` } });
	return fixture;
}

const codexDir = (fixture: Fixture) => join(fixture.dir, 'codex-multi-auth');
function writeCodex(fixture: Fixture, accounts: unknown, cache?: unknown) {
	mkdirSync(codexDir(fixture), { recursive: true });
	writeFileSync(join(codexDir(fixture), 'openai-codex-accounts.json'), JSON.stringify(accounts));
	if (cache !== undefined) writeFileSync(join(codexDir(fixture), 'quota-cache.json'), JSON.stringify(cache));
}

test('the quotas reach the page over the event stream, with no secret, from read-only sources only', async () => {
	const board = await start(56);
	const now = Date.now();
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
	writeCodex(
		board,
		{
			version: 3,
			activeIndex: 0,
			accounts: [{ recordId: 'record:x', accountId: 'acct-x', email: 'codex@example.com', refreshToken: SECRETS[0], accessToken: SECRETS[1], addedAt: 1 }]
		},
		{ version: 1, byAccountId: { 'acct-x': { updatedAt: now, status: 200, model: 'gpt-5-codex', planType: 'pro', primary: { usedPercent: 85, windowMinutes: 300, resetAtMs: now + 1000 }, secondary: {} } }, byEmail: {} }
	);
	const cookie = await board.login();
	const watch = board.watch(cookie);
	const quota = await until(
		() => watch.quotas.findLast((reading) => reading.claude.ok && reading.claude.accounts.length && reading.codex.ok),
		10_000,
		'both groups read'
	);
	expect(quota.claude.ok && quota.claude.accounts[0]).toMatchObject({ email: 'claude@example.com', current: true, plan: { label: 'Max 5x', source: 'live' } });
	expect(quota.codex.ok && quota.codex.accounts).toEqual([
		{
			email: 'codex@example.com',
			current: true,
			plan: { label: 'Pro', source: 'live', observedAt: now },
			windows: [{ label: '5 小時', used: 85, resetsAt: now + 1000 }],
			observedAt: now
		}
	]);
	const sent = JSON.stringify(watch.quotas);
	for (const secret of [...SECRETS, 'record:x', 'acct-x', 'org-uuid-1', 'refreshToken', 'accessToken']) expect(sent).not.toContain(secret);

	// The board's own pages carry none of it either.
	const page = await (await board.fetch('/', { cookie })).text();
	for (const secret of SECRETS) expect(page).not.toContain(secret);

	// claude-swap was only ever asked for its cached list; nothing else ran from PATH.
	const calls = readFileSync(join(board.dir, 'cswap-calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
	expect(calls.length).toBeGreaterThan(0);
	for (const args of calls) expect(args).toEqual(['list', '--json', '--cached-only']);
	expect(existsSync(join(trapDir, 'trapped.log'))).toBe(false);
});

test('failing, missing and mismatched sources say why in the tab and leave the board alone', async () => {
	const board = await start(57);
	writeFileSync(join(board.dir, 'cswap.json'), JSON.stringify({ output: { schemaVersion: 1, error: { type: 'ConfigError', message: 'usage cache is malformed' } }, exit: 1 }));
	const cookie = await board.login();
	const watch = board.watch(cookie);
	const missing = await until(
		() => watch.quotas.findLast((reading) => !reading.claude.ok && !reading.codex.ok),
		10_000,
		'both groups failing'
	);
	expect(missing.claude).toEqual({ ok: false, reason: 'claude-swap 讀取失敗：usage cache is malformed' });
	expect(missing.codex).toEqual({ ok: false, reason: '找不到 Codex 帳號檔' });

	writeCodex(board, { version: 4, accounts: [] });
	writeFileSync(join(board.dir, 'cswap.json'), JSON.stringify({ raw: 'Traceback (most recent call last)', exit: 1 }));
	const mismatched = await until(
		() => watch.quotas.findLast((reading: QuotaSnapshot) => !reading.codex.ok && reading.codex.reason.includes('版本不符')),
		10_000,
		'the version mismatch'
	);
	expect(mismatched.codex).toEqual({ ok: false, reason: 'Codex 帳號檔版本不符（是 4，看板認得 3）' });
	expect(mismatched.claude.ok).toBe(false);

	// The board itself reads on as before, with nothing of the quotas among its errors.
	const snapshot = await board.refresh(cookie);
	expect(snapshot.errors).toEqual([]);
});
