// The archive's pages and the 30-day retention, with the board's clock set by the test. Report
// files past retention are deleted by the real helper command, on this test's reports directory.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HelperController, InboxReport } from '../src/lib/board/types.ts';
import { DAY, named, startFixture, titled, until, uvPython, type Fixture } from './harness.ts';

let fixture: Fixture;
let cookie: string;
let python: string;
const T0 = Date.parse('2026-03-01T08:00:00.000Z');
const iso = (time: number) => new Date(time).toISOString();

async function on(time: number) {
	fixture.setClock(time);
	return fixture.refresh(cookie);
}
/** List these controllers, with prune-reports run by the real helper. */
const list = (controllers: HelperController[]) => fixture.setHelper({ output: { controllers }, realPrune: python });
const inboxState = () => JSON.parse(readFileSync(join(fixture.dir, 'board-state/inbox.json'), 'utf8'));
const has = (session: string, suffix = '.jsonl') => existsSync(join(fixture.reportsDir, `${session}${suffix}`));

beforeAll(async () => {
	python = uvPython();
	fixture = await startFixture(27);
	cookie = await fixture.login();
});
afterAll(() => fixture.cleanup());
beforeEach(() => {
	rmSync(fixture.reportsDir, { recursive: true, force: true });
	mkdirSync(fixture.reportsDir);
	rmSync(join(fixture.dir, 'board-state/inbox.json'), { force: true });
	list([]);
});

test('the archive comes 50 at a time, newest first, each page after the last one, none twice or missing', async () => {
	const workspace = `${fixture.dir}/workspaces/alpha`;
	const expected: string[] = [];
	// 120 reports in three files; pairs share a moment, so the order has to decide between them.
	for (let index = 0; index < 120; index++) {
		const time = T0 + Math.floor(index / 2) * 60_000;
		fixture.report(`session-${index % 3}`, { tag: 'DONE', summary: `回報 ${index}`, time: iso(time), hcom_name: 'luna', workspace });
		expected.push(`回報 ${index}`);
	}
	const snapshot = await on(T0 + 10 * DAY);
	expect(snapshot.archivedCount).toBe(120);

	const sizes: number[] = [];
	const seen: InboxReport[] = [];
	let before: string | null = null;
	do {
		const response = await fixture.archivePage(cookie, before);
		expect(response.status).toBe(200);
		const page: { reports: InboxReport[]; before: string | null } = await response.json();
		sizes.push(page.reports.length);
		seen.push(...page.reports);
		before = page.before;
	} while (before !== null);

	expect(sizes).toEqual([50, 50, 20]);
	expect(new Set(seen.map((report) => report.key)).size).toBe(120);
	expect(seen.map((report) => report.title).toSorted()).toEqual(expected.toSorted());
	const times = seen.map((report) => Date.parse(report.time));
	expect(times).toEqual(times.toSorted((a, b) => b - a));

	expect((await fixture.archivePage(cookie, 'not-a-cursor')).status).toBe(400);
	// A cursor from before more reports were archived still continues where it left off.
	const first: { before: string } = await (await fixture.archivePage(cookie)).json();
	fixture.report('session-new', { tag: 'DONE', summary: '新封存', time: iso(T0 + 2 * DAY), hcom_name: 'luna', workspace });
	await on(T0 + 10 * DAY);
	const newest: { reports: InboxReport[] } = await (await fixture.archivePage(cookie)).json();
	expect(newest.reports[0].title).toBe('新封存');
	const second: { reports: InboxReport[] } = await (await fixture.archivePage(cookie, first.before)).json();
	expect(second.reports.map((report) => report.key)).toEqual(seen.slice(50, 100).map((report) => report.key));
});

test('the archive lists reports for 30 days; a file is deleted when its newest report is 30 days old', async () => {
	const workspace = `${fixture.dir}/workspaces/alpha`;
	// Two reports, two days apart: the older one leaves the archive first, the file stays.
	fixture.report('session-ended', { tag: 'DONE', summary: '較早的', time: iso(T0), hcom_name: 'vega', workspace });
	fixture.report('session-ended', { tag: 'HELP', summary: '較晚的', time: iso(T0 + 2 * DAY), hcom_name: 'vega', workspace });
	const titles = async () => (await fixture.archive(cookie)).map((report) => report.title);

	expect((await on(T0 + 30 * DAY - 1)).archivedCount).toBe(2);
	expect(await titles()).toEqual(['較晚的', '較早的']);

	expect((await on(T0 + 30 * DAY)).archivedCount).toBe(1);
	expect(await titles()).toEqual(['較晚的']);
	expect(has('session-ended')).toBe(true);

	expect((await on(T0 + 32 * DAY - 1)).archivedCount).toBe(1);
	expect(has('session-ended')).toBe(true);
	const keys = Object.keys(inboxState().archived);
	expect(keys.filter((key) => key.startsWith('session-ended#'))).toHaveLength(2);

	expect((await on(T0 + 32 * DAY)).archivedCount).toBe(0);
	expect(await titles()).toEqual([]);
	expect(has('session-ended')).toBe(false);
	// The lock file stays: a hook waiting on it and one arriving later must share the one lock.
	expect(has('session-ended', '.lock')).toBe(true);
	expect(Object.keys(inboxState().archived).filter((key) => key.startsWith('session-ended#'))).toEqual([]);
	expect(fixture.helperArgs('prune-reports').at(-1)).toEqual([
		'board',
		'prune-reports',
		`--reports-dir=${fixture.reportsDir}`,
		`--now=${iso(T0 + 32 * DAY)}`,
		`--receipts=${join(fixture.dir, 'board-state/pruned')}`
	]);
	// The helper's receipt is gone once the state was saved without the session.
	expect(readdirSync(join(fixture.dir, 'board-state/pruned'))).toEqual([]);

	// A report written again for that session starts over: unread in the inbox, not archived.
	fixture.report('session-ended', { tag: 'DONE', summary: '回來了', time: iso(T0 + 32 * DAY), hcom_name: 'vega', workspace });
	const back = await on(T0 + 32 * DAY);
	expect(titled(back, '回來了')).toMatchObject({ key: 'session-ended#0', readAt: null });
	expect(named(back, 'vega')).toMatchObject({ status: 'ended' });
});

