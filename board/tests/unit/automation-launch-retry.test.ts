// Opening an agent for an automation run when hcom's database is locked (#657): the retries, their
// waits, what ends them early, and the half-opened agent cleaned up between them.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import type { Cut } from '../../src/lib/server/automation-agent.ts';
import { closeHalfLaunched, launchWithLockRetry, LAUNCH_LOCK_WAITS_MS, pauseUnlessHalted } from '../../src/lib/server/automation-host.ts';
import type { BoardConfig } from '../../src/lib/server/config.ts';

const LOCKED = 'hcom 啟動失敗：Failed to spawn PTY: failed to persist PTY process: database is locked: Error code 5';
const MIN = 60_000;
type Result = Awaited<ReturnType<Parameters<typeof launchWithLockRetry>[0]['attempt']>>;

/** A launch whose answers come in turn; records the waits and how many times it was cleaned up. */
function rig(answers: Result[], haltDuring?: { atWait: number; cut: Cut }) {
	const seen = { attempts: 0, cleanups: 0, waits: [] as number[], cleanupAnswer: null as string | null };
	let cut: Cut | null = null;
	return {
		seen,
		run: () =>
			launchWithLockRetry({
				attempt: async () => answers[seen.attempts++]!,
				cleanup: async () => (seen.cleanups++, seen.cleanupAnswer),
				halted: () => cut,
				pause: async (ms) => {
					seen.waits.push(ms);
					if (haltDuring?.atWait === seen.waits.length) cut = haltDuring.cut;
				}
			})
	};
}

const locked = (count: number): Result[] => Array.from({ length: count }, () => ({ ok: false as const, reason: LOCKED }));

test('the waits are 1, 2 and 4 minutes', () => {
	expect(LAUNCH_LOCK_WAITS_MS).toEqual([MIN, 2 * MIN, 4 * MIN]);
});

test('a lock on the first launch and success on the second opens the agent, tracked by its name', async () => {
	const r = rig([...locked(1), { ok: true, name: 'auto-x-abcd', workspace: 'wA' }]);
	expect(await r.run()).toEqual({ ok: true, name: 'auto-x-abcd', workspace: 'wA' });
	expect(r.seen).toMatchObject({ attempts: 2, cleanups: 1, waits: [MIN] });
});

test('four locks in a row launch four times, 1, 2 and 4 minutes apart, then fail saying three retries and the last error', async () => {
	const r = rig(locked(4));
	const result = await r.run();
	expect(r.seen).toMatchObject({ attempts: 4, waits: [MIN, 2 * MIN, 4 * MIN] });
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.cut).toBeUndefined();
	expect(result.reason).toContain('已重試 3 次');
	expect(result.reason).toContain('database is locked');
});

test('any other launch error is not retried: one launch, no wait, no cleanup', async () => {
	const r = rig([{ ok: false, reason: 'hcom 啟動失敗：no such model' }]);
	expect(await r.run()).toEqual({ ok: false, reason: 'hcom 啟動失敗：no such model' });
	expect(r.seen).toMatchObject({ attempts: 1, cleanups: 0, waits: [] });
});

test('a stop pressed during a wait ends it with no further launch', async () => {
	const r = rig([...locked(1), { ok: true, name: 'n', workspace: null }], { atWait: 1, cut: 'stopped' });
	expect(await r.run()).toMatchObject({ ok: false, cut: 'stopped' });
	expect(r.seen.attempts).toBe(1);
});

test('the time limit reached during a later wait ends it with no further launch', async () => {
	const r = rig(locked(4), { atWait: 2, cut: 'timeout' });
	expect(await r.run()).toMatchObject({ ok: false, cut: 'timeout' });
	expect(r.seen).toMatchObject({ attempts: 2, waits: [MIN, 2 * MIN] });
});

test('a half-opened agent that cannot be cleaned up stops the retries', async () => {
	const r = rig([...locked(1), { ok: true, name: 'n', workspace: null }]);
	r.seen.cleanupAnswer = 'x 還在 hcom 的清單上';
	const result = await r.run();
	expect(result.ok).toBe(false);
	expect(r.seen.attempts).toBe(1);
	if (!result.ok) expect(result.reason).toContain('清不掉');
});

test('the default wait ends within seconds of a stop', async () => {
	let stopped = false;
	setTimeout(() => (stopped = true), 100);
	const began = Date.now();
	await pauseUnlessHalted(60_000, () => (stopped ? 'stopped' : null));
	expect(Date.now() - began).toBeLessThan(3000);
});

/** A fake `hcom` that lists <dir>/list.json and logs each call; `kill` is refused for want of a tracked PID unless `killWorks`, and `stop` takes the agent off the list. */
function fakeHcom(agents: object[], killWorks = false) {
	const dir = mkdtempSync(join(tmpdir(), 'hcom-retry-'));
	writeFileSync(join(dir, 'list.json'), JSON.stringify(agents));
	const remove = `bun -e 'const f=process.argv[1];const l=JSON.parse(require("fs").readFileSync(f,"utf8")).filter(a=>a.name!==process.argv[2]);require("fs").writeFileSync(f,JSON.stringify(l))' "${dir}/list.json" "$2"`;
	const script = join(dir, 'hcom');
	writeFileSync(
		script,
		`#!/bin/bash
echo "$@" >> "${dir}/calls.txt"
case "$1" in
  list) cat "${dir}/list.json" ;;
  kill) ${killWorks ? remove : 'echo "No tracked PID" >&2; exit 1'} ;;
  stop) ${remove} ;;
esac
`
	);
	chmodSync(script, 0o755);
	const calls = () => {
		try {
			return readFileSync(join(dir, 'calls.txt'), 'utf8').trim().split('\n').filter((call) => !call.startsWith('list'));
		} catch {
			return [];
		}
	};
	return {
		config: { hcomCommand: [script], hcomListTimeoutMs: 10_000 } as BoardConfig,
		calls,
		names: () => (JSON.parse(readFileSync(join(dir, 'list.json'), 'utf8')) as { name: string }[]).map((agent) => agent.name),
		done: () => rmSync(dir, { recursive: true, force: true })
	};
}

test('the cleanup stops the same-tag agent with no terminal when kill has no tracked process, and leaves everything else', async () => {
	const fake = fakeHcom([
		{ name: 'auto-t-r-half', tag: 'auto-t-r', launch_context: null },
		{ name: 'auto-t-r-live', tag: 'auto-t-r', launch_context: { pane_id: 'p1' } },
		{ name: 'other-one', tag: 'other', launch_context: null }
	]);
	try {
		expect(await closeHalfLaunched(fake.config, 'auto-t-r')).toBeNull();
		expect(fake.calls()).toEqual(['kill auto-t-r-half', 'stop auto-t-r-half']);
		expect(fake.names()).toEqual(['auto-t-r-live', 'other-one']);
	} finally {
		fake.done();
	}
});

test('the cleanup uses kill alone when it works, and does nothing when no agent was left', async () => {
	const fake = fakeHcom([{ name: 'auto-t-r-half', tag: 'auto-t-r', launch_context: null }], true);
	try {
		expect(await closeHalfLaunched(fake.config, 'auto-t-r')).toBeNull();
		expect(await closeHalfLaunched(fake.config, 'auto-t-r')).toBeNull();
		expect(fake.calls()).toEqual(['kill auto-t-r-half']);
	} finally {
		fake.done();
	}
});
