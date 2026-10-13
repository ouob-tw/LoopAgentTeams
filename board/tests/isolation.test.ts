import { afterAll, beforeAll, expect, test } from 'bun:test';
import { named, question, startFixture, type Fixture } from './harness.ts';

let fixture: Fixture;
let cookie: string;

beforeAll(async () => {
	fixture = await startFixture(4, { env: { LAT_BOARD_HELPER_TIMEOUT_SECONDS: '1' } });
	cookie = await fixture.pair();
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

test('when the helper fails, the last known controllers stay, marked, and ended controllers are unaffected', async () => {
	const luna = fixture.bound('alpha', 'luna');
	fixture.report(luna.session_id, { tag: 'NO REPLY', summary: '實作中', hcom_name: 'luna', workspace: luna.workspace });
	fixture.report('session-ended-ok', { tag: 'DONE', summary: '已交付', hcom_name: 'orin', workspace: `${fixture.dir}/workspaces/gamma` });
	fixture.list([luna]);
	await fixture.refresh(cookie);

	fixture.setHelper({ output: { status: 'error', reason: 'invalid bindings file' }, exit: 1 });
	const failed = await fixture.refresh(cookie);

	expect(named(failed, 'luna')).toMatchObject({ status: 'working', phase: '實作中' });
	expect(named(failed, 'luna')!.error).toContain('invalid bindings file');
	expect(named(failed, 'orin')).toMatchObject({ status: 'ended', error: null });
	expect(failed.errors.join()).toContain('invalid bindings file');

	fixture.list([luna]);
	const recovered = await fixture.refresh(cookie);
	expect(named(recovered, 'luna')!.error).toBeNull();
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
