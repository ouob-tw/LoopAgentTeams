import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AnswerRequest, AnswerResponse, NotifyResponse, SentAnswer, SentEntry } from '../src/lib/board/answers.ts';
import type { HelperController, HelperQuestion, InboxQuestion } from '../src/lib/board/types.ts';
import { named, question, sleep, startFixture, titled, until, type Fixture } from './harness.ts';

let fixture: Fixture;
let cookie: string;

beforeAll(async () => {
	fixture = await startFixture(11);
	cookie = await fixture.pair();
});
afterAll(() => fixture.cleanup());
beforeEach(() => rmSync(join(fixture.dir, 'helper-calls.jsonl'), { force: true }));

const OPTIONS = [
	{ letter: 'A', label: '維持現狀', impact: '不必改動', recommended: true },
	{ letter: 'B', label: '全部重寫', impact: '要多花一週', recommended: false },
	{ letter: 'C', label: '只改一半', impact: '', recommended: false }
];
const single = (overrides: Partial<HelperQuestion> = {}) =>
	question({ id: 'S-1', title: '單選題', kind: 'single', options: OPTIONS, ...overrides });
const multi = (overrides: Partial<HelperQuestion> = {}) =>
	question({ id: 'M-1', title: '複選題', kind: 'multi', options: OPTIONS, ...overrides });
const text = (overrides: Partial<HelperQuestion> = {}) => question({ id: 'T-1', title: '文字題', kind: 'text', ...overrides });

type Answer = Partial<Pick<AnswerRequest, 'select' | 'text' | 'note'>>;

/** Answer a question as the page would: with the version and hash it was shown with. */
async function answer(controller: HelperController, shown: HelperQuestion, given: Answer, as = cookie) {
	const body: AnswerRequest = {
		controllerId: controller.session_id,
		questionId: shown.id,
		revision: shown.revision,
		sectionSha256: shown.section_sha256,
		select: [],
		text: '',
		note: '',
		...given
	};
	return post<AnswerResponse>('/api/answers', body, as);
}

async function post<T>(path: string, body: unknown, as = cookie): Promise<{ status: number; body: T }> {
	const response = await fixture.fetch(path, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
		cookie: as
	});
	return { status: response.status, body: await response.json() };
}

const notify = (controller: HelperController, as = cookie) =>
	post<NotifyResponse>('/api/answers/notify', { controllerId: controller.session_id }, as);

async function sentAnswers(controllerId: string, as = cookie): Promise<SentAnswer[]> {
	const response = await fixture.fetch(`/api/messages?controller=${encodeURIComponent(controllerId)}`, { cookie: as });
	const entries: SentEntry[] = (await response.json()).entries;
	return entries.filter((entry) => entry.kind === 'answer');
}

/** The question as the helper lists it now: what the answer command wrote, or left alone. */
const listedQuestion = (controller: HelperController, id: string) =>
	fixture
		.listed()
		.find((candidate) => candidate.session_id === controller.session_id)!
		.questions.find((candidate) => candidate.id === id)!;

/** The controller marks questions recorded, the way `question record` does. */
function record(...ids: string[]): void {
	const controllers = fixture.listed();
	for (const controller of controllers) {
		for (const item of controller.questions) {
			if (ids.includes(item.id)) Object.assign(item, { status: 'recorded', recorded_at: '2026-03-02T10:00:00.000Z' });
		}
	}
	fixture.list(controllers);
}

