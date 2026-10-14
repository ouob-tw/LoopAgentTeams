import { afterAll, beforeAll, expect, test } from 'bun:test';
import { groupByProject, sortByTime } from '../src/lib/board/inbox.ts';
import type { InboxQuestion, InboxReport } from '../src/lib/board/types.ts';
import { named, question, sleep, startFixture, titled, until, type Fixture } from './harness.ts';

let fixture: Fixture;
let cookie: string;
const at = (clock: string) => `2026-03-02T${clock}:00.000Z`;
const titles = (items: { title: string }[]) => items.map((item) => item.title);

beforeAll(async () => {
	fixture = await startFixture(7);
	cookie = await fixture.login();
});
afterAll(() => fixture.cleanup());

test('a single-choice question reaches the inbox within 5 seconds exactly as the question file has it', async () => {
	const luna = fixture.bound('alpha', 'luna');
	fixture.report(luna.session_id, { tag: 'DONE', summary: '先前的交付', hcom_name: 'luna', workspace: luna.workspace });
	fixture.list([luna]);
	await fixture.refresh(cookie);
	const page = fixture.watch(cookie);
	await until(() => named(page.latest(), 'luna'), 5_000, 'the first snapshot');

	const asked = question({
		id: 'BOARD-1',
		revision: 2,
		title: '回報要保留多久',
		kind: 'single',
		context: '信箱會越積越多。',
		options: [
			{ letter: 'A', label: '7 天（建議）', impact: '舊回報自動移到已封存', recommended: true },
			{ letter: 'B', label: '永久保留', impact: '信箱不會清空', recommended: false }
		],
		recommendation: '建議選 A，因為封存後仍可查看。',
		asked_at: new Date().toISOString()
	});
	fixture.list([{ ...luna, questions: [asked] }]);
	await Bun.write(luna.questions_path, '## BOARD-1\n');

	const item = (await until(() => titled(page.latest(), '回報要保留多久'), 5_000, 'the question in the inbox')) as InboxQuestion;

	expect(item).toMatchObject({ kind: 'question', unsent: true, project: 'alpha', hcomName: 'luna', controllerId: luna.session_id });
	expect(item.question.options).toEqual(asked.options);
	expect(item.question.recommendation).toBe('建議選 A，因為封存後仍可查看。');
	expect(item.question.context).toBe('信箱會越積越多。');
	expect(item.question.kind).toBe('single');
	// Sorted by time, an unsent question is above everything else, however new.
	expect(sortByTime(page.latest()!.inbox)[0].title).toBe('回報要保留多久');
});

test('a HELP turn end puts a help item in the inbox and the controller is 等你', async () => {
	const luna = fixture.bound('alpha', 'luna');
	fixture.list([luna]);
	fixture.report(luna.session_id, {
		tag: 'HELP',
		summary: '測試環境連不上',
		message: '我試了三次。\n\nHELP: 測試環境連不上',
		hcom_name: 'luna',
		workspace: luna.workspace
	});

	const snapshot = await fixture.refresh(cookie);

	expect(named(snapshot, 'luna')!.status).toBe('waiting');
	expect(titled(snapshot, '測試環境連不上')).toMatchObject({
		kind: 'report',
		tag: 'HELP',
		message: '我試了三次。\n\nHELP: 測試環境連不上',
		readAt: null
	});
});

test('only DONE and HELP reports become inbox items', async () => {
	const luna = fixture.bound('alpha', 'luna');
	fixture.list([luna]);
	for (const tag of ['DECIDE', 'NO REPLY', ''] as const) {
		fixture.report(luna.session_id, { tag, summary: `標籤 ${tag || '無'}`, hcom_name: 'luna', workspace: luna.workspace });
	}
	fixture.report(luna.session_id, { tag: 'DONE', summary: '這筆才進信箱', hcom_name: 'luna', workspace: luna.workspace });

	const snapshot = await fixture.refresh(cookie);

	expect(titles(snapshot.inbox.filter((item) => item.controllerId === luna.session_id))).toEqual(['這筆才進信箱']);
});

