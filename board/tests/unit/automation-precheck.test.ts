// The no-checklist check before a rerun (#751) when reading the failed run's conversation is slow: the
// read began in the failed run's period and ends after it. A DONE found then settles that period, not
// the one the clock is in by then; anything else leaves the rerun to the scheduler's next check, which
// starts none outside the run window.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import type { AutomationRun, AutomationSchedule } from '../../src/lib/board/automation.ts';
import type { AgentHost } from '../../src/lib/server/automation-agent.ts';
import { createAutomation } from '../../src/lib/server/automation.ts';

/** A wall-clock time in Asia/Taipei. */
const tpe = (month: number, day: number, hour: number, minute = 0) => Date.UTC(2026, month - 1, day, hour - 8, minute);
const sleep = (ms: number) => new Promise((wait) => setTimeout(wait, ms));

async function slowRead(schedule: AutomationSchedule, reply: { text: string; time: number | null }) {
	const root = mkdtempSync(join(tmpdir(), 'precheck-'));
	const work = join(root, 'work');
	mkdirSync(work, { recursive: true });
	writeFileSync(join(work, 'brief.md'), '# 任務\n');
	const dir = join(root, 'automation');
	const clock = { now: tpe(11, 1, 23, 0) };
	const base = { now: () => clock.now, home: root, publish: () => {}, tickMs: 3_600_000 };
	const setup = createAutomation({ ...base, dir });
	const made = setup.create({ name: '月報', schedule, time: '23:59', limitMinutes: 30, kind: 'agent', agent: { client: 'claude', model: 'claude-haiku-5-5', effort: 'low', folder: work, brief: 'brief.md' }, review: { enabled: false, checklist: [] } });
	setup.close();
	if (!('task' in made)) throw new Error(JSON.stringify(made));
	const id = made.task.id;
	const failed: AutomationRun = { id: 'mf-failed0001', taskId: id, trigger: 'manual', period: '', startedAt: tpe(11, 1, 23, 0), endedAt: tpe(11, 1, 23, 1), status: 'failed', sessionId: 's1', reason: '回合結束，但最後一行不是 DONE' };
	failed.period = schedule.type === 'monthly' ? '2026-11' : '2026-11-01';
	appendFileSync(join(dir, 'runs', `${id}.jsonl`), JSON.stringify(failed) + '\n');

	let release!: () => void;
	const held = new Promise<void>((done) => (release = done));
	const launched: string[] = [];
	const agents = {
		pollMs: 1,
		async lastReply() {
			await held;
			return { ok: true, text: reply.text, seq: 3, time: reply.time };
		},
		async launch(spec: { tag: string }) {
			launched.push(spec.tag);
			return { ok: false, reason: 'not in this test' };
		}
	} as unknown as AgentHost;
	clock.now = tpe(11, 1, 23, 59);
	const automation = createAutomation({ ...base, dir, agents, tickMs: 5 });
	await sleep(50);
	// The read is under way; the period ends before it does.
	clock.now = tpe(11, 2, 0, 1);
	release();
	await sleep(100);
	const view = automation.snapshot().tasks.find((each) => each.task.id === id)!;
	automation.close();
	rmSync(root, { recursive: true, force: true });
	return { view, launched, failed };
}

test('a DONE found after the period ended settles the failed run’s period, and the new period’s try stays due', async () => {
	const { view, launched, failed } = await slowRead({ type: 'daily' }, { text: '寄出了\nDONE', time: tpe(11, 1, 23, 30) });
	const settled = view.runs.find((run) => run.precheck);
	expect(settled).toMatchObject({ status: 'success', period: failed.period, precheck: { of: failed.id, by: 'reply', repliedAt: tpe(11, 1, 23, 30) } });
	expect(launched).toEqual([]);
	expect(view.nextAt).toBe(tpe(11, 2, 23, 59));
});

test('a reply that settles nothing, read after the window ended, starts no rerun outside it', async () => {
	const { view, launched } = await slowRead({ type: 'monthly', fromDay: 1, toDay: 1 }, { text: '還在跑', time: tpe(11, 1, 23, 30) });
	expect(view.runs.filter((run) => run.precheck)).toEqual([]);
	expect(launched).toEqual([]);
	expect(view.runs).toHaveLength(1);
});

test('a DONE written before the run was judged failed settles nothing', async () => {
	const { view } = await slowRead({ type: 'monthly', fromDay: 1, toDay: 1 }, { text: 'DONE', time: tpe(11, 1, 23, 0) + 30_000 });
	expect(view.runs.filter((run) => run.precheck)).toEqual([]);
});
