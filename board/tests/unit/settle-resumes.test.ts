// A read of the board closes the open resumes by hcom's and Herdr's lists, which it asked for at
// its start. A resume logged after that start is left open: those lists say nothing of it yet.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SentWake } from '../../src/lib/board/wake.ts';
import { appendSent, openLog, readLines } from '../../src/lib/server/sent-log.ts';
import { openResume } from '../../src/lib/server/sent-views.ts';
import { settleResumes } from '../../src/lib/server/wake.ts';

const NOW = Date.parse('2026-11-09T08:00:00.000Z');
const WAIT_MS = 60_000;
let stateDir: string;

const wake = (time: number): SentWake => ({
	id: 'wake-1', kind: 'wake', time: new Date(time).toISOString(), controllerId: 's-lead', hcomName: 'lead', text: '',
	route: 'resume', herdrWorkspace: null, herdrWorkspaceLabel: null, workspaceCreated: false, resumedName: null, pane: null, extraArgs: [],
	outcome: 'pending', error: null
});
/** hcom lists the controller running in its old pane: the session as it was before it stopped. */
const listed = [{ name: 'lead', sessionId: 's-lead', pane: 'wA:p-old', status: 'listening' }];

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), 'lat-settle-resumes-'));
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

function settle(listedAt: number) {
	const log = openLog(stateDir, NOW + 1_000);
	try {
		expect(settleResumes(log, listed, null, NOW + 1_000, WAIT_MS, listedAt)).toBeNull();
	} finally {
		log.close();
	}
	return openResume(readLines(stateDir, NOW + 1_000), 's-lead', NOW + 1_000, WAIT_MS);
}

test('lists asked for before the resume was logged leave it open, with no pane', () => {
	appendSent(stateDir, wake(NOW));
	expect(settle(NOW - 500)).toMatchObject({ id: 'wake-1', pane: null });
});

test('lists asked for after the resume was logged close it, in the pane they show', () => {
	appendSent(stateDir, wake(NOW));
	expect(settle(NOW + 500)).toBeNull();
	expect(readLines(stateDir, NOW + 1_000).filter((line) => line.kind !== 'wake')).toMatchObject([
		{ kind: 'resume-pane', wakeId: 'wake-1', pane: 'wA:p-old' },
		{ kind: 'resume-closed', wakeId: 'wake-1', result: 'succeeded' }
	]);
});