test('single choice, multiple choice, free text and 其他 are each written by the helper, shown as sent, then as recorded', async () => {
	const questions = [single(), multi(), text(), single({ id: 'S-2', title: '單選題選其他' })];
	const luna = fixture.bound('alpha', 'luna', { questions });
	fixture.list([luna]);
	await fixture.refresh(cookie);

	const results = [
		await answer(luna, questions[0], { select: [2], note: '先這樣\n之後再看' }),
		await answer(luna, questions[1], { select: [3, 1], text: '另外加測試' }),
		await answer(luna, questions[2], { text: '第一行\n第二行' }),
		await answer(luna, questions[3], { text: '都不要' })
	];

	for (const result of results) {
		expect(result).toMatchObject({ status: 200, body: { status: 'submitted', notified: true, logError: null } });
	}
	// One helper call per answer: positions in the order chosen, text and note each one argument.
	const path = `--questions=${luna.questions_path}`;
	const sha = `--expected-section-sha256=${'a'.repeat(64)}`;
	expect(fixture.helperArgs('answer')).toEqual([
		['board', 'answer', path, '--id=S-1', '--revision=1', sha, '--select=2', '--note=先這樣\n之後再看'],
		['board', 'answer', path, '--id=M-1', '--revision=1', sha, '--select=3', '--select=1', '--text=另外加測試'],
		['board', 'answer', path, '--id=T-1', '--revision=1', sha, '--text=第一行\n第二行'],
		['board', 'answer', path, '--id=S-2', '--revision=1', sha, '--text=都不要']
	]);
	expect(listedQuestion(luna, 'S-1')).toMatchObject({ status: 'submitted', answer: 'B. 全部重寫', note: '先這樣\n之後再看' });
	expect(listedQuestion(luna, 'M-1')).toMatchObject({ status: 'submitted', answer: '只改一半；維持現狀；其他：另外加測試' });
	expect(listedQuestion(luna, 'T-1')).toMatchObject({ status: 'submitted', answer: '第一行\n第二行' });
	expect(listedQuestion(luna, 'S-2')).toMatchObject({ status: 'submitted', answer: '其他：都不要' });

	// The answering request itself re-read the sources: no refresh is needed to see the result.
	const sent = await fixture.board(cookie);
	for (const title of ['單選題', '複選題', '文字題', '單選題選其他']) {
		expect(titled(sent, title)).toMatchObject({ kind: 'question', unsent: false, notifyFailed: false });
	}
	expect(named(sent, 'luna')).toMatchObject({ pendingCount: 0 });
	expect(sent.recordedKeys).toEqual([]);
	const waiting = await sentAnswers(luna.session_id);
	expect(waiting.map((entry) => [entry.questionId, entry.title, entry.answer, entry.note, entry.state])).toEqual([
		['S-2', '單選題選其他', '其他：都不要', '', 'waiting'],
		['T-1', '文字題', '第一行\n第二行', '', 'waiting'],
		['M-1', '複選題', '只改一半；維持現狀；其他：另外加測試', '', 'waiting'],
		['S-1', '單選題', 'B. 全部重寫', '先這樣\n之後再看', 'waiting']
	]);
	expect(results[0].body.entry).toEqual(waiting[3]);

	record('S-1', 'M-1', 'T-1', 'S-2');
	const recorded = await fixture.refresh(cookie);

	expect(recorded.inbox).toEqual([]);
	expect(recorded.recordedKeys.sort()).toEqual(['M-1', 'S-1', 'S-2', 'T-1'].map((id) => `q:${luna.session_id}:${id}`));
	const settled = await sentAnswers(luna.session_id);
	expect(settled.map((entry) => entry.state)).toEqual(['recorded', 'recorded', 'recorded', 'recorded']);
	expect(settled[0].settledAt).toBe('2026-03-02T10:00:00.000Z');
});

test('an answer the controller records before the board reads anything again is still logged as recorded', async () => {
	const asked = single({ title: '很快被記錄的題' });
	const luna = fixture.bound('alpha', 'luna', { questions: [asked] });
	fixture.setHelper({ output: { controllers: [luna] }, recordOnAnswer: true });
	const first = await fixture.refresh(cookie);
	const key = titled(first, '很快被記錄的題')!.key;

	const { status, body } = await answer(luna, asked, { select: [1] });

	expect(status).toBe(200);
	expect(body.status).toBe('submitted');
	// The board never saw it as "sent, waiting": it went from unanswered straight to recorded.
	const after = await fixture.board(cookie);
	expect(titled(after, '很快被記錄的題')).toBeUndefined();
	expect(after.recordedKeys).toContain(key);
	expect(await sentAnswers(luna.session_id)).toMatchObject([{ questionId: 'S-1', answer: 'A. 維持現狀', state: 'recorded' }]);
});

