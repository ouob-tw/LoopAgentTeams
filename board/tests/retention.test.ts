// The archive's pages and the 30-day retention, with the board's clock set by the test. Report
// files past retention are deleted by the real helper command, on this test's reports directory.
import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BoardSnapshot, HelperController, InboxReport } from '../src/lib/board/types.ts';
import { DAY, named, sleep, startFixture, titled, until, uvPython, type Fixture } from './harness.ts';

// Pruning runs after a read; several tests wait for it, or for a slow helper.
setDefaultTimeout(30_000);

let fixture: Fixture;
let cookie: string;
let python: string;
const T0 = Date.parse('2026-03-01T08:00:00.000Z');
const iso = (time: number) => new Date(time).toISOString();

async function on(time: number) {
	fixture.setClock(time);
	return fixture.refresh(cookie);
}
/** Read again until `check` holds: pruning runs after a read, not within it. */
async function eventually(check: (snapshot: BoardSnapshot) => boolean, what: string): Promise<BoardSnapshot> {
	const deadline = Date.now() + 15_000;
	for (;;) {
		const snapshot = await fixture.refresh(cookie);
		if (check(snapshot)) return snapshot;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(100);
	}
}
/** List these controllers, with prune-reports run by the real helper. */
const list = (controllers: HelperController[]) => fixture.setHelper({ output: { controllers }, realPrune: python });
const inboxState = () => {
	const file = join(fixture.dir, 'board-state/inbox.json');
	return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { read: {}, archived: {} };
};
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
	await eventually(() => !has('session-ended'), 'the file to be deleted');
	// The lock file stays: a hook waiting on it and one arriving later must share the one lock.
	expect(has('session-ended', '.lock')).toBe(true);
	expect(Object.keys(inboxState().archived).filter((key) => key.startsWith('session-ended#'))).toEqual([]);
	expect(fixture.helperArgs('prune-reports').at(-1)).toEqual([
		'board',
		'prune-reports',
		`--reports-dir=${fixture.reportsDir}`,
		`--now=${iso(T0 + 32 * DAY)}`,
		'--session-id=session-ended'
	]);

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
		const asked = fixture.helperArgs('prune-reports').length;
		const held = await on(T0 + 40 * DAY);
		await until(() => fixture.helperArgs('prune-reports').length > asked, 10_000, 'the helper to be asked');
		await sleep(1_500);
		expect(held.errors).toEqual([]);
		expect(has('session-busy')).toBe(true);
		// Left for later, but past retention: listed nowhere, its state already cleared.
		expect(held.archivedCount).toBe(0);
		expect(titled(held, '鎖住了')).toBeUndefined();
		expect(Object.keys(inboxState().archived).filter((key) => key.startsWith('session-busy#'))).toEqual([]);

		holder.kill();
		await until(() => holder.exitCode !== null || holder.signalCode !== null, 10_000, 'the lock holder to end');
		await eventually(() => !has('session-busy'), 'the file to be deleted');
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

	await on(T0 + 30 * DAY);
	// Read after both files are gone.
	const after = await eventually(
		(next) => !has(luna.session_id) && !has(orin.session_id) && named(next, 'luna')?.phase === null,
		'both files to be deleted and read in'
	);
	expect(after.errors).toEqual([]);
	expect(named(after, 'luna')).toMatchObject({ status: 'working', phase: null, lastReportAt: null, error: null, pendingCount: 0 });
	expect(named(after, 'orin')).toBeUndefined();
	expect(after.archivedCount).toBe(0);
	fixture.setHcom({});
});

const stateDir = () => join(fixture.dir, 'board-state');

test('when the read and archive state cannot be saved first, nothing is deleted', async () => {
	const workspace = `${fixture.dir}/workspaces/alpha`;
	fixture.report('session-unsaved', { tag: 'DONE', summary: '存不了', time: iso(T0), hcom_name: 'vega', workspace });
	await on(T0 + 10 * DAY);
	const asked = fixture.helperArgs('prune-reports').length;
	chmodSync(stateDir(), 0o500);
	try {
		fixture.setClock(T0 + 31 * DAY);
		const snapshot = await eventually(
			(next) => next.errors.some((error) => error.startsWith('超過 30 天的回報紀錄沒有刪除，下次重讀再試：已讀與封存紀錄沒辦法先清掉')),
			'the save failure to be shown'
		);
		expect(fixture.helperArgs('prune-reports')).toHaveLength(asked);
		expect(has('session-unsaved')).toBe(true);
		// Past retention it is listed nowhere in the meantime.
		expect(snapshot.archivedCount).toBe(0);
		expect(titled(snapshot, '存不了')).toBeUndefined();
	} finally {
		chmodSync(stateDir(), 0o700);
	}
	await eventually(() => !has('session-unsaved'), 'the file to be deleted');
	expect(Object.keys(inboxState().archived).filter((key) => key.startsWith('session-unsaved#'))).toEqual([]);
});