test('the DONE message of a controller deactivated as completed is in the inbox in full, and it is 已結束', async () => {
	const luna = fixture.bound('alpha', 'luna');
	fixture.list([luna]);
	expect(named(await fixture.refresh(cookie), 'luna')!.status).toBe('working');

	// Deactivated first, then the last turn ends.
	fixture.list([]);
	fixture.report(luna.session_id, {
		tag: 'DONE',
		summary: '第一版已交付',
		message: '改了三個檔案。\n測試全數通過。\n\nDONE: 第一版已交付',
		hcom_name: 'luna',
		workspace: luna.workspace,
		final: true
	});
	const snapshot = await fixture.refresh(cookie);

	expect(named(snapshot, 'luna')).toMatchObject({ status: 'ended', herdr: null });
	expect(titled(snapshot, '第一版已交付')).toMatchObject({
		tag: 'DONE',
		message: '改了三個檔案。\n測試全數通過。\n\nDONE: 第一版已交付',
		project: 'alpha',
		hcomName: 'luna'
	});
});

test('a controller that started, delivered and ended while the board was stopped shows up after a restart', async () => {
	await fixture.stop();
	const workspace = `${fixture.dir}/workspaces/while-stopped`;
	fixture.report('session-never-seen', { tag: 'DONE', summary: '看板沒開時交付', hcom_name: 'ghost', workspace, final: true });
	fixture.list([]);
	await fixture.start();

	const snapshot = await fixture.board(cookie);

	expect(named(snapshot, 'ghost')).toMatchObject({ status: 'ended', project: 'while-stopped' });
	expect(titled(snapshot, '看板沒開時交付')).toMatchObject({ kind: 'report', tag: 'DONE', project: 'while-stopped', hcomName: 'ghost' });
});

test('a cancelled controller with an unsent question and a last HELP is 已結束; only its report stays in the inbox', async () => {
	const orin = fixture.bound('alpha', 'orin', { questions: [question({ id: 'Q-9', title: '沒人回答的題' })] });
	fixture.report(orin.session_id, { tag: 'HELP', summary: '取消前的求助', message: '全文\n\nHELP: 取消前的求助', hcom_name: 'orin', workspace: orin.workspace, final: true });
	fixture.list([orin]);
	const before = await fixture.refresh(cookie);
	expect(named(before, 'orin')!.status).toBe('waiting');
	expect(titled(before, '沒人回答的題')).toBeDefined();

	// Cancelled: it leaves the binding registry; the question file still holds the unsent question.
	fixture.list([]);
	const after = await fixture.refresh(cookie);

	expect(named(after, 'orin')).toMatchObject({ status: 'ended', pendingCount: 0 });
	expect(titled(after, '沒人回答的題')).toBeUndefined();
	expect(titled(after, '取消前的求助')).toMatchObject({ tag: 'HELP', message: '全文\n\nHELP: 取消前的求助' });
});

test('a sent question stays in the inbox unpinned; a recorded one leaves it', async () => {
	const luna = fixture.bound('alpha', 'luna', {
		questions: [
			question({ id: 'Q-1', title: '還沒答', asked_at: at('09:00') }),
			question({ id: 'Q-2', title: '已送出', status: 'submitted', answer: 'A', asked_at: at('11:00') }),
			question({ id: 'Q-3', title: '已記錄', status: 'recorded', answer: 'B', asked_at: at('12:00') })
		]
	});
	fixture.list([luna]);

	const mine = (await fixture.refresh(cookie)).inbox.filter((item) => item.controllerId === luna.session_id);

	// The unsent one is on top although the sent one is newer.
	expect(titles(sortByTime(mine))).toEqual(['還沒答', '已送出']);
	expect(mine.find((item) => item.title === '已送出')).toMatchObject({ kind: 'question', unsent: false });
	expect(named(await fixture.board(cookie), 'luna')!.pendingCount).toBe(1);
});

test('a report marked read on one device is read on another paired device within 5 seconds', async () => {
	const luna = fixture.bound('alpha', 'luna');
	fixture.report(luna.session_id, { tag: 'DONE', summary: '兩台裝置都會看到', hcom_name: 'luna', workspace: luna.workspace });
	fixture.list([luna]);
	const { key } = titled(await fixture.refresh(cookie), '兩台裝置都會看到')!;
	const other = fixture.watch(await fixture.login('second-device'));
	await until(() => titled(other.latest(), '兩台裝置都會看到'), 5_000, 'the report on the second device');
	// Let the re-read that the new report file triggered finish before counting helper runs.
	await sleep(500);
	const calls = fixture.helperCalls();

	const response = await fixture.markRead(cookie, key);

	expect(response.status).toBe(200);
	const seen = (await until(
		() => (titled(other.latest(), '兩台裝置都會看到') as InboxReport).readAt,
		5_000,
		'the read mark on the second device'
	)) as string;
	// Read state is the board's own; it does not take a helper run to publish it.
	expect(fixture.helperCalls()).toBe(calls);

	// Marking again keeps the first time, so the 3 days are not restarted.
	expect(await (await fixture.markRead(cookie, key)).json()).toEqual({ result: 'already-read' });
	expect((titled(await fixture.board(cookie), '兩台裝置都會看到') as InboxReport).readAt).toBe(seen);
});

