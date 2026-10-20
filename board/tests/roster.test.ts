import { afterAll, beforeAll, expect, test } from 'bun:test';
import { basename } from 'node:path';
import { DAY, named, question, startFixture, type Fixture } from './harness.ts';

let fixture: Fixture;
let cookie: string;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

beforeAll(async () => {
	fixture = await startFixture(0);
	cookie = await fixture.login();
});
afterAll(() => fixture.cleanup());

test('lists the active controllers of two projects with project, name, status and phase', async () => {
	const alpha = fixture.bound('alpha', 'luna', { client: 'claude' });
	const beta = fixture.bound('beta', 'nova', { client: 'codex', herdr_tab: 'tab-7' });
	fixture.report(alpha.session_id, { tag: 'NO REPLY', summary: '等 QA 回報', hcom_name: 'luna', workspace: alpha.workspace });
	fixture.report(beta.session_id, { tag: 'DONE', summary: '已交付第二版', hcom_name: 'nova', workspace: beta.workspace });
	fixture.list([alpha, beta]);

	const { controllers, errors } = await fixture.refresh(cookie);

	expect(errors).toEqual([]);
	expect(controllers.map(({ project, hcomName, status, phase, client }) => ({ project, hcomName, status, phase, client }))).toEqual([
		{ project: 'alpha', hcomName: 'luna', status: 'working', phase: '等 QA 回報', client: 'claude' },
		{ project: 'beta', hcomName: 'nova', status: 'delivered', phase: '已交付第二版', client: 'codex' }
	]);
	expect(controllers[1].workspace).toBe(beta.workspace);
	expect(controllers[1].herdr).toEqual({ workspace: 'ws-beta', tab: 'tab-7', pane: 'pane-1' });
});

// One test per row of the spec's status table, checked top to bottom.
test('status table: active with an unsent question is 等你, and the question is counted', async () => {
	const luna = fixture.bound('alpha', 'luna', {
		questions: [question({ id: 'Q-1' }), question({ id: 'Q-2' }), question({ id: 'Q-3', status: 'submitted' })]
	});
	fixture.report(luna.session_id, { tag: 'DONE', summary: '交付了', hcom_name: 'luna', workspace: luna.workspace });
	fixture.list([luna]);

	const controller = named(await fixture.refresh(cookie), 'luna')!;

	expect(controller.status).toBe('waiting');
	expect(controller.pendingCount).toBe(2);
});

test.each(['HELP', 'DECIDE'] as const)('status table: active with latest report %s and no unsent question is 進行中', async (tag) => {
	const luna = fixture.bound('alpha', 'luna', { questions: [question({ id: 'Q-1', status: 'submitted' }), question({ id: 'Q-2', status: 'recorded' })] });
	fixture.report(luna.session_id, { tag: 'DONE', summary: '先前交付', hcom_name: 'luna', workspace: luna.workspace });
	fixture.report(luna.session_id, { tag, summary: '需要你看一下', hcom_name: 'luna', workspace: luna.workspace });
	fixture.list([luna]);

	const controller = named(await fixture.refresh(cookie), 'luna')!;

	expect(controller.status).toBe('working');
	expect(controller.phase).toBe('需要你看一下');
	expect(controller.pendingCount).toBe(0);
});

test('a controller turns 進行中 once the last unsent question after its DECIDE is answered', async () => {
	const luna = fixture.bound('alpha', 'luna', { questions: [question({ id: 'Q-1' }), question({ id: 'Q-2', status: 'submitted' })] });
	fixture.report(luna.session_id, { tag: 'DECIDE', summary: '等你決定', hcom_name: 'luna', workspace: luna.workspace });
	fixture.list([luna]);
	expect(named(await fixture.refresh(cookie), 'luna')!.status).toBe('waiting');

	fixture.list([{ ...luna, questions: [question({ id: 'Q-1', status: 'recorded' }), question({ id: 'Q-2', status: 'submitted' })] }]);

	expect(named(await fixture.refresh(cookie), 'luna')).toMatchObject({ status: 'working', phase: '等你決定', pendingCount: 0 });
});

test('status table: active with latest report DONE is 已交付', async () => {
	const luna = fixture.bound('alpha', 'luna', { questions: [question({ status: 'recorded' })] });
	fixture.report(luna.session_id, { tag: 'HELP', summary: '卡住了', hcom_name: 'luna', workspace: luna.workspace });
	fixture.report(luna.session_id, { tag: 'DONE', summary: '全部完成', hcom_name: 'luna', workspace: luna.workspace });
	fixture.list([luna]);

	const controller = named(await fixture.refresh(cookie), 'luna')!;

	expect(controller.status).toBe('delivered');
	expect(controller.phase).toBe('全部完成');
});

