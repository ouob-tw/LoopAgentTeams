// Archive rules, checked at each point in time with the board's clock set by the test.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BoardSnapshot, InboxReport } from '../src/lib/board/types.ts';
import { DAY, named, startFixture, titled, type Fixture } from './harness.ts';

let fixture: Fixture;
let cookie: string;
let other: string;
const ISSUED = Date.parse('2026-05-01T08:00:00.000Z');
const iso = (time: number) => new Date(time).toISOString();

/** Move the board's clock and read what it shows then. */
async function on(time: number): Promise<BoardSnapshot> {
	fixture.setClock(time);
	return fixture.refresh(cookie);
}
const archived = async (title: string, as = cookie) => (await fixture.archive(as)).find((report) => report.title === title);
const unread = (snapshot: BoardSnapshot) =>
	snapshot.inbox.filter((item) => item.kind === 'report' && item.readAt === null).map((item) => item.title);

beforeAll(async () => {
	fixture = await startFixture(8);
	cookie = await fixture.login();
	other = await fixture.login('second-device');
	fixture.setClock(ISSUED);
});
afterAll(() => fixture.cleanup());

test('an unread report stays 7 days from when it was issued, then moves to the archive', async () => {
	const workspace = `${fixture.dir}/workspaces/alpha`;
	const message = '第一行\n第二行\n\nDONE: 一直沒讀';
	fixture.report('session-unread', { tag: 'DONE', summary: '一直沒讀', message, time: iso(ISSUED), hcom_name: 'luna', workspace });

	expect(titled(await on(ISSUED + 6 * DAY), '一直沒讀')).toBeDefined();
	expect(titled(await on(ISSUED + 7 * DAY - 1), '一直沒讀')).toBeDefined();
	expect(await archived('一直沒讀')).toBeUndefined();

	// Exactly 7 days is archived; so is day 8.
	expect(titled(await on(ISSUED + 7 * DAY), '一直沒讀')).toBeUndefined();
	const day8 = await on(ISSUED + 8 * DAY);
	expect(titled(day8, '一直沒讀')).toBeUndefined();
	expect(unread(day8)).not.toContain('一直沒讀');
	expect(day8.archivedCount).toBeGreaterThanOrEqual(1);

	// In the archive it still opens in full and says whose it is, though the controller is gone.
	expect(named(day8, 'luna')).toBeUndefined();
	expect(await archived('一直沒讀')).toMatchObject({ message, project: 'alpha', hcomName: 'luna', tag: 'DONE', readAt: null });
	// Archiving never deletes the report record.
	expect(existsSync(join(fixture.reportsDir, 'session-unread.jsonl'))).toBe(true);
});

test('a report read on the day it was issued is archived exactly 7 days after it was issued, not at 3', async () => {
	const workspace = `${fixture.dir}/workspaces/alpha`;
	fixture.report('session-read-early', { tag: 'HELP', summary: '當天就讀', time: iso(ISSUED), hcom_name: 'nova', workspace });

	const { key } = titled(await on(ISSUED), '當天就讀')!;
	expect((await fixture.markRead(cookie, key)).status).toBe(200);

	// Being read no longer shortens its stay: day 3 and day 4 pass without archiving.
	expect(titled(await on(ISSUED + 3 * DAY), '當天就讀')).toMatchObject({ readAt: iso(ISSUED) });
	expect(titled(await on(ISSUED + 4 * DAY), '當天就讀')).toBeDefined();
	expect(titled(await on(ISSUED + 7 * DAY - 1), '當天就讀')).toBeDefined();
	expect(titled(await on(ISSUED + 7 * DAY), '當天就讀')).toBeUndefined();
	expect(await archived('當天就讀')).toMatchObject({ tag: 'HELP', project: 'alpha', hcomName: 'nova', readAt: iso(ISSUED) });
});