test('a page that is open gets the sent state, and then the recorded state, through its live connection', async () => {
	const asked = text({ title: '開著的題' });
	const luna = fixture.bound('alpha', 'luna', { questions: [asked] });
	fixture.list([luna]);
	await fixture.refresh(cookie);
	const page = fixture.watch(await fixture.pair('second-device'));
	const key = ((await until(() => titled(page.latest(), '開著的題'), 5_000, 'the open question')) as InboxQuestion).key;

	await answer(luna, asked, { text: '好' });
	await until(() => titled(page.latest(), '開著的題')?.kind === 'question' && !(titled(page.latest(), '開著的題') as InboxQuestion).unsent, 5_000, 'the sent state');

	record('T-1');
	await Bun.write(luna.questions_path, 'recorded\n');
	// Gone from the inbox but named as recorded, so the page can keep the content up with a notice.
	await until(() => page.latest()!.recordedKeys.includes(key) && !titled(page.latest(), '開著的題'), 5_000, 'the recorded state');
});

test('an answer to an older version is refused, nothing is written and the new version is what the board shows', async () => {
	const shown = single({ title: '第一版', revision: 1 });
	const luna = fixture.bound('alpha', 'luna', { questions: [shown] });
	fixture.list([luna]);
	await fixture.refresh(cookie);
	// The controller revises the question; this page has not heard of it.
	const revised = single({ title: '第二版', revision: 2, section_sha256: 'b'.repeat(64) });
	fixture.list([{ ...luna, questions: [revised] }]);

	const { status, body } = await answer(luna, shown, { select: [1] });

	expect(status).toBe(409);
	expect(body).toMatchObject({ status: 'question_changed', notified: null, entry: null });
	expect(body.reason).toContain('revision 2');
	expect(listedQuestion(luna, 'S-1')).toEqual(revised);
	expect(await sentAnswers(luna.session_id)).toEqual([]);
	const fresh = await fixture.board(cookie);
	expect(titled(fresh, '第二版')).toMatchObject({ unsent: true, question: { revision: 2, section_sha256: 'b'.repeat(64) } });
	expect(titled(fresh, '第一版')).toBeUndefined();
});

test('an answer to a question whose content changed without a new version is refused the same way', async () => {
	const shown = text({ title: '內容改過的題' });
	const luna = fixture.bound('alpha', 'luna', { questions: [shown] });
	const edited = { ...shown, context: '補了一段背景', section_sha256: 'c'.repeat(64) };
	fixture.list([{ ...luna, questions: [edited] }]);

	const { status, body } = await answer(luna, shown, { text: '好' });

	expect(status).toBe(409);
	expect(body.status).toBe('question_changed');
	expect(listedQuestion(luna, 'T-1')).toEqual(edited);
	expect(await sentAnswers(luna.session_id)).toEqual([]);
});

test('a question already answered in the Herdr panel shows as sent and cannot be answered again', async () => {
	const fromPanel = single({ title: '面板答過的題', status: 'submitted', answer: 'A. 維持現狀', section_sha256: 'd'.repeat(64) });
	const luna = fixture.bound('alpha', 'luna', { questions: [fromPanel] });
	fixture.list([luna]);

	const snapshot = await fixture.refresh(cookie);
	expect(titled(snapshot, '面板答過的題')).toMatchObject({ unsent: false, question: { answer: 'A. 維持現狀' } });

	const { status, body } = await answer(luna, fromPanel, { select: [2] });

	expect(status).toBe(409);
	expect(body).toMatchObject({ status: 'not_pending', entry: null });
	expect(listedQuestion(luna, 'S-1')).toEqual(fromPanel);
	// Answers given in the panel are not in the board's sent log.
	expect(await sentAnswers(luna.session_id)).toEqual([]);
});

test('of two answers to one question the first stands: a second device with the old page is refused', async () => {
	const asked = single({ title: '兩邊同時答的題' });
	const luna = fixture.bound('alpha', 'luna', { questions: [asked] });
	fixture.list([luna]);
	const phone = await fixture.pair('phone');

	const first = await answer(luna, asked, { select: [1] });
	const second = await answer(luna, asked, { select: [2] }, phone);

	expect(first.body.status).toBe('submitted');
	expect(second).toMatchObject({ status: 409, body: { status: 'not_pending' } });
	expect(listedQuestion(luna, 'S-1').answer).toBe('A. 維持現狀');
	expect((await sentAnswers(luna.session_id, phone)).map((entry) => entry.answer)).toEqual(['A. 維持現狀']);
});