test('read state survives a restart of the board', async () => {
	const luna = fixture.bound('alpha', 'luna');
	fixture.report(luna.session_id, { tag: 'DONE', summary: '重啟後仍是已讀', hcom_name: 'luna', workspace: luna.workspace });
	fixture.list([luna]);
	await fixture.markRead(cookie, titled(await fixture.refresh(cookie), '重啟後仍是已讀')!.key);

	await fixture.stop();
	await fixture.start();

	expect((titled(await fixture.board(cookie), '重啟後仍是已讀') as InboxReport).readAt).not.toBeNull();
});

test('marking read is refused for an unknown report, a report that is not an inbox item, and an unpaired device', async () => {
	const luna = fixture.bound('alpha', 'luna');
	fixture.report(luna.session_id, { tag: 'NO REPLY', summary: '只是進度', hcom_name: 'luna', workspace: luna.workspace });
	fixture.list([luna]);
	await fixture.refresh(cookie);

	expect((await fixture.markRead(cookie, 'no-such-session#0')).status).toBe(404);
	expect((await fixture.markRead(cookie, `${luna.session_id}#0`)).status).toBe(404);
	expect((await fixture.fetch('/api/inbox/read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', cookie })).status).toBe(400);
	expect((await fixture.markRead('', `${luna.session_id}#0`)).status).toBe(401);
	expect((await fixture.fetch('/api/archive')).status).toBe(401);
});

// The spec's two sorting examples, with the times they give.
test('example 1: two projects, both orders', async () => {
	const jia = fixture.bound('jia', 'ctl-jia', { questions: [question({ id: 'Q1', title: 'Q1', asked_at: at('10:00') })] });
	const yi = fixture.bound('yi', 'ctl-yi', { questions: [question({ id: 'Q2', title: 'Q2', asked_at: at('11:00') })] });
	fixture.report(jia.session_id, { tag: 'DONE', summary: 'R1', time: at('09:00'), hcom_name: 'ctl-jia', workspace: jia.workspace });
	fixture.report(yi.session_id, { tag: 'DONE', summary: 'R2', time: at('08:00'), hcom_name: 'ctl-yi', workspace: yi.workspace });
	fixture.list([jia, yi]);
	fixture.setClock(Date.parse(at('13:00')));

	const mine = (await fixture.refresh(cookie)).inbox.filter((item) => ['jia', 'yi'].includes(item.project));

	expect(titles(sortByTime(mine))).toEqual(['Q2', 'Q1', 'R1', 'R2']);
	expect(groupByProject(mine).map((group) => [group.project, group.controllers.map((c) => [c.hcomName, titles(c.items)])])).toEqual([
		['yi', [['ctl-yi', ['Q2', 'R2']]]],
		['jia', [['ctl-jia', ['Q1', 'R1']]]]
	]);
});

test('example 2: two controllers of one project, both orders', async () => {
	const a = fixture.bound('bing', 'ctl-a', { questions: [question({ id: 'QA', title: 'QA', asked_at: at('10:00') })] });
	const b = fixture.bound('bing', 'ctl-b', { questions: [question({ id: 'QB', title: 'QB', asked_at: at('11:00') })] });
	fixture.report(a.session_id, { tag: 'HELP', summary: 'RA', time: at('12:00'), hcom_name: 'ctl-a', workspace: a.workspace });
	fixture.report(b.session_id, { tag: 'DONE', summary: 'RB', time: at('09:00'), hcom_name: 'ctl-b', workspace: b.workspace });
	fixture.list([a, b]);
	fixture.setClock(Date.parse(at('13:00')));

	const mine = (await fixture.refresh(cookie)).inbox.filter((item) => item.project === 'bing');

	expect(titles(sortByTime(mine))).toEqual(['QB', 'QA', 'RA', 'RB']);
	const groups = groupByProject(mine);
	expect(groups).toHaveLength(1);
	// QB comes after RA: a controller's unsent question never leaves its own group.
	expect(groups[0].controllers.map((c) => [c.hcomName, titles(c.items)])).toEqual([
		['ctl-a', ['QA', 'RA']],
		['ctl-b', ['QB', 'RB']]
	]);
});

