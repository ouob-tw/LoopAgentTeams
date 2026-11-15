// A run that waits to retry a locked hcom launch (#657) ends the usual way on 停止這次 or the time limit.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import type { AutomationRun } from '../../src/lib/board/automation.ts';
import type { AgentHost } from '../../src/lib/server/automation-agent.ts';
import { createAutomation } from '../../src/lib/server/automation.ts';

/** Run one agent task whose launch waits for the run to be halted, then gives up with that cut. */
async function runHalted(end: (halt: { stop(): boolean | null; clock: { now: number } }) => void): Promise<AutomationRun> {
	const root = mkdtempSync(join(tmpdir(), 'launch-halt-'));
	const work = join(root, 'work');
	mkdirSync(join(work, 'docs'), { recursive: true });
	writeFileSync(join(work, 'docs/brief.md'), '# 任務\n');
	const clock = { now: Date.UTC(2026, 10, 18, 4) };
	let launches = 0;
	const agents = {
		pollMs: 10,
		async launch(spec: Parameters<AgentHost['launch']>[0]) {
			launches++;
			let cut = spec.halted!();
			while (!cut) {
				await new Promise((resolve) => setTimeout(resolve, 5));
				cut = spec.halted!();
			}
			return { ok: false as const, reason: 'database is locked', cut };
		}
	} as unknown as AgentHost;
	const automation = createAutomation({ dir: join(root, 'automation'), home: root, now: () => clock.now, publish: () => {}, agents, tickMs: 3_600_000 });
	try {
		const made = automation.create({
			name: 'Agent 任務',
			schedule: { type: 'monthly', fromDay: 1, toDay: 2 },
			time: '02:00',
			limitMinutes: 30,
			kind: 'agent',
			agent: { client: 'claude', model: 'claude-haiku-5-5', effort: 'low', folder: work, brief: 'docs/brief.md' },
			review: { enabled: false, checklist: [] }
		});
		if (!('task' in made)) throw new Error(JSON.stringify(made));
		automation.runNow(made.task.id);
		await new Promise((resolve) => setTimeout(resolve, 50));
		end({ stop: () => automation.stop(made.task.id), clock });
		await automation.idle();
		expect(launches).toBe(1);
		return automation.snapshot().tasks.find((view) => view.task.id === made.task.id)!.runs[0]!;
	} finally {
		automation.close();
		rmSync(root, { recursive: true, force: true });
	}
}

test('停止這次 while the launch waits to retry ends the run as stopped', async () => {
	const run = await runHalted(({ stop }) => stop());
	expect(run).toMatchObject({ status: 'stopped', reason: '使用者按了停止這次' });
});

test('the time limit passing while the launch waits to retry ends the run as timed out', async () => {
	const run = await runHalted(({ clock }) => (clock.now += 31 * 60_000));
	expect(run).toMatchObject({ status: 'timeout', reason: '超過上限 30 分鐘，已停止' });
});