test('a written answer whose notification failed says so on every device, is never resent by itself, and is resent once on request', async () => {
	const asked = single({ title: '通知失敗的題' });
	const luna = fixture.bound('alpha', 'luna', { questions: [asked] });
	fixture.setHelper({ output: { controllers: [luna] }, notifyFails: 'controller pane is gone' });
	await fixture.refresh(cookie);
	const phone = await fixture.pair('phone');

	const { status, body } = await answer(luna, asked, { select: [1], note: '備註' });

	expect(status).toBe(200);
	expect(body).toMatchObject({ status: 'submitted', notified: false, reason: 'controller pane is gone' });
	const written = listedQuestion(luna, 'S-1');
	expect(written).toMatchObject({ status: 'submitted', answer: 'A. 維持現狀', note: '備註' });
	// Another device, and this one after a reload, get the same state from the list data.
	expect(titled(await fixture.board(phone), '通知失敗的題')).toMatchObject({ unsent: false, notifyFailed: true });
	expect(await sentAnswers(luna.session_id)).toMatchObject([{ state: 'waiting' }]);

	// Reads go on; none of them resends.
	await fixture.refresh(cookie);
	await Bun.write(luna.questions_path, 'touched\n');
	await sleep(1_000);
	expect(fixture.helperArgs('notify')).toEqual([]);

	// Still failing: the reason is shown and the notification stays pending.
	const failed = await notify(luna);
	expect(failed).toEqual({ status: 502, body: { status: 'failed', reason: 'controller pane is gone' } });
	expect(titled(await fixture.board(cookie), '通知失敗的題')).toMatchObject({ notifyFailed: true });

	// The controller is reachable again.
	fixture.list(fixture.listed());
	const delivered = await notify(luna, phone);

	expect(delivered).toEqual({ status: 200, body: { status: 'delivered', reason: null } });
	expect(fixture.helperArgs('notify')).toEqual([
		['board', 'notify', `--questions=${luna.questions_path}`],
		['board', 'notify', `--questions=${luna.questions_path}`]
	]);
	expect(listedQuestion(luna, 'S-1')).toEqual(written);
	expect(fixture.helperArgs('answer')).toHaveLength(1);
	expect(titled(await fixture.board(cookie), '通知失敗的題')).toMatchObject({ unsent: false, notifyFailed: false });

	const again = await notify(luna);
	expect(again).toEqual({ status: 200, body: { status: 'no_pending', reason: null } });
	expect(listedQuestion(luna, 'S-1')).toEqual(written);
});

test('a pending notification left by the Herdr panel shows as a failed notification too, only on sent questions', async () => {
	const luna = fixture.bound('alpha', 'luna', {
		notification_pending: true,
		questions: [text({ id: 'T-1', title: '面板送出的', status: 'submitted', answer: '好' }), text({ id: 'T-2', title: '還沒答的' })]
	});
	fixture.list([luna]);

	const snapshot = await fixture.refresh(cookie);

	expect(titled(snapshot, '面板送出的')).toMatchObject({ notifyFailed: true });
	expect(titled(snapshot, '還沒答的')).toMatchObject({ unsent: true, notifyFailed: false });
});

test('an answer that does not fit the question is refused with the reason and nothing is written', async () => {
	const questions = [single(), text()];
	const luna = fixture.bound('alpha', 'luna', { questions });
	fixture.list([luna]);

	const outOfRange = await answer(luna, questions[0], { select: [9] });
	const twoForSingle = await answer(luna, questions[0], { select: [1, 2] });
	const structure = await answer(luna, questions[1], { text: '好\n## 假的題目' });
	const empty = await answer(luna, questions[1], { text: '  ', note: '只有備註' });

	for (const result of [outOfRange, twoForSingle, structure, empty]) {
		expect(result).toMatchObject({ status: 422, body: { status: 'invalid_answer', entry: null } });
		expect(result.body.reason).toBeTruthy();
	}
	expect(fixture.listed()[0].questions).toEqual(questions);
	expect(await sentAnswers(luna.session_id)).toEqual([]);
});

