// 結果通知 and the 7-day cleanup (#767): a message that finishes after its proposal was cleared
// leaves no record. The proposer has no session, so nothing is sent and hcom is never run.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createProposalNotifier } from '../../src/lib/server/task-proposal-notify.ts';
import { createProposalStore } from '../../src/lib/server/task-proposals.ts';

const NOW = Date.parse('2026-11-28T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const PROPOSER = { name: 'luna', client: 'codex', role: 'agent', folder: '/tmp', pid: 1, startTime: 1, processId: 'p1', sessionId: null } as const;

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'lat-proposal-notify-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** An invalid proposal, whose result is told at once: the message is still going on return. */
function endedProposal() {
	let at = NOW;
	const notifier = createProposalNotifier({ dir, now: () => at, config: { hcomCommand: ['false'], hcomListTimeoutMs: 1_000 } });
	const store = createProposalStore({ dir, now: () => at, ended: notifier.tell });
	const reply = store.submit(PROPOSER, {});
	if (!reply.ok) throw new Error(reply.reason);
	/** The sweep 7 days after the result. */
	const clear = () => {
		at = NOW + 7 * DAY;
		store.sweep();
	};
	return { id: reply.id, notifier, clear };
}

test('a message that finishes after its proposal was cleared leaves no file', async () => {
	const { notifier, clear } = endedProposal();
	clear();
	expect(readdirSync(dir)).toEqual([]);
	await notifier.idle();
	expect(readdirSync(dir)).toEqual([]);
});

test('a message that finishes in time is recorded, and the cleanup removes the record', async () => {
	const { id, notifier, clear } = endedProposal();
	await notifier.idle();
	expect(readdirSync(dir).sort()).toEqual([`${id}.json`, `${id}.notify.json`, `${id}.result.json`]);
	clear();
	expect(readdirSync(dir)).toEqual([]);
});
