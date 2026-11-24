// A task's agent that never starts (#702): hcom recording its launch as `launch_blocked` (a prompt
// such as Claude Code's folder trust question on its screen) fails the run at once, naming the
// prompt; an agent with no session NO_SESSION_MINUTES after its launch fails as never started. Both
// close the stuck agent and end the run the way other failures do (red card, push). A launch slowed
// by hcom's lock retries, or a session that comes a few minutes late, is not failed.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { runAlertKind } from '../../src/lib/board/alerts.ts';
import type { AutomationRun } from '../../src/lib/board/automation.ts';
import type { BoardConfig } from '../../src/lib/server/config.ts';
import { NEVER_STARTED, NO_SESSION_MINUTES, blockedReason, watchAgent, type AgentHost, type ListedAgent, type Watched } from '../../src/lib/server/automation-agent.ts';
import { createAutomation, type AutomationEvent } from '../../src/lib/server/automation.ts';
import { launchBlocked } from '../../src/lib/server/hcom.ts';
import { NODE } from '../harness.ts';

const TRUST_SCREEN =
	'launch blocked: screen settled but the hcom plugin never connected; run `hcom term mitoza`\nhere.\nSecurity guide\n❯ No, exit\nYes, I trust this folder\nEnter to confirm · Esc to cancel';
const START = Date.UTC(2026, 10, 24, 0);
const NAME = 'auto-t1-abc123-mitoza';

/** A host whose agent hcom lists as `agent()` says; `blocked()` is what hcom recorded of its launch. */
function fakeHost(clock: { now: number }, opts: { agent: () => Partial<ListedAgent> | null; blocked?: () => string | null; reply?: () => string | null }) {
	const closed: { sessionId: string | null; name: string }[] = [];
	const blockedAsked: { name: string; since: number }[] = [];
	const host = {
		pollMs: 1,
		async list() {
			// Every look at the agent is a minute of board time.
			clock.now += 60_000;
			const agent = opts.agent();
			return { ok: true, agents: agent ? [{ name: NAME, tag: null, sessionId: null, pane: null, status: 'blocked', ...agent }] : [] };
		},
		async launchBlocked(name: string, since: number) {
			blockedAsked.push({ name, since });
			return opts.blocked?.() ?? null;
		},
		async lastReply() {
			const text = opts.reply?.() ?? null;
			return { ok: true, text, seq: text === null ? -1 : 1 };
		},
		async close(agent: { sessionId: string | null; name: string }) {
			closed.push(agent);
			return null;
		}
	} as unknown as AgentHost;
	return { host, closed, blockedAsked };
}

function watched(clock: { now: number }, run: Partial<AutomationRun> = {}): Watched {
	return {
		run: { id: 'r1', taskId: 't1', trigger: 'manual', period: 'p', startedAt: START, status: 'running', agentName: NAME, launchedAt: START, ...run },
		spec: { client: 'claude', model: 'claude-haiku-5-5', effort: 'low', folder: '/work', brief: 'brief.md' },
		limitMinutes: 180,
		now: () => clock.now,
		cut: () => null,
		note: () => {},
		closing: () => false,
		adopted: false
	};
}

test('a launch hcom recorded as blocked on the trust prompt fails at once, names the prompt, and closes the agent', async () => {
	const clock = { now: START };
	const { host, closed, blockedAsked } = fakeHost(clock, { agent: () => ({}), blocked: () => TRUST_SCREEN });
	const ended = await watchAgent(host, watched(clock));
	expect(ended).toEqual({ status: 'failed', reason: 'Agent 沒有啟動：卡在 Claude Code 的資料夾信任提示（Yes, I trust this folder），hcom 等不到它連上' });
	expect(closed).toEqual([{ sessionId: null, name: NAME }]);
	// Looked up since the run started, so an event recorded during the launch itself still counts.
	expect(blockedAsked).toEqual([{ name: NAME, since: START }]);
	expect(clock.now - START).toBeLessThan(5 * 60_000);
});