test('text that starts with dashes or holds new lines reaches the helper as the value it is', async () => {
	const asked = text();
	const luna = fixture.bound('alpha', 'luna', { questions: [asked] });
	fixture.list([luna]);

	const { body } = await answer(luna, asked, { text: '--select=1 才對', note: '--note' });

	expect(body.status).toBe('submitted');
	expect(listedQuestion(luna, 'T-1')).toMatchObject({ answer: '--select=1 才對', note: '--note' });
});

test('a helper failure is shown with its reason, and one that printed nothing usable is a failure too', async () => {
	const asked = text({ title: '寫不進去的題' });
	const luna = fixture.bound('alpha', 'luna', { questions: [asked] });
	fixture.setHelper({ output: { controllers: [luna] }, answer: { output: { status: 'error', reason: 'question has no writable answer area: T-1' }, exit: 1 } });

	const failed = await answer(luna, asked, { text: '好' });

	expect(failed).toMatchObject({ status: 502, body: { status: 'error', reason: 'question has no writable answer area: T-1', entry: null } });

	// A usage error: nothing on standard output, exit code 2.
	fixture.setHelper({ output: { controllers: [luna] }, answer: { raw: '', exit: 2 }, notify: { raw: 'not json', exit: 1 } });
	const usage = await answer(luna, asked, { text: '好' });
	const brokenNotify = await notify(luna);

	expect(usage).toMatchObject({ status: 502, body: { status: 'error' } });
	expect(usage.body.reason).toBeTruthy();
	expect(brokenNotify.status).toBe(502);
	expect(brokenNotify.body.status).toBe('error');
	expect(await sentAnswers(luna.session_id)).toEqual([]);
	// The question is still there to be answered.
	expect(titled(await fixture.board(cookie), '寫不進去的題')).toMatchObject({ unsent: true });
});

test('a text the helper cannot be given at all is a failure, not a server error', async () => {
	const asked = text();
	const luna = fixture.bound('alpha', 'luna', { questions: [asked] });
	fixture.list([luna]);

	const { status, body } = await answer(luna, asked, { text: 'a\u0000b' });

	expect(status).toBe(502);
	expect(body.status).toBe('error');
	expect(listedQuestion(luna, 'T-1')).toEqual(asked);
});

test('a question of an ended controller cannot be answered, and its notification cannot be resent', async () => {
	const asked = text({ title: '已結束主控的題' });
	const luna = fixture.bound('alpha', 'luna', { questions: [asked] });
	fixture.report(luna.session_id, { tag: 'HELP', summary: '卡住了', hcom_name: 'luna', workspace: luna.workspace });
	fixture.list([luna]);
	await fixture.refresh(cookie);
	// The controller is deactivated; the page still shows the question it had open.
	fixture.list([]);

	const { status, body } = await answer(luna, asked, { text: '好' });
	const resend = await notify(luna);

	expect(status).toBe(409);
	expect(body).toMatchObject({ status: 'ended', reason: '這個主控已結束，它的待決題不能再作答。', entry: null });
	expect(resend).toMatchObject({ status: 409, body: { status: 'ended' } });
	expect(fixture.helperArgs('answer')).toEqual([]);
	expect(fixture.helperArgs('notify')).toEqual([]);
	// The refusal re-read the sources: the question is out of the inbox, the controller is 已結束.
	const after = await fixture.board(cookie);
	expect(titled(after, '已結束主控的題')).toBeUndefined();
	expect(named(after, 'luna')).toMatchObject({ status: 'ended' });
	expect(await sentAnswers(luna.session_id)).toEqual([]);
});