test('a file whose lock is held is left until a later read', async () => {
	const workspace = `${fixture.dir}/workspaces/alpha`;
	fixture.report('session-busy', { tag: 'DONE', summary: '鎖住了', time: iso(T0), hcom_name: 'vega', workspace });
	const lock = join(fixture.reportsDir, 'session-busy.lock');
	const holder = spawn(python, ['-c', 'import fcntl, sys, time\nf = open(sys.argv[1], "a")\nfcntl.flock(f, fcntl.LOCK_EX)\nprint("locked", flush=True)\ntime.sleep(60)', lock]);
	let said = '';
	holder.stdout.on('data', (chunk) => (said += chunk));
	try {
		await until(() => said.includes('locked'), 10_000, 'the lock to be held');
		const inode = statSync(lock).ino;
		expect((await on(T0 + 40 * DAY)).errors).toEqual([]);
		expect(has('session-busy')).toBe(true);

		holder.kill();
		await until(() => holder.exitCode !== null || holder.signalCode !== null, 10_000, 'the lock holder to end');
		await on(T0 + 40 * DAY);
		expect(has('session-busy')).toBe(false);
		expect(statSync(lock).ino).toBe(inode);
	} finally {
		holder.kill();
	}
});

test('after pruning, a bound running controller shows as usual and a closed one is gone', async () => {
	const luna = fixture.bound('beta', 'luna');
	const orin = fixture.bound('alpha', 'orin');
	fixture.report(luna.session_id, { tag: 'DONE', summary: 'luna 的舊交付', time: iso(T0), hcom_name: 'luna', workspace: luna.workspace });
	fixture.report(orin.session_id, { tag: 'DONE', summary: 'orin 的舊交付', time: iso(T0), hcom_name: 'orin', workspace: orin.workspace });
	list([luna, orin]);
	fixture.setHcom({ agents: [{ name: 'luna', session_id: luna.session_id }] });

	const before = await on(T0 + 29 * DAY);
	expect(named(before, 'luna')).toMatchObject({ status: 'delivered', phase: 'luna 的舊交付' });
	expect(named(before, 'orin')).toBeUndefined();
	expect(before.archivedCount).toBe(2);

	const after = await on(T0 + 30 * DAY);
	expect(has(luna.session_id)).toBe(false);
	expect(has(orin.session_id)).toBe(false);
	expect(after.errors).toEqual([]);
	expect(named(after, 'luna')).toMatchObject({ status: 'working', phase: null, lastReportAt: null, error: null, pendingCount: 0 });
	expect(named(after, 'orin')).toBeUndefined();
	expect(after.archivedCount).toBe(0);
	fixture.setHcom({});
});

test('a receipt left by a helper run cut short, or before a restart, still clears that session', async () => {
	const workspace = `${fixture.dir}/workspaces/alpha`;
	fixture.report('session-cut', { tag: 'DONE', summary: '舊的', time: iso(T0), hcom_name: 'vega', workspace });
	await on(T0 + 10 * DAY);
	expect(Object.keys(inboxState().archived)).toContain('session-cut#0');

	// The helper deleted the file and left its receipt, then was killed before printing anything.
	rmSync(join(fixture.reportsDir, 'session-cut.jsonl'));
	mkdirSync(join(fixture.dir, 'board-state/pruned'), { recursive: true });
	writeFileSync(join(fixture.dir, 'board-state/pruned/session-cut'), '');
	fixture.setHelper({ output: { controllers: [] }, 'prune-reports': { output: { status: 'error', reason: '輔助工具逾時' }, exit: 1 } });
	await on(T0 + 10 * DAY);
	expect(Object.keys(inboxState().archived)).not.toContain('session-cut#0');
	expect(readdirSync(join(fixture.dir, 'board-state/pruned'))).toEqual([]);

	// The session's next report starts over in the inbox, unread.
	list([]);
	fixture.report('session-cut', { tag: 'DONE', summary: '新的', time: iso(T0 + 10 * DAY), hcom_name: 'vega', workspace });
	expect(titled(await on(T0 + 10 * DAY), '新的')).toMatchObject({ key: 'session-cut#0', readAt: null });
});

test('a failed prune is shown and tried again at the next read', async () => {
	fixture.setHelper({ output: { controllers: [] }, 'prune-reports': { output: { status: 'error', reason: '磁碟壞了' }, exit: 1 } });
	const failed = await on(T0);
	expect(failed.errors).toEqual(['超過 30 天的回報紀錄沒有刪除，下次重讀再試：磁碟壞了']);

	// A file that could not be deleted does not hide the ones that were.
	fixture.setHelper({
		output: { controllers: [] },
		'prune-reports': { output: { status: 'ok', deleted: ['session-gone'], failed: [{ session_id: 'session-stuck', reason: '權限不足' }] } }
	});
	expect((await on(T0)).errors).toEqual(['超過 30 天的回報紀錄沒有刪除，下次重讀再試：session-stuck：權限不足']);

	list([]);
	expect((await on(T0)).errors).toEqual([]);
});
