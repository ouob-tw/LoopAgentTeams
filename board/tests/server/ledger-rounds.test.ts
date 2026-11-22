// A controller's earlier LAT rounds (#694): read through the helper's `board ledger-rounds` when
// its 工作總表 tab opens, newest first, each with its ledger or the reason it could not be read. An
// ended round's ledger whose files have not changed is not read again: the next read names it
// `--known` and the kept one stands in.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fiveStepLedger, ticketLedger } from '../fixtures/ledger-tickets.ts';
import { startFixture, type Fixture } from '../harness.ts';
import type { LedgerRounds } from '../../src/lib/board/ledger.ts';

let fixture: Fixture;
let cookie: string;

beforeAll(async () => {
	fixture = await startFixture();
	cookie = await fixture.login();
});
afterAll(() => fixture.cleanup());

/** Files written a minute ago, so a read now may keep what it read from them. */
function oldFile(path: string, text = '') {
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, text);
	const then = new Date(Date.now() - 60_000);
	utimesSync(path, then, then);
}

test('earlier rounds come newest first with their ledgers, an unreadable one with its reason, and a kept one is not read again', async () => {
	const luna = fixture.bound('alpha', 'luna');
	const ledgers = join(luna.workspace, '.lat/ledgers');
	const [first, second] = [join(ledgers, 's-r1.json'), join(ledgers, 's-r2.json')];
	oldFile(second, '{}');
	oldFile(join(luna.workspace, '.lat/problems.jsonl'));
	fixture.setHelper({
		output: { controllers: [luna] },
		rounds: {
			[luna.session_id]: {
				current: { round: 3, started_at: '2026-11-12T08:00:00Z' },
				earlier: [
					{ round: 2, ledger_path: second, started_at: '2026-11-11T09:00:00Z', ended_at: '2026-11-11T12:30:00Z', status: 'ok', ledger: { ...ticketLedger(luna.workspace), ledger: second } },
					{ round: 1, ledger_path: first, started_at: '2026-11-10T15:00:00Z', ended_at: '2026-11-10T17:00:00Z', status: 'error', reason: 'no ledger at s-r1.json' }
				]
			}
		}
	});
	await fixture.refresh(cookie);

	const read = async () => {
		const response = await fixture.fetch(`/api/ledger/rounds?controller=${luna.session_id}`, { cookie });
		expect(response.status).toBe(200);
		return ((await response.json()) as { rounds: LedgerRounds }).rounds;
	};
	const rounds = await read();

	expect(rounds.current).toEqual({ round: 3, startedAt: '2026-11-12T08:00:00Z' });
	expect(rounds.earlier.map((round) => [round.round, round.startedAt, round.endedAt, round.ledger.state])).toEqual([
		[2, '2026-11-11T09:00:00Z', '2026-11-11T12:30:00Z', 'ok'],
		[1, '2026-11-10T15:00:00Z', '2026-11-10T17:00:00Z', 'error']
	]);
	expect(rounds.earlier[0].ledger.state === 'ok' && rounds.earlier[0].ledger.tickets.length).toBe(7);
	expect(rounds.earlier[1].ledger).toEqual({ state: 'error', reason: 'no ledger at s-r1.json' });
	expect(fixture.helperArgs('ledger-rounds').at(-1)).toEqual(['board', 'ledger-rounds', `--workspace=${luna.workspace}`, `--session-id=${luna.session_id}`, expect.stringMatching(/^--seconds=/)]);

	// Read again: the kept round is named known and stands in; the unreadable one is asked again.
	const again = await read();
	expect(fixture.helperArgs('ledger-rounds').at(-1)).toContain(`--known=${second}`);
	expect(again).toEqual(rounds);

	// A write to that round's ledger reads it again.
	writeFileSync(second, '{"changed": true}');
	await read();
	expect(fixture.helperArgs('ledger-rounds').at(-1)).not.toContain(`--known=${second}`);
});

test('a controller in its first round has no earlier rounds; an unknown controller and a failed read say why', async () => {
	const nova = fixture.bound('beta', 'nova');
	fixture.setHelper({ output: { controllers: [nova] }, ledgers: { [nova.session_id]: { status: 'ok', ledger: fiveStepLedger(nova.workspace) } } });
	await fixture.refresh(cookie);

	const single = await fixture.fetch(`/api/ledger/rounds?controller=${nova.session_id}`, { cookie });
	expect(await single.json()).toEqual({ rounds: { current: { round: 1, startedAt: null }, earlier: [] } });
	expect((await fixture.fetch('/api/ledger/rounds?controller=nobody', { cookie })).status).toBe(404);

	fixture.setHelper({ output: { controllers: [nova] }, 'ledger-rounds': { output: { status: 'error', reason: '讀不到 session 紀錄：boom' }, exit: 1 } });
	const failed = await fixture.fetch(`/api/ledger/rounds?controller=${nova.session_id}`, { cookie });
	expect(failed.status).toBe(502);
	expect(await failed.json()).toEqual({ reason: '讀不到 session 紀錄：boom' });
	// Signed-out pages get nothing.
	expect((await fixture.fetch(`/api/ledger/rounds?controller=${nova.session_id}`)).status).not.toBe(200);
});
