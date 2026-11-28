// Approval against withdrawal, rejection and expiry on the result file's link (#760), interleaved
// on purpose: the other result lands between the approval's last check and its link of 核准中, so
// the approval loses and makes no task; or the approval links first, and each later one loses and
// changes nothing. Each case runs in a process of its own (proposal-link-race.ts), in a temporary folder.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../harness.ts';

let dir = '';
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'lat-proposal-race-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function race(winner: string) {
	const run = await runCli(process.execPath, [join(import.meta.dir, 'proposal-link-race.ts'), dir, winner], { env: { PATH: process.env.PATH ?? '', HOME: dir } });
	expect(run.code).toBe(0);
	return JSON.parse(run.stdout.trim().split('\n').at(-1)!);
}

for (const winner of ['withdrawn', 'rejected', 'expired'])
	test(`${winner === "expired" ? "an" : "a"} ${winner} result linked just before 核准中 wins: the approval answers ended and makes no task`, async () => {
		const outcome = await race(winner);
		expect(outcome.approved).toMatchObject({ ok: false, error: 'ended', result: winner });
		expect(outcome.tasks).toBe(0);
		expect(outcome.status).toBe(winner);
	});

test('an approval linked first wins: a later withdrawal, rejection and expiry change nothing, and there is one task', async () => {
	const outcome = await race('none');
	expect(outcome.approved).toMatchObject({ ok: true, status: 'approved', taskId: 'proposal-0123456789ab' });
	expect(outcome.after).toMatchObject([
		{ ok: false, error: 'ended', status: 'approved' },
		{ ok: false, error: 'ended', result: 'approved' }
	]);
	expect(outcome.tasks).toBe(1);
	expect(outcome.status).toBe('approved');
});
