import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { named, question, startFixture, until, type Fixture } from './harness.ts';

let fixture: Fixture;
let cookie: string;

beforeAll(async () => {
	fixture = await startFixture(4, { env: { LAT_BOARD_HELPER_TIMEOUT_SECONDS: '1' } });
	cookie = await fixture.login();
});
afterAll(() => fixture.cleanup());

test('a corrupt question file shows an error on its controller and leaves the others alone', async () => {
	const broken = fixture.bound('alpha', 'luna', { error: 'duplicate question id Q-1', questions: [] });
	const healthy = fixture.bound('beta', 'nova', { questions: [question()] });
	fixture.report(broken.session_id, { tag: 'NO REPLY', summary: '照常回報', hcom_name: 'luna', workspace: broken.workspace });
	fixture.report(healthy.session_id, { tag: 'NO REPLY', summary: '實作中', hcom_name: 'nova', workspace: healthy.workspace });
	fixture.list([broken, healthy]);

	const snapshot = await fixture.refresh(cookie);

	expect(named(snapshot, 'luna')!.error).toContain('duplicate question id Q-1');
	expect(named(snapshot, 'luna')).toMatchObject({ status: 'working', phase: '照常回報' });
	expect(named(snapshot, 'nova')).toMatchObject({ status: 'waiting', phase: '實作中', pendingCount: 1, error: null });
	expect(snapshot.errors).toEqual([]);
});

test('a report file with a cut-off line keeps its valid reports and flags only that controller', async () => {
	const luna = fixture.bound('alpha', 'luna');
	const nova = fixture.bound('beta', 'nova');
	fixture.report(luna.session_id, { tag: 'NO REPLY', summary: '第一筆', hcom_name: 'luna', workspace: luna.workspace });
	fixture.appendRaw(luna.session_id, '{"time": "2026-10-13T10:00:00Z", "session_id": "x", "hcom_na\n');
	fixture.report(luna.session_id, { tag: 'HELP', summary: '截斷之後的回報', hcom_name: 'luna', workspace: luna.workspace });
	fixture.appendRaw(luna.session_id, '{"tag": "DONE", "summary": "寫到一半');
	fixture.report(nova.session_id, { tag: 'DONE', summary: '交付', hcom_name: 'nova', workspace: nova.workspace });
	fixture.list([luna, nova]);

	const snapshot = await fixture.refresh(cookie);

	expect(named(snapshot, 'luna')).toMatchObject({ status: 'waiting', phase: '截斷之後的回報' });
	expect(named(snapshot, 'luna')!.error).toContain('2 行');
	expect(named(snapshot, 'nova')).toMatchObject({ status: 'delivered', phase: '交付', error: null });
});

test('a cut-off line does not hide an ended controller', async () => {
	const workspace = `${fixture.dir}/workspaces/gamma`;
	fixture.report('session-ended-damaged', { tag: 'DONE', summary: '交付後檔案受損', hcom_name: 'vega', workspace, final: true });
	fixture.appendRaw('session-ended-damaged', '{"time": "2026-10-1');
	fixture.list([]);

	const controller = named(await fixture.refresh(cookie), 'vega')!;

	expect(controller).toMatchObject({ status: 'ended', phase: '交付後檔案受損' });
	expect(controller.error).toContain('1 行');
});

test('when the helper fails, the last known controllers stay and every controller says its data is uncertain', async () => {
	const luna = fixture.bound('alpha', 'luna');
	fixture.report(luna.session_id, { tag: 'NO REPLY', summary: '實作中', hcom_name: 'luna', workspace: luna.workspace });
	fixture.report('session-ended-ok', { tag: 'DONE', summary: '已交付', hcom_name: 'orin', workspace: `${fixture.dir}/workspaces/gamma` });
	fixture.list([luna]);
	await fixture.refresh(cookie);

	fixture.setHelper({ output: { status: 'error', reason: 'invalid bindings file' }, exit: 1 });
	const failed = await fixture.refresh(cookie);

	expect(named(failed, 'luna')).toMatchObject({ status: 'working', phase: '實作中' });
	expect(named(failed, 'luna')!.error).toContain('invalid bindings file');
	// Whether an unbound controller has really ended cannot be told without the registry.
	expect(named(failed, 'orin')!.status).toBe('ended');
	expect(named(failed, 'orin')!.error).toContain('invalid bindings file');
	expect(failed.errors.join()).toContain('invalid bindings file');

	fixture.list([luna]);
	const recovered = await fixture.refresh(cookie);
	expect(named(recovered, 'luna')!.error).toBeNull();
	expect(named(recovered, 'orin')!.error).toBeNull();
	expect(recovered.errors).toEqual([]);
});

test('a helper that hangs is cut off and reported instead of blocking the board', async () => {
	fixture.setHelper({ output: { controllers: [] }, sleepMs: 10_000 });

	const started = Date.now();
	const snapshot = await fixture.refresh(cookie);

	expect(Date.now() - started).toBeLessThan(4_000);
	expect(snapshot.errors.join()).toContain('逾時');
});

test('helper output that is not JSON is reported as a source error', async () => {
	fixture.setHelper({ raw: 'Traceback (most recent call last):', exit: 1 });

	const snapshot = await fixture.refresh(cookie);

	expect(snapshot.errors).toHaveLength(1);
});

test('a report line that is valid JSON but lacks required fields is skipped like a cut-off line', async () => {
	const luna = fixture.bound('alpha', 'luna');
	fixture.report(luna.session_id, { tag: 'NO REPLY', summary: '完整的回報', hcom_name: 'luna', workspace: luna.workspace });
	// Each line is a complete report except for one required field.
	const complete = { time: new Date().toISOString(), session_id: luna.session_id, hcom_name: 'luna', client: 'claude', workspace: luna.workspace, round: 1, tag: 'DONE', summary: '缺欄位', message: '', final: false };
	const { session_id: _s, ...noSession } = complete;
	const { round: _r, ...noRound } = complete;
	const { final: _f, ...noFinal } = complete;
	for (const line of [noSession, noRound, noFinal, { ...complete, final: 'yes' }]) {
		fixture.appendRaw(luna.session_id, JSON.stringify(line) + '\n');
	}
	fixture.list([luna]);

	const controller = named(await fixture.refresh(cookie), 'luna')!;

	expect(controller).toMatchObject({ status: 'working', phase: '完整的回報' });
	expect(controller.error).toContain('4 行');
});

test('a watched directory that is deleted and created again is watched again', async () => {
	const luna = fixture.bound('alpha', 'luna');
	fixture.list([luna]);
	await fixture.refresh(cookie);
	const page = fixture.watch(cookie);
	await until(() => named(page.latest(), 'luna'), 5_000, 'the first snapshot');

	rmSync(fixture.reportsDir, { recursive: true });
	mkdirSync(fixture.reportsDir);
	// The board notices the new directory at its next re-read.
	await fixture.refresh(cookie);
	fixture.report(luna.session_id, { tag: 'NO REPLY', summary: '目錄重建後的回報', hcom_name: 'luna', workspace: luna.workspace });

	await until(() => named(page.latest(), 'luna')?.phase === '目錄重建後的回報', 5_000, 'the report written after the directory came back');
});

test('a helper that exits with a failure is not trusted even when it printed a controller list', async () => {
	fixture.setHelper({ output: { controllers: [] }, exit: 1 });

	const snapshot = await fixture.refresh(cookie);

	expect(snapshot.errors).toHaveLength(1);
});
