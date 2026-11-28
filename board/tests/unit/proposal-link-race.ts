// The 任務提案 store in a process of its own whose result link is raced (#760): with a winner
// given, another writer links that result into place the moment the approval links 核准中, as a
// withdrawal, rejection or expiry landing in between would; with `none`, the approval links first
// and a withdrawal, a rejection and the expiry come after it. Prints one JSON line last.
// Run: bun tests/unit/proposal-link-race.ts <folder> <withdrawn|rejected|expired|none>
import { mock } from 'bun:test';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const [dir, winner] = process.argv.slice(2) as [string, string];
const ID = '0123456789ab';
const real = { ...fs };
let raced = false;
mock.module('node:fs', () => ({
	...real,
	linkSync: (from: fs.PathLike, to: fs.PathLike) => {
		if (!raced && winner !== 'none' && String(to).endsWith(`${ID}.result.json`)) {
			raced = true;
			const other = `${to}.other.tmp`;
			real.writeFileSync(other, JSON.stringify({ version: 1, id: ID, status: winner, at: new Date(0).toISOString() }));
			real.linkSync(other, to);
			real.rmSync(other);
		}
		return real.linkSync(from, to);
	}
}));
const { validateTask } = await import('../../src/lib/server/automation.ts');
const { createProposalStore } = await import('../../src/lib/server/task-proposals.ts');

const created = Date.parse('2026-11-28T01:00:00.000Z');
let now = created;
const checked = validateTask({ name: '每天備份', schedule: { type: 'daily' }, time: '09:30', limitMinutes: 30, kind: 'command', command: { command: 'echo hi', folder: dir, checks: [] } });
if (!('task' in checked)) throw new Error('the task does not pass');
const proposer = { name: 'grp-luna', client: 'codex' as const, role: 'agent' as const, folder: dir, pid: 1, startTime: 1, processId: 'process-luna', sessionId: 'session-luna' };
const file = { version: 1, id: ID, createdAt: new Date(created).toISOString(), expiresAt: new Date(created + 24 * 3600_000).toISOString(), proposer, input: {}, task: checked.task, brief: null };
const bytes = JSON.stringify(file);
fs.writeFileSync(join(dir, `${ID}.json`), bytes);
const hash = createHash('sha256').update(bytes).digest('hex');

let tasks = 0;
const store = createProposalStore({
	dir,
	now: () => now,
	createTask: (approval) => (tasks++, { ok: true, task: { id: approval.taskId } as never, existed: false })
});
const approved = store.approve(ID, hash, { deviceId: 'device', passkeyId: 'passkey' });
const after: unknown[] = [];
if (winner === 'none') {
	after.push(store.withdraw(proposer, ID), store.reject(ID, '晚了', 'device'));
	now = created + 25 * 3600_000;
	store.sweep();
}
const result = JSON.parse(fs.readFileSync(join(dir, `${ID}.result.json`), 'utf8'));
console.log(JSON.stringify({ approved, after, tasks, status: result.status }));
