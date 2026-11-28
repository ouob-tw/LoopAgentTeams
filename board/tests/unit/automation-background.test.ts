// A Claude agent that ends its turn on no verdict while its background work or a Monitor still runs
// (#750): the run goes on and its next reply is judged; past the limit it ends as a timeout; with no
// such work it fails as before. The records are shaped after the 2026-11-25 TAiHakka monthly scan's
// (background ZAP and ClamAV commands and a Monitor, then a turn ending "我等它們跑完再繼續").
import { expect, test } from 'bun:test';
import type { AutomationRun } from '../../src/lib/board/automation.ts';
import { watchAgent, type AgentHost, type Watched } from '../../src/lib/server/automation-agent.ts';
import { backgroundGoesOn } from '../../src/lib/server/claude-background.ts';

const line = (record: object) => JSON.stringify(record);
const said = (text: string) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const toolCall = (name: string) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${name}`, name, input: {} }] } });
const bashInBackground = (id: string) =>
	line({
		type: 'user',
		message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${id}`, content: `Command running in background with ID: ${id}. Output is being written to: /tmp/${id}.output.` }] },
		toolUseResult: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: id }
	});
const monitor = (id: string) =>
	line({
		type: 'user',
		message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${id}`, content: `Monitor started (task ${id}, expires in 30m unless the source ends first).` }] },
		toolUseResult: { taskId: id, timeoutMs: 1_800_000, persistent: false }
	});
const subAgent = (id: string) => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${id}`, content: 'Async agent launched' }] }, toolUseResult: { isAsync: true, status: 'async_launched', agentId: id } });
const notice = (ids: string[], status: string | null, event = '') =>
	`<task-notification>\n${ids.map((id) => `<task-id>${id}</task-id>\n`).join('')}${status ? `<status>${status}</status>\n` : ''}<summary>Background command finished</summary>\n${event ? `<event>${event}</event>\n` : ''}</task-notification>`;
/** A notice that woke the agent for a new turn. */
const given = (text: string) => line({ type: 'user', message: { role: 'user', content: text }, origin: { kind: 'task-notification' } });
/** A notice taken into a turn already going. */
const absorbed = (text: string) => line({ type: 'attachment', attachment: { type: 'queued_command', prompt: text } });
/** A notice Claude Code queued and has not given the agent yet. */
const queued = (text: string) => line({ type: 'queue-operation', operation: 'enqueue', content: text });
const record = (...lines: string[]) => lines.join('\n') + '\n';

/** The incident's turn: three background tasks started, one done meanwhile, then a reply with no verdict. */
const INCIDENT = [
	line({ type: 'user', message: { role: 'user', content: '讀取並照做 /work/automation/monthly-scan.md，完成後最後一行只回覆 DONE' } }),
	toolCall('Bash'),
	bashInBackground('bncagsjjm'),
	said('ZAP 固定容器已建立，全站掃描正在背景跑。'),
	toolCall('Bash'),
	bashInBackground('bupmshgz0'),
	queued(notice(['bncagsjjm'], 'completed')),
	absorbed(notice(['bncagsjjm'], 'completed')),
	toolCall('Monitor'),
	monitor('bfr9tlkp7'),
	said('ZAP 和 ClamAV 都還在跑，我等它們跑完再繼續做後面的步驟（截圖、報告、PDF、寄信）。')
];

test('background commands or a Monitor still running after the turn: work goes on', () => {
	expect(backgroundGoesOn(record(...INCIDENT))).toBe(true);
	// The ClamAV command done, the Monitor still on; and the other way round.
	expect(backgroundGoesOn(record(...INCIDENT, given(notice(['bupmshgz0'], 'completed')), said('ClamAV 好了，ZAP 還在跑。')))).toBe(true);
	expect(backgroundGoesOn(record(...INCIDENT, given(notice(['bfr9tlkp7'], 'completed')), said('ZAP 好了，ClamAV 還在跑。')))).toBe(true);
	// A background sub-agent is background work too.
	expect(backgroundGoesOn(record(toolCall('Agent'), subAgent('a0e0bed35e2f1aed3'), said('審查在背景跑。')))).toBe(true);
});

test('every task reported done (a notice may name several, a Monitor may expire) and replied after: nothing goes on', () => {
	expect(backgroundGoesOn(record(...INCIDENT, given(notice(['bupmshgz0', 'bfr9tlkp7', '__orphan_summary__:shell'], 'stopped')), said('背景工作都停了，我沒做完。')))).toBe(false);
	for (const status of ['completed', 'failed', 'killed']) {
		expect(backgroundGoesOn(record(...INCIDENT, given(notice(['bupmshgz0'], status)), said('一個好了'), given(notice(['bfr9tlkp7'], status)), said('都好了，但我沒寫結尾')))).toBe(false);
	}
	const expired = notice(['bfr9tlkp7'], null, '[Monitor expired after 30m with no events delivered. Re-arm it if you still need the watch.]');
	expect(backgroundGoesOn(record(...INCIDENT, given(notice(['bupmshgz0'], 'completed')), absorbed(expired), said('都結束了')))).toBe(false);
	// One the agent stopped itself: TaskStop's result, with no notice after it.
	const taskStop = line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: '{"message":"Successfully stopped task: bupmshgz0"}' }] }, toolUseResult: { message: 'Successfully stopped task: bupmshgz0 (ssh sp1 clamscan)', task_id: 'bupmshgz0', task_type: 'local_bash' } });
	expect(backgroundGoesOn(record(...INCIDENT, toolCall('TaskStop'), taskStop, given(notice(['bfr9tlkp7'], 'completed')), said('停掉了，沒寫結尾')))).toBe(false);
	// A turn with no background work at all.
	expect(backgroundGoesOn(record(toolCall('Bash'), line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] }, toolUseResult: { stdout: 'ok', stderr: '' } }), said('我做完了，但有點問題')))).toBe(false);
});