test('another blocked screen is named by what it shows', () => {
	expect(blockedReason('launch blocked: screen settled but the hcom plugin never connected\nPick a theme\n❯ Dark')).toBe('Agent 沒有啟動：卡在啟動畫面，hcom 等不到它連上：Pick a theme ／ ❯ Dark');
	expect(blockedReason('launch blocked: no screen')).toBe('Agent 沒有啟動：卡在啟動畫面，hcom 等不到它連上');
});

test('an agent with no session NO_SESSION_MINUTES after its launch fails as never started and is closed', async () => {
	const clock = { now: START };
	const { host, closed } = fakeHost(clock, { agent: () => ({}) });
	const ended = await watchAgent(host, watched(clock));
	expect(ended).toEqual({ status: 'failed', reason: NEVER_STARTED });
	expect(NEVER_STARTED).toContain('沒有啟動');
	// Failed at the look that reached NO_SESSION_MINUTES, after one more list right before closing.
	expect(clock.now - START).toBe((NO_SESSION_MINUTES + 1) * 60_000);
	expect(closed).toEqual([{ sessionId: null, name: NAME }]);
});

test('an agent that gets its session right before it would be closed is watched on, not failed', async () => {
	const clock = { now: START };
	const sessionAt = START + (NO_SESSION_MINUTES + 1) * 60_000;
	const { host, closed } = fakeHost(clock, {
		agent: () => (clock.now >= sessionAt ? { sessionId: 's1', status: 'listening' } : {}),
		blocked: () => (clock.now >= sessionAt - 60_000 ? TRUST_SCREEN : null),
		reply: () => 'DONE'
	});
	expect(await watchAgent(host, watched(clock))).toEqual({ status: 'success' });
	expect(closed).toEqual([{ sessionId: 's1', name: NAME }]);
});

test('a list that cannot be read right before closing closes nothing; the next look decides', async () => {
	const clock = { now: START };
	let looks = 0;
	const { host, closed } = fakeHost(clock, { agent: () => ({}), blocked: () => TRUST_SCREEN });
	const list = host.list.bind(host);
	host.list = async () => (++looks === 2 ? { ok: false, reason: 'hcom 讀不到' } : list());
	expect(await watchAgent(host, watched(clock))).toEqual({ status: 'failed', reason: blockedReason(TRUST_SCREEN) });
	// The first close was skipped on the unreadable list; the next look (list, then the re-check) closed it.
	expect(looks).toBe(4);
	expect(closed).toEqual([{ sessionId: null, name: NAME }]);
});

test('the no-session wait is longer than the lock retries, counted from the launch, not the run start', async () => {
	expect(NO_SESSION_MINUTES * 60_000).toBeGreaterThan(60_000 + 120_000 + 240_000);
	// The launch took the whole lock-retry wait (7 minutes after the run started); the session comes 9 minutes after it.
	const clock = { now: START + 7 * 60_000 };
	const sessionAt = clock.now + 9 * 60_000;
	const { host, closed } = fakeHost(clock, {
		agent: () => (clock.now >= sessionAt ? { sessionId: 's1', status: 'listening' } : {}),
		reply: () => (clock.now >= sessionAt ? 'DONE' : null)
	});
	const ended = await watchAgent(host, watched(clock, { launchedAt: START + 7 * 60_000 }));
	expect(ended).toEqual({ status: 'success' });
	expect(closed).toEqual([{ sessionId: 's1', name: NAME }]);
});

test('a run adopted at restart with no launch time counts from its start', async () => {
	const clock = { now: START + 9 * 60_000 };
	const { host } = fakeHost(clock, { agent: () => ({}) });
	const ended = await watchAgent(host, { ...watched(clock, { launchedAt: undefined }), adopted: true });
	expect(ended).toEqual({ status: 'failed', reason: NEVER_STARTED });
	expect(clock.now).toBe(START + (NO_SESSION_MINUTES + 1) * 60_000);
});

