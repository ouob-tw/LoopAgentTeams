// A controller's work ledger on its page: read through the helper's `board ledger` (which runs
// `lat-ledger show --json`), never from the file; no ledger and a failed read each say so on that
// controller alone, and a write to the ledger file reads it in again.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { named, startFixture, until, type Fixture } from '../harness.ts';

let fixture: Fixture;
let cookie: string;

beforeAll(async () => {
	fixture = await startFixture();
	cookie = await fixture.login();
});
afterAll(() => fixture.cleanup());

const shown = (ticket: string, late: Record<string, number>) => ({
	status: 'ok',
	ledger: {
		updated_at: '2026-10-24T11:00:00Z',
		items: [{ id: 1, ticket, stage_label: '實作', status_label: '進行中', agent: 'a', estimate: null, deadline: '2026-10-24T10:00:00Z', late_minutes: late, history: [] }]
	}
});

test('each controller shows its own ledger, no ledger or the reason it could not be read', async () => {
	const luna = fixture.bound('alpha', 'luna');
	const nova = fixture.bound('beta', 'nova');
	const vega = fixture.bound('gamma', 'vega');
	fixture.setHelper({
		output: { controllers: [luna, nova, vega] },
		ledgers: { [luna.session_id]: shown('#302', { deadline: 65 }), [vega.session_id]: { status: 'error', reason: 'ledger was modified outside lat-ledger' } }
	});

	const snapshot = await fixture.refresh(cookie);

	expect(named(snapshot, 'luna')!.ledger).toMatchObject({ state: 'ok', items: [{ ticket: '#302', late: { deadline: 65 } }] });
	expect(named(snapshot, 'nova')!.ledger).toEqual({ state: 'none' });
	expect(named(snapshot, 'vega')!.ledger).toEqual({ state: 'error', reason: 'ledger was modified outside lat-ledger' });
	// The rest of the page is read as before.
	expect(named(snapshot, 'vega')!.error).toBeNull();
	const [call] = fixture.helperArgs('ledger').slice(-1);
	expect(call).toEqual(['board', 'ledger', expect.stringMatching(/^--seconds=/), ...[luna, nova, vega].flatMap((c) => [`--workspace=${c.workspace}`, `--session-id=${c.session_id}`])]);
});

test('a failed helper run shows its reason on every ledger and leaves the roster alone', async () => {
	const luna = fixture.bound('alpha', 'luna');
	fixture.setHelper({ output: { controllers: [luna] }, ledger: { raw: 'not json', exit: 1 } });

	const snapshot = await fixture.refresh(cookie);

	expect(named(snapshot, 'luna')!.ledger).toMatchObject({ state: 'error' });
	expect(named(snapshot, 'luna')!.status).toBe('working');
});

test('the ledger reads get half the helper time, however short the board sets it', async () => {
	const short = await startFixture({ env: { LAT_BOARD_FALLBACK_SECONDS: '5' } });
	try {
		const luna = short.bound('alpha', 'luna');
		short.list([luna]);
		await short.refresh(await short.login());

		// Five seconds between fallback reads leave the helper one second.
		expect(short.helperArgs('ledger').at(-1)?.[2]).toBe('--seconds=0.5');
	} finally {
		await short.cleanup();
	}
});

test('a write to the ledger file is read in without a manual refresh', async () => {
	const luna = fixture.bound('alpha', 'luna');
	const path = join(luna.workspace, '.lat/ledgers', `${luna.session_id}-r1.json`);
	mkdirSync(join(luna.workspace, '.lat/ledgers'), { recursive: true });
	writeFileSync(path, '{}\n');
	fixture.setHelper({ output: { controllers: [luna] }, ledgers: { [luna.session_id]: { ...shown('#1', {}), ledger_path: path } } });
	await fixture.refresh(cookie);
	const watch = await fixture.watch(cookie);
	try {
		// The plan changes first, then the file: only the write can bring the new ticket in.
		fixture.setHelper({ output: { controllers: [luna] }, ledgers: { [luna.session_id]: { ...shown('#2', {}), ledger_path: path } } });
		writeFileSync(path, '{"changed": true}\n');

		await until(() => {
			const ledger = named(watch.latest(), 'luna')?.ledger;
			return ledger?.state === 'ok' && ledger.items[0]?.ticket === '#2';
		}, 10_000, 'the ledger write to be read in');
	} finally {
		watch.close();
	}
});