test('a report read on day 6 is archived on day 7 like an unread one', async () => {
	const workspace = `${fixture.dir}/workspaces/alpha`;
	fixture.report('session-read-late', { tag: 'DONE', summary: '第六天才讀', time: iso(ISSUED), hcom_name: 'miro', workspace });

	const { key } = titled(await on(ISSUED + 6 * DAY), '第六天才讀')!;
	expect((await fixture.markRead(cookie, key)).status).toBe(200);

	expect(titled(await on(ISSUED + 7 * DAY - 1), '第六天才讀')).toBeDefined();
	expect(titled(await on(ISSUED + 7 * DAY), '第六天才讀')).toBeUndefined();
	expect(await archived('第六天才讀')).toMatchObject({ readAt: iso(ISSUED + 6 * DAY) });
});

test('an ended controller stays on the roster until its last report is archived; the reports still open', async () => {
	const workspace = `${fixture.dir}/workspaces/gamma`;
	fixture.report('session-two', { tag: 'HELP', summary: '較早的求助', time: iso(ISSUED), hcom_name: 'vega', workspace });
	fixture.report('session-two', { tag: 'NO REPLY', summary: '中間的進度', time: iso(ISSUED + DAY), hcom_name: 'vega', workspace });
	fixture.report('session-two', { tag: 'DONE', summary: '較晚的交付', message: '交付全文\n\nDONE: 較晚的交付', time: iso(ISSUED + 2 * DAY), hcom_name: 'vega', workspace, final: true });

	const day8 = await on(ISSUED + 8 * DAY);
	expect(titled(day8, '較早的求助')).toBeUndefined();
	expect(titled(day8, '較晚的交付')).toBeDefined();
	expect(named(day8, 'vega')).toMatchObject({ status: 'ended' });

	const day10 = await on(ISSUED + 10 * DAY);
	expect(titled(day10, '較晚的交付')).toBeUndefined();
	expect(named(day10, 'vega')).toBeUndefined();
	expect(await archived('較晚的交付')).toMatchObject({ message: '交付全文\n\nDONE: 較晚的交付', project: 'gamma', hcomName: 'vega' });
	expect(await archived('較早的求助')).toBeDefined();
	// A report that never was an inbox item is not in the archive either.
	expect(await archived('中間的進度')).toBeUndefined();
});

test('the archive lists newest first and is the same on another paired device', async () => {
	const mine = await fixture.archive(cookie);

	expect(mine.length).toBeGreaterThanOrEqual(5);
	expect(mine.map((report) => report.time)).toEqual(mine.map((report) => report.time).toSorted().toReversed());
	expect(await fixture.archive(other)).toEqual(mine);
	const { generatedAt: _mine, ...here } = await fixture.board(cookie);
	const { generatedAt: _theirs, ...there } = await fixture.board(other);
	expect(there).toEqual(here);
});

test('an archived report cannot be marked read or unread and never returns to the inbox', async () => {
	const workspace = `${fixture.dir}/workspaces/alpha`;
	fixture.report('session-sticky', { tag: 'DONE', summary: '封存後不回信箱', time: iso(ISSUED + 20 * DAY), hcom_name: 'luna', workspace });
	const { key } = titled(await on(ISSUED + 21 * DAY), '封存後不回信箱')!;
	await on(ISSUED + 28 * DAY);

	expect((await fixture.markRead(cookie, key)).status).toBe(409);
	expect((await fixture.markUnread(cookie, key)).status).toBe(409);
	expect((await archived('封存後不回信箱'))!.readAt).toBeNull();

	// Even with the clock back before the deadline, and across a restart.
	expect(titled(await on(ISSUED + 21 * DAY), '封存後不回信箱')).toBeUndefined();
	await fixture.stop();
	await fixture.start();
	expect(titled(await fixture.board(cookie), '封存後不回信箱')).toBeUndefined();
	expect(await archived('封存後不回信箱')).toBeDefined();
});