test('status table: active with any other latest report is 進行中', async () => {
	const tagged = fixture.bound('alpha', 'luna', { questions: [question({ status: 'submitted' })] });
	const untagged = fixture.bound('alpha', 'miro');
	fixture.report(tagged.session_id, { tag: 'NO REPLY', summary: '實作中', hcom_name: 'luna', workspace: tagged.workspace });
	fixture.report(untagged.session_id, { tag: '', summary: '', message: '沒有標籤行的訊息', hcom_name: 'miro', workspace: untagged.workspace });
	fixture.list([tagged, untagged]);

	const snapshot = await fixture.refresh(cookie);

	expect(named(snapshot, 'luna')).toMatchObject({ status: 'working', phase: '實作中' });
	expect(named(snapshot, 'miro')).toMatchObject({ status: 'working', phase: '' });
});

test('status table: active without any report is 進行中 with no phase yet', async () => {
	fixture.list([fixture.bound('alpha', 'luna')]);

	const controller = named(await fixture.refresh(cookie), 'luna')!;

	expect(controller).toMatchObject({ status: 'working', phase: null, lastReportAt: null });
});

test('status table: an unbound controller with an unarchived report, gone from hcom\'s list, is 已關閉', async () => {
	const workspace = `${fixture.dir}/workspaces/gamma`;
	fixture.report('session-ended-done', { tag: 'DONE', summary: '交付完成', hcom_name: 'vega', workspace, final: true });
	fixture.list([]);

	const controller = named(await fixture.refresh(cookie), 'vega')!;

	expect(controller).toMatchObject({
		id: 'session-ended-done',
		status: 'closed',
		project: 'gamma',
		phase: '交付完成',
		herdr: null,
		pendingCount: 0
	});
});

test('已關閉 wins over 等你: an unbound controller whose last report is HELP or DECIDE is 已關閉', async () => {
	const workspace = `${fixture.dir}/workspaces/gamma`;
	fixture.report('session-ended-help', { tag: 'HELP', summary: '求助後被取消', hcom_name: 'orin', workspace, final: true });
	fixture.report('session-ended-decide', { tag: 'HELP', summary: '先求助', hcom_name: 'pavo', workspace });
	fixture.report('session-ended-decide', { tag: 'DECIDE', summary: '等你決定', hcom_name: 'pavo', workspace, final: true });
	fixture.list([]);

	const snapshot = await fixture.refresh(cookie);

	expect(named(snapshot, 'orin')).toMatchObject({ status: 'closed', pendingCount: 0 });
	expect(named(snapshot, 'pavo')).toMatchObject({ status: 'closed', phase: '等你決定', pendingCount: 0 });
});

test('an unbound controller leaves the roster once no report of it is left in the inbox', async () => {
	const workspace = `${fixture.dir}/workspaces/gamma`;
	fixture.report('session-old', { tag: 'DONE', summary: '八天前交付', hcom_name: 'oldie', workspace, time: ago(8 * DAY) });
	fixture.report('session-recent', { tag: 'DONE', summary: '六天前交付', hcom_name: 'recent', workspace, time: ago(6 * DAY) });
	fixture.report('session-quiet', { tag: 'NO REPLY', summary: '只有進度', hcom_name: 'quiet', workspace });
	fixture.list([]);

	const snapshot = await fixture.refresh(cookie);

	expect(named(snapshot, 'oldie')).toBeUndefined();
	expect(named(snapshot, 'quiet')).toBeUndefined();
	expect(named(snapshot, 'recent')).toMatchObject({ status: 'closed' });
});

test('a controller bound again after its final report keeps that report as its latest until a new one', async () => {
	const luna = fixture.bound('alpha', 'luna');
	fixture.report(luna.session_id, { tag: 'DONE', summary: '上一輪交付', hcom_name: 'luna', workspace: luna.workspace, final: true });
	fixture.list([luna]);

	expect(named(await fixture.refresh(cookie), 'luna')).toMatchObject({ status: 'delivered', phase: '上一輪交付' });

	fixture.report(luna.session_id, { tag: 'NO REPLY', summary: '第二輪開始', hcom_name: 'luna', workspace: luna.workspace, round: 2 });

	expect(named(await fixture.refresh(cookie), 'luna')).toMatchObject({ status: 'working', phase: '第二輪開始' });
});

test('the project name is the folder name of the workspace', async () => {
	const luna = fixture.bound('my-project', 'luna');
	fixture.list([luna]);

	const controller = named(await fixture.refresh(cookie), 'luna')!;

	expect(controller.project).toBe('my-project');
	expect(basename(controller.workspace)).toBe('my-project');
});