test('a report marked read while the helper runs does not give the deleted reports state back', async () => {
	const workspace = `${fixture.dir}/workspaces/alpha`;
	fixture.report('session-race', { tag: 'DONE', summary: '要刪的', time: iso(T0), hcom_name: 'vega', workspace });
	fixture.report('session-other', { tag: 'DONE', summary: '還在信箱', time: iso(T0 + 26 * DAY), hcom_name: 'luna', workspace });
	await on(T0 + 10 * DAY);
	expect(Object.keys(inboxState().archived)).toContain('session-race#0');

	// The helper takes a while and deletes the file, as the real one would.
	fixture.setHelper({ output: { controllers: [] }, 'prune-reports': { output: { status: 'ok', deleted: ['session-race'], failed: [] }, sleepMs: 1500 } });
	fixture.setClock(T0 + 30 * DAY);
	await fixture.refresh(cookie);
	await until(() => !Object.keys(inboxState().archived).includes('session-race#0'), 10_000, 'the state to be cleared first');
	const other = titled(await fixture.board(cookie), '還在信箱')!;
	expect((await fixture.markRead(cookie, other.key)).status).toBe(200);
	expect(Object.keys(inboxState().archived)).not.toContain('session-race#0');
	expect(inboxState().read).toHaveProperty(other.key);
	rmSync(join(fixture.reportsDir, 'session-race.jsonl'));
	await sleep(2_000);
	await fixture.refresh(cookie);
	expect(Object.keys(inboxState().archived)).not.toContain('session-race#0');

	// Written again, the session's first report is unread in the inbox.
	list([]);
	fixture.report('session-race', { tag: 'DONE', summary: '新的', time: iso(T0 + 30 * DAY), hcom_name: 'vega', workspace });
	expect(titled(await on(T0 + 30 * DAY), '新的')).toMatchObject({ key: 'session-race#0', readAt: null });
});

test('a failed prune is shown and tried again at the next read', async () => {
	fixture.report('session-old', { tag: 'DONE', summary: '舊的', time: iso(T0), hcom_name: 'vega', workspace: `${fixture.dir}/workspaces/alpha` });
	fixture.setHelper({ output: { controllers: [] }, 'prune-reports': { output: { status: 'error', reason: '磁碟壞了' }, exit: 1 } });
	fixture.setClock(T0 + 31 * DAY);
	await eventually((next) => next.errors.join() === '超過 30 天的回報紀錄沒有刪除，下次重讀再試：磁碟壞了', 'the failure to be shown');

	// A file that could not be deleted does not hide the ones that were.
	fixture.setHelper({
		output: { controllers: [] },
		'prune-reports': { output: { status: 'ok', deleted: ['session-gone'], failed: [{ session_id: 'session-stuck', reason: '權限不足' }] } }
	});
	await eventually((next) => next.errors.join() === '超過 30 天的回報紀錄沒有刪除，下次重讀再試：session-stuck：權限不足', 'the partial failure');

	list([]);
	await eventually((next) => next.errors.length === 0 && !has('session-old'), 'the error to clear and the file to go');
});

test('a slow helper does not hold up the snapshot', async () => {
	fixture.report('session-slow', { tag: 'DONE', summary: '慢慢刪', time: iso(T0), hcom_name: 'vega', workspace: `${fixture.dir}/workspaces/alpha` });
	fixture.setHelper({ output: { controllers: [] }, 'prune-reports': { output: { status: 'ok', deleted: [], failed: [] }, sleepMs: 4_000 } });
	const asked = fixture.helperArgs('prune-reports').length;
	fixture.setClock(T0 + 31 * DAY);
	const started = Date.now();
	await fixture.refresh(cookie);
	await until(() => fixture.helperArgs('prune-reports').length > asked, 10_000, 'the helper to be asked');
	await fixture.refresh(cookie);
	expect(Date.now() - started).toBeLessThan(3_000);
	await sleep(3_000);
	list([]);
});