test('a report that became due since the last read is archived, not marked read', async () => {
	const workspace = `${fixture.dir}/workspaces/alpha`;
	fixture.report('session-due', { tag: 'DONE', summary: '到期後才按已讀', time: iso(ISSUED + 40 * DAY), hcom_name: 'luna', workspace });
	const { key } = titled(await on(ISSUED + 41 * DAY), '到期後才按已讀')!;

	// The clock passes the deadline, but the board has not re-read anything yet.
	fixture.setClock(ISSUED + 48 * DAY);

	expect((await fixture.markRead(cookie, key)).status).toBe(409);
	expect(titled(await fixture.board(cookie), '到期後才按已讀')).toBeUndefined();
	expect((await archived('到期後才按已讀'))!.readAt).toBeNull();
});

test('reports of an active controller are archived by the same rules, and it stays on the roster', async () => {
	const luna = fixture.bound('delta', 'active-one');
	fixture.report(luna.session_id, { tag: 'DONE', summary: '啟用中主控的舊回報', time: iso(ISSUED + 60 * DAY), hcom_name: 'active-one', workspace: luna.workspace });
	fixture.list([luna]);

	const snapshot = await on(ISSUED + 68 * DAY);

	expect(titled(snapshot, '啟用中主控的舊回報')).toBeUndefined();
	expect(named(snapshot, 'active-one')).toMatchObject({ status: 'delivered' });
	expect(((await archived('啟用中主控的舊回報')) as InboxReport).controllerId).toBe(luna.session_id);
});

test('an unusable state file is reported without making up which reports are read or archived', async () => {
	const workspace = `${fixture.dir}/workspaces/epsilon`;
	const start = ISSUED + 80 * DAY;
	const steady = fixture.bound('epsilon', 'steady');
	fixture.list([steady]);
	// Issued on day 0, so on day 8 it is archived; its ended controller has left the roster.
	fixture.report('session-early', { tag: 'DONE', summary: '早發已封存', time: iso(start), hcom_name: 'early', workspace });
	// Issued on day 4 and read on day 6, so on day 8 it is still in the inbox, read.
	fixture.report('session-late', { tag: 'DONE', summary: '晚發仍保留', time: iso(start + 4 * DAY), hcom_name: 'late', workspace });
	await fixture.markRead(cookie, titled(await on(start + 4 * DAY), '早發已封存')!.key);
	await fixture.markRead(cookie, titled(await on(start + 6 * DAY), '晚發仍保留')!.key);
	const before = await on(start + 8 * DAY);
	expect(titled(before, '早發已封存')).toBeUndefined();
	expect(named(before, 'early')).toBeUndefined();
	expect(titled(before, '晚發仍保留')).toMatchObject({ readAt: iso(start + 6 * DAY) });
	const stateFile = join(fixture.dir, 'board-state', 'inbox.json');
	const good = readFileSync(stateFile, 'utf8');

	// While running, the board keeps the state it last read.
	writeFileSync(stateFile, '{ not json');
	const stale = await fixture.refresh(cookie);
	expect(stale.errors.join()).toContain('回報沿用上次讀到的狀態');
	expect({ ...stale, errors: [] as string[], generatedAt: '' }).toEqual({ ...before, generatedAt: '' });
	expect((await fixture.markRead(cookie, titled(stale, '晚發仍保留')!.key)).status).toBe(500);
	expect((await fixture.fetch('/api/archive', { cookie })).status).toBe(500);
	expect(readFileSync(stateFile, 'utf8')).toBe('{ not json');

	// Started without ever having read it, the board lists no report rather than guessing.
	await fixture.stop();
	await fixture.start();
	const cold = await fixture.board(cookie);
	expect(cold.errors.join()).toContain('回報暫時不列出');
	expect(cold.inbox.filter((item) => item.kind === 'report')).toEqual([]);
	expect(cold.archivedCount).toBe(0);
	expect(named(cold, 'steady')).toBeDefined();
	expect(named(cold, 'early')).toBeUndefined();
	expect(readFileSync(stateFile, 'utf8')).toBe('{ not json');

	// Putting the file back brings the read marks and the archive back.
	writeFileSync(stateFile, good);
	const repaired = await fixture.refresh(cookie);
	expect({ ...repaired, generatedAt: '' }).toEqual({ ...before, generatedAt: '' });
	expect(await archived('早發已封存')).toBeDefined();
});