test('a blocked launch ends the task run as failed, with the run-ended event that makes the red card and push', async () => {
	const root = mkdtempSync(join(tmpdir(), 'launch-blocked-'));
	const work = join(root, 'work');
	mkdirSync(join(work, 'docs'), { recursive: true });
	writeFileSync(join(work, 'docs/brief.md'), '# 任務\n');
	const clock = { now: START };
	const events: AutomationEvent[] = [];
	const closed: string[] = [];
	const agents = {
		pollMs: 1,
		async launch() {
			return { ok: true as const, name: NAME, workspace: 'wA' };
		},
		async list() {
			return { ok: true, agents: [{ name: NAME, tag: null, sessionId: null, pane: null, status: 'blocked' }] };
		},
		async launchBlocked() {
			return TRUST_SCREEN;
		},
		async close(agent: { name: string }) {
			closed.push(agent.name);
			return null;
		}
	} as unknown as AgentHost;
	const automation = createAutomation({ dir: join(root, 'automation'), home: root, now: () => clock.now, publish: () => {}, agents, tickMs: 3_600_000, notify: (event) => void events.push(event) });
	try {
		const made = automation.create({
			name: '主機安全檢查',
			schedule: { type: 'monthly', fromDay: 1, toDay: 2 },
			time: '02:00',
			limitMinutes: 180,
			kind: 'agent',
			agent: { client: 'claude', model: 'claude-haiku-5-5', effort: 'low', folder: work, brief: 'docs/brief.md' },
			review: { enabled: false, checklist: [] }
		});
		if (!('task' in made)) throw new Error(JSON.stringify(made));
		automation.runNow(made.task.id);
		await automation.idle();
		const run = automation.snapshot().tasks.find((view) => view.task.id === made.task.id)!.runs[0]!;
		expect(run).toMatchObject({ status: 'failed', reason: blockedReason(TRUST_SCREEN), agentName: NAME, launchedAt: START });
		expect(closed).toEqual([NAME]);
		const end = events.find((event) => event.type === 'run-ended');
		expect(end && 'run' in end && end.run.id).toBe(run.id);
		expect(runAlertKind(run)).not.toBeNull();
	} finally {
		automation.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('hcom launch_blocked events: the agent\'s own, since the run started; nothing when unreadable', async () => {
	const event = (instance: string, ts: string, detail: string, action = 'launch_blocked') => JSON.stringify({ id: 1, type: 'life', instance, ts, data: { action, detail, reason: 'screen_settled_not_ready' } });
	const lines = [
		event('mitoza', '2026-11-23T23:00:00', 'an older launch'),
		event('other', '2026-11-24T00:01:00', 'someone else'),
		event('mitoza', '2026-11-24T00:01:00', 'a ready event', 'ready'),
		event('mitoza', '2026-11-24T00:00:00', TRUST_SCREEN)
	];
	// Prints the events only when asked for the agent's launch_blocked life events after the run started (a second early), as the real hcom filters.
	const expected = ['events', '--type', 'life', '--action', 'launch_blocked', '--agent', NAME, '--full', '--after'];
	const printing = (text: string) =>
		({
			hcomCommand: [
				NODE,
				'-e',
				`const a = process.argv.slice(1); const ok = ${JSON.stringify(JSON.stringify(expected))} === JSON.stringify(a.slice(0, ${expected.length})) && Date.parse(a[${expected.length}]) <= ${START}; process.stdout.write(ok ? ${JSON.stringify(text)} : '')`
			],
			hcomListTimeoutMs: 10_000
		}) as BoardConfig;
	// The event's time is whole seconds and may fall in the same second the run started.
	expect(await launchBlocked(printing(lines.join('\n') + '\n'), NAME, START + 500)).toBe(TRUST_SCREEN);
	expect(await launchBlocked(printing(lines.slice(0, 3).join('\n') + '\n'), NAME, START)).toBeNull();
	expect(await launchBlocked(printing('not json\n'), NAME, START)).toBeNull();
	expect(await launchBlocked(printing(event('mitoza', 'not a time', TRUST_SCREEN) + '\n'), NAME, START)).toBeNull();
	expect(await launchBlocked({ hcomCommand: [NODE, '-e', 'process.exit(1)'], hcomListTimeoutMs: 10_000 } as BoardConfig, NAME, START)).toBeNull();
});
