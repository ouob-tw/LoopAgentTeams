// The pd 待核准 section's data as the built board serves it: read from a fake pd standing in for pd
// and its daemon (tests/fake-pd.mjs, which keeps the daemon's pending list in a file), pushed over
// the event stream with nothing pd keeps to itself, and denied end to end through `pd deny <id>`.
// pd only ever gets `pending --json` and `deny <id>`; there is no way to approve through the board.
// pd missing or its daemon down leaves the rest of the board alone.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { startFixture, until, type Fixture } from '../harness.ts';

let fixture: Fixture | undefined;
afterEach(async () => {
	await fixture?.cleanup();
	fixture = undefined;
});

const waiting = (id: number, item: string) => ({
	id,
	waiting: 3,
	remaining: 117,
	caller: 'claude',
	item,
	item_id: `item-uuid-${id}`,
	fields: ['password'],
	argv: ['gh', 'api', 'user'],
	cwd: '/home/u/work',
	approval_url: `https://pd.example.net/?request=${id}`
});

const writePending = (board: Fixture, state: unknown) => writeFileSync(join(board.dir, 'pd.json'), JSON.stringify(state));
const calls = (board: Fixture) =>
	readFileSync(join(board.dir, 'pd-calls.jsonl'), 'utf8')
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line));
const deny = (board: Fixture, cookie: string, id: unknown) =>
	board.fetch('/api/pd/deny', { method: 'POST', cookie, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });

test('waiting requests reach the page, and 拒絕 denies one through pd deny', async () => {
	fixture = await startFixture({ env: { LAT_BOARD_PD_SECONDS: '1' } });
	const board = fixture;
	writePending(board, { pending: [waiting(7, 'GitHub token'), waiting(8, 'npm token')] });
	const cookie = await board.login();
	const watch = board.watch(cookie);
	const listed = await until(() => watch.pds.findLast((pd) => pd.ok && pd.requests.length === 2), 10_000, 'both requests listed');
	expect(listed.ok && listed.requests[0]).toEqual({
		id: 7,
		caller: 'claude',
		item: 'GitHub token',
		fields: ['password'],
		command: ['gh', 'api', 'user'],
		cwd: '/home/u/work',
		waiting: 3,
		remaining: 117,
		approvalUrl: 'https://pd.example.net/?request=7'
	});
	expect(JSON.stringify(watch.pds)).not.toContain('item-uuid');
	// The page comes with the reading already, so the section does not push the inbox down later.
	const page = await (await board.fetch('/', { cookie })).text();
	expect(page).toContain('npm token');
	expect(page).not.toContain('item-uuid');

	const denied = await deny(board, cookie, 7);
	expect(denied.status).toBe(200);
	expect(await denied.json()).toEqual({ ok: true });
	// The daemon no longer holds it, and the page is told.
	expect(JSON.parse(readFileSync(join(board.dir, 'pd.json'), 'utf8')).pending.map((request: { id: number }) => request.id)).toEqual([8]);
	await until(() => watch.pds.findLast((pd) => pd.ok && pd.requests.length === 1 && pd.requests[0].id === 8), 2_000, 'the denied one gone');

	// Denied already, or never there: said so, and the rest stays waiting.
	const again = await deny(board, cookie, 7);
	expect(again.status).toBe(409);
	expect((await again.json()).error).toContain('已不在待核准清單');
	for (const id of ['8', 0, 1.5, null]) expect((await deny(board, cookie, id)).status).toBe(400);

	// pd was only ever asked for its list and to deny: nothing that approves, and no code.
	for (const args of calls(board)) expect([['pending', '--json'], ['deny', '7']]).toContainEqual(args);
	const json = { 'content-type': 'application/json' };
	expect((await board.fetch('/api/pd/approve', { method: 'POST', cookie, headers: json, body: '{"id":8}' })).status).toBe(404);
	expect((await board.fetch('/api/pd/deny', { method: 'POST', headers: json, body: '{"id":8}' })).status).toBe(401);
});

test('pd missing or its daemon down is one quiet reason, and the board reads on as before', async () => {
	fixture = await startFixture({ env: { LAT_BOARD_PD_SECONDS: '1' } });
	const board = fixture;
	writePending(board, { pending: [], unavailable: true });
	const cookie = await board.login();
	const watch = board.watch(cookie);
	await until(() => watch.pds.findLast((pd) => !pd.ok && pd.reason === '連不上 pd 服務'), 10_000, 'the daemon down');
	expect(JSON.stringify(watch.pds)).not.toContain('pd.sock');
	expect((await deny(board, cookie, 7)).status).toBe(503);
	expect((await board.refresh(cookie)).errors).toEqual([]);
	await fixture.cleanup();

	fixture = await startFixture({ env: { LAT_BOARD_PD_COMMAND: JSON.stringify(['/nonexistent/pd']) } });
	const missing = fixture;
	const missingCookie = await missing.login();
	const missingWatch = missing.watch(missingCookie);
	await until(() => missingWatch.pds.findLast((pd) => !pd.ok && pd.reason === '這台主機沒有安裝 pd'), 10_000, 'pd missing');
	expect((await missing.refresh(missingCookie)).errors).toEqual([]);
});