test('a notice only queued is still to come; one given after the last reply woke a turn that is on', () => {
	const allDone = [given(notice(['bupmshgz0'], 'completed')), said('ClamAV 好了')];
	// The Monitor's end queued, not given yet: Claude Code will wake the agent with it.
	expect(backgroundGoesOn(record(...INCIDENT, ...allDone, queued(notice(['bfr9tlkp7'], 'completed'))))).toBe(true);
	// Given, and the woken turn has not replied yet (a Monitor's plain event wakes it too).
	expect(backgroundGoesOn(record(...INCIDENT, ...allDone, given(notice(['bfr9tlkp7'], 'completed'))))).toBe(true);
	expect(backgroundGoesOn(record(said('等事件'), given(notice(['bxx'], null, 'line 1'))))).toBe(true);
	expect(backgroundGoesOn(record(said('等事件'), given(notice(['bxx'], null, 'line 1')), said('看到事件了')))).toBe(false);
});

test('a record that is empty, or has lines that are not JSON, says nothing', () => {
	expect(backgroundGoesOn('')).toBe(false);
	expect(backgroundGoesOn('not json\n{"type":"user","toolUseResult":\n')).toBe(false);
	// The readable lines still count.
	expect(backgroundGoesOn(record('{"broken', ...INCIDENT))).toBe(true);
});

const START = Date.UTC(2026, 10, 24, 18);
const NAME = 'auto-a60ed939a0-5bea28-vemona';

/** A host whose listening agent's replies are `replies` (the latest last); `background()` is what
 *  its conversation shows. Every look is a minute of board time. */
function fakeHost(clock: { now: number }, opts: { replies: string[]; background: () => boolean }) {
	const closed: string[] = [];
	let asked = 0;
	const host = {
		pollMs: 1,
		async list() {
			clock.now += 60_000;
			return { ok: true, agents: closed.length ? [] : [{ name: NAME, tag: null, sessionId: 's1', pane: null, status: 'listening' }] };
		},
		async lastReply() {
			return { ok: true, text: opts.replies.at(-1) ?? null, seq: opts.replies.length - 1 };
		},
		async repliesAfter() {
			return { ok: true, replies: [] };
		},
		async inputAfter() {
			return null;
		},
		async backgroundGoesOn() {
			asked += 1;
			return opts.background();
		},
		async close(agent: { name: string }) {
			closed.push(agent.name);
			return null;
		}
	} as unknown as AgentHost;
	return { host, closed, asked: () => asked };
}

function watched(clock: { now: number }, client: 'claude' | 'codex' = 'claude'): Watched {
	const run: AutomationRun = { id: 'mwv02jtv-5bea28b918', taskId: 'a60ed939a0', trigger: 'auto', period: 'p', startedAt: START, status: 'running', agentName: NAME, sessionId: 's1', launchedAt: START };
	return {
		run,
		spec: { client, model: 'claude-sonnet-5-5', effort: 'low', folder: '/work', brief: 'brief.md' },
		limitMinutes: 60,
		now: () => clock.now,
		cut: () => null,
		note: () => {},
		closing: () => false,
		adopted: false,
		asking: { waiting: () => false, replying: () => false, asked: () => {}, resumed: () => {} }
	};
}

const WAITING = 'ZAP 和 ClamAV 都還在跑，我等它們跑完再繼續做後面的步驟（截圖、報告、PDF、寄信）。';

test('a turn ending on no verdict with background work going leaves the run on and the agent open; the next DONE or FAILED ends it', async () => {
	for (const [last, status, reason] of [
		['報告寄出了。\nDONE', 'success', undefined],
		['FAILED: ZAP 掃描中斷', 'failed', 'Agent 回覆失敗：ZAP 掃描中斷']
	] as const) {
		const clock = { now: START };
		const replies = [WAITING];
		let running = true;
		const { host, closed, asked } = fakeHost(clock, { replies, background: () => running });
		const watching = watchAgent(host, watched(clock));
		// Ten looks with the work going: still on, nothing closed.
		while (asked() < 10) await Bun.sleep(1);
		expect(closed).toEqual([]);
		// The work done, the woken turn replies.
		running = false;
		replies.push(last);
		const ended = await watching;
		expect(ended).toEqual(reason ? { status, reason } : { status });
		expect(closed).toEqual([NAME]);
	}
});

test('background work still going past the limit ends the run as a timeout', async () => {
	const clock = { now: START };
	const { host, closed } = fakeHost(clock, { replies: [WAITING], background: () => true });
	const ended = await watchAgent(host, watched(clock));
	expect(ended).toEqual({ status: 'timeout', reason: '超過上限 60 分鐘，已停止' });
	expect(clock.now).toBeGreaterThanOrEqual(START + 60 * 60_000);
	expect(closed).toEqual([NAME]);
});

test('no background work going: a turn ending on no verdict fails at once, its reason as before; a Codex agent is never asked', async () => {
	const clock = { now: START };
	const { host, closed, asked } = fakeHost(clock, { replies: ['我做完了，但有點問題'], background: () => false });
	expect(await watchAgent(host, watched(clock))).toEqual({ status: 'failed', reason: '回合結束，但最後一行不是 DONE、FAILED 或 ASK：我做完了，但有點問題' });
	expect([asked(), closed, clock.now]).toEqual([1, [NAME], START + 60_000]);

	const codex = fakeHost(clock, { replies: [WAITING], background: () => true });
	expect((await watchAgent(codex.host, watched(clock, 'codex')))?.status).toBe('failed');
	expect(codex.asked()).toBe(0);
});