test('by project: groups with an unsent question come before newer groups without one', async () => {
	const quiet = fixture.bound('p-quiet', 'c-quiet');
	const asking = fixture.bound('p-asking', 'c-asking', { questions: [question({ id: 'Q', title: '舊的待答題', asked_at: at('07:00') })] });
	const sent = fixture.bound('p-asking', 'c-sent', { questions: [question({ id: 'S', title: '已送出的題', status: 'submitted', asked_at: at('12:30') })] });
	fixture.report(quiet.session_id, { tag: 'DONE', summary: '最新的回報', time: at('12:00'), hcom_name: 'c-quiet', workspace: quiet.workspace });
	fixture.report(asking.session_id, { tag: 'DONE', summary: '舊的回報', time: at('06:00'), hcom_name: 'c-asking', workspace: asking.workspace });
	fixture.list([quiet, asking, sent]);
	fixture.setClock(Date.parse(at('13:00')));

	const mine = (await fixture.refresh(cookie)).inbox.filter((item) => item.project.startsWith('p-'));

	expect(groupByProject(mine).map((group) => [group.project, group.controllers.map((c) => [c.hcomName, titles(c.items)])])).toEqual([
		// c-sent has the newest item, but a sent question does not count as waiting.
		['p-asking', [['c-asking', ['舊的待答題', '舊的回報']], ['c-sent', ['已送出的題']]]],
		['p-quiet', [['c-quiet', ['最新的回報']]]]
	]);
});

test('questions without an asked time sort after the dated ones, in file order', async () => {
	const first = fixture.bound('undated', 'c-first', {
		questions: [
			question({ id: 'N1', title: '沒有時間一', asked_at: null }),
			question({ id: 'D1', title: '有時間（舊）', asked_at: at('08:00') }),
			question({ id: 'N2', title: '沒有時間二', asked_at: null })
		]
	});
	const second = fixture.bound('undated', 'c-second', {
		questions: [question({ id: 'N3', title: '沒有時間三', asked_at: null }), question({ id: 'D2', title: '有時間（新）', asked_at: at('09:00') })]
	});
	fixture.report(first.session_id, { tag: 'DONE', summary: '一筆回報', time: at('10:00'), hcom_name: 'c-first', workspace: first.workspace });
	fixture.list([first, second]);
	fixture.setClock(Date.parse(at('13:00')));

	const mine = (await fixture.refresh(cookie)).inbox.filter((item) => item.project === 'undated');

	expect(titles(sortByTime(mine))).toEqual(['有時間（新）', '有時間（舊）', '沒有時間一', '沒有時間二', '沒有時間三', '一筆回報']);
	expect(groupByProject(mine)[0].controllers.map((c) => [c.hcomName, titles(c.items)])).toEqual([
		// c-first's newest item is the 10:00 report; c-second's is the 09:00 question.
		['c-first', ['有時間（舊）', '沒有時間一', '沒有時間二', '一筆回報']],
		['c-second', ['有時間（新）', '沒有時間三']]
	]);
});

test('two projects whose folders share a name are separate groups', async () => {
	const one = fixture.bound('same-name', 'c-one');
	const two = { ...fixture.bound('elsewhere/same-name', 'c-two') };
	fixture.report(one.session_id, { tag: 'DONE', summary: '甲地的回報', time: at('10:00'), hcom_name: 'c-one', workspace: one.workspace });
	fixture.report(two.session_id, { tag: 'DONE', summary: '乙地的回報', time: at('11:00'), hcom_name: 'c-two', workspace: two.workspace });
	fixture.list([one, two]);
	fixture.setClock(Date.parse(at('13:00')));

	const mine = (await fixture.refresh(cookie)).inbox.filter((item) => item.project === 'same-name');

	expect(groupByProject(mine).map((group) => [group.project, group.workspace, titles(group.controllers[0].items)])).toEqual([
		['same-name', two.workspace, ['乙地的回報']],
		['same-name', one.workspace, ['甲地的回報']]
	]);
});