test('nothing is written for a controller the board does not know, or while the binding registry cannot be read', async () => {
	const asked = text();
	const luna = fixture.bound('alpha', 'luna', { questions: [asked] });
	fixture.list([]);
	const unknown = await answer(luna, asked, { text: '好' });

	fixture.setHelper({ output: { status: 'error', reason: 'invalid bindings file' }, exit: 1 });
	const unreadable = await answer(luna, asked, { text: '好' });
	const unreadableNotify = await notify(luna);

	expect(unknown).toMatchObject({ status: 409, body: { status: 'ended' } });
	expect(unreadable).toMatchObject({ status: 409, body: { status: 'error' } });
	expect(unreadable.body.reason).toContain('invalid bindings file');
	expect(unreadableNotify).toMatchObject({ status: 409, body: { status: 'error' } });
	expect(fixture.helperArgs('answer')).toEqual([]);
	expect(fixture.helperArgs('notify')).toEqual([]);
});

test('a sent answer whose question the controller asks again as a new version is logged as superseded', async () => {
	const asked = single({ title: '會被改版的題' });
	const luna = fixture.bound('alpha', 'luna', { questions: [asked] });
	fixture.list([luna]);
	await answer(luna, asked, { select: [3] });

	fixture.list([{ ...luna, questions: [single({ title: '改版後的題', revision: 2, section_sha256: 'e'.repeat(64) })] }]);
	const snapshot = await fixture.refresh(cookie);

	expect(titled(snapshot, '改版後的題')).toMatchObject({ unsent: true });
	expect(await sentAnswers(luna.session_id)).toMatchObject([{ revision: 1, answer: 'C. 只改一半', state: 'superseded' }]);
});

test('messages and answers to one controller share one sent log, newest first', async () => {
	const asked = text({ title: '混在一起的題' });
	const luna = fixture.bound('alpha', 'luna', { questions: [asked] });
	fixture.list([luna]);
	await answer(luna, asked, { text: '好' });
	// The message is refused (no input command in this fixture can reach a client), but logged.
	await post('/api/messages', { controllerId: luna.session_id, text: '--enter' });

	const response = await fixture.fetch(`/api/messages?controller=${luna.session_id}`, { cookie });
	const entries: SentEntry[] = (await response.json()).entries;

	expect(entries.map((entry) => entry.kind)).toEqual(['message', 'answer']);
});

test('a malformed request is rejected before anything is asked of the helper', async () => {
	const asked = single();
	const luna = fixture.bound('alpha', 'luna', { questions: [asked] });
	fixture.list([luna]);
	const valid = { controllerId: luna.session_id, questionId: 'S-1', revision: 1, sectionSha256: 'a'.repeat(64), select: [1], text: '', note: '' };

	for (const broken of [
		{ ...valid, controllerId: '' },
		{ ...valid, questionId: 7 },
		{ ...valid, revision: '1' },
		{ ...valid, revision: 1.5 },
		{ ...valid, sectionSha256: null },
		{ ...valid, select: '1' },
		{ ...valid, select: [0] },
		{ ...valid, select: ['1'] },
		{ ...valid, text: null },
		{ ...valid, note: 3 }
	]) {
		expect((await post('/api/answers', broken)).status).toBe(400);
	}
	const notJson = await fixture.fetch('/api/answers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{', cookie });
	expect(notJson.status).toBe(400);
	expect((await post('/api/answers/notify', {})).status).toBe(400);
	expect((await post('/api/answers/notify', { controllerId: 5 })).status).toBe(400);

	expect(fixture.helperArgs('answer')).toEqual([]);
	expect(fixture.helperArgs('notify')).toEqual([]);
	expect(listedQuestion(luna, 'S-1')).toEqual(asked);
});

test('an unpaired browser can neither answer nor resend a notification', async () => {
	const asked = text();
	const luna = fixture.bound('alpha', 'luna', { notification_pending: true, questions: [asked] });
	fixture.list([luna]);

	const answered = await answer(luna, asked, { text: '好' }, '');
	const resent = await notify(luna, '');

	expect(answered.status).toBe(401);
	expect(resent.status).toBe(401);
	expect(fixture.helperArgs('answer')).toEqual([]);
	expect(fixture.helperArgs('notify')).toEqual([]);
	expect(listedQuestion(luna, 'T-1')).toEqual(asked);
});
