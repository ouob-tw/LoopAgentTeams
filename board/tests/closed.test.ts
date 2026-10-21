// 已關閉: a bound controller whose session is gone from hcom's list is handled like an ended one.
// hcom, Herdr and the input command are fakes; nothing real is listed, typed into or resumed.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLOSED_ANSWER_REASON } from '../src/lib/board/answers.ts';
import { CLOSED_REASON } from '../src/lib/board/messages.ts';
import type { HelperController } from '../src/lib/board/types.ts';
import { named, NODE, question, startFixture, titled, type Fixture } from './harness.ts';

// Herdr and the input command log outside the fixture directory: their command lines have to be
// known before the fixture exists. hcom is the harness's own fake, in the fixture directory.
const commandDir = mkdtempSync(join(tmpdir(), 'lat-board-closed-'));
const commandEnv = {
	LAT_BOARD_HERDR_COMMAND: JSON.stringify([NODE, join(import.meta.dir, 'fake-herdr.mjs'), commandDir]),
	LAT_BOARD_INJECT_COMMAND: JSON.stringify([NODE, join(import.meta.dir, 'fake-inject.mjs'), commandDir]),
	LAT_BOARD_HCOM_TIMEOUT_SECONDS: '1'
};

let fixture: Fixture;
let cookie: string;

beforeAll(async () => {
	fixture = await startFixture({ env: commandEnv });
	cookie = await fixture.login();
});
afterAll(async () => {
	await fixture.cleanup();
	rmSync(commandDir, { recursive: true, force: true });
});
beforeEach(() => {
	for (const name of ['inject-calls.jsonl', 'inject-typed.jsonl', 'herdr.json']) rmSync(join(commandDir, name), { force: true });
	for (const name of ['hcom.json', 'hcom-calls.jsonl', 'hcom-added.json']) rmSync(join(fixture.dir, name), { force: true });
	// Each test's controllers are its own: no report of an earlier one is left to end up on the roster.
	rmSync(fixture.reportsDir, { recursive: true, force: true });
	mkdirSync(fixture.reportsDir);
});

const readLog = <T>(dir: string, name: string): T[] => {
	const file = join(dir, name);
	return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
};
const resumes = () => readLog<{ args: string[] }>(fixture.dir, 'hcom-calls.jsonl').filter((call) => call.args[0] === 'r');
const injects = () => readLog<string[]>(commandDir, 'inject-calls.jsonl');
const running = (...bindings: HelperController[]) => bindings.map((binding) => ({ name: binding.hcom_name, session_id: binding.session_id }));

const post = async (path: string, body: object) => {
	const response = await fixture.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cookie });
	return { status: response.status, body: await response.json() };
};

/** luna runs; orin is bound with a report in the inbox and an open question, but its client is gone. */
function scene() {
	const luna = fixture.bound('beta', 'luna');
	const orin = fixture.bound('alpha', 'orin', { questions: [question({ id: 'Q-1', title: '已關閉主控的題目' })] });
	fixture.report(luna.session_id, { tag: 'NO REPLY', summary: '實作中', hcom_name: 'luna', workspace: luna.workspace });
	fixture.report(orin.session_id, { tag: 'DONE', summary: '交付後關掉了', hcom_name: 'orin', workspace: orin.workspace });
	fixture.list([luna, orin]);
	return { luna, orin };
}

test('a bound controller missing from hcom\'s list is 已關閉: last on the roster, no questions, no Herdr place', async () => {
	const { luna, orin } = scene();
	// Bound, gone and without a report in the inbox: off the roster like an ended one.
	const quiet = fixture.bound('alpha', 'quiet', { questions: [question({ id: 'Q-9', title: '沒人看的題目' })] });
	fixture.list([luna, orin, quiet]);
	fixture.setHcom({ agents: running(luna) });

	const snapshot = await fixture.refresh(cookie);

	expect(snapshot.errors).toEqual([]);
	expect(snapshot.controllers.map((controller) => [controller.hcomName, controller.status])).toEqual([
		['luna', 'working'],
		['orin', 'closed']
	]);
	expect(named(snapshot, 'orin')).toMatchObject({ phase: '交付後關掉了', pendingCount: 0, herdr: null, project: 'alpha' });
	expect(titled(snapshot, '已關閉主控的題目')).toBeUndefined();
	expect(titled(snapshot, '沒人看的題目')).toBeUndefined();
	expect(titled(snapshot, '交付後關掉了')).toMatchObject({ kind: 'report', controllerId: orin.session_id });
});

test('a deactivated controller still in hcom\'s list is 閒置 and runs; one gone from it is 已關閉', async () => {
	const { luna } = scene();
	const woken = { session_id: 'woken-session', hcom_name: 'nova' } as HelperController;
	const gone = { session_id: 'gone-session', hcom_name: 'vela' } as HelperController;
	for (const ended of [woken, gone]) {
		fixture.report(ended.session_id, { tag: 'DONE', summary: `${ended.hcom_name} 交付`, hcom_name: ended.hcom_name, workspace: luna.workspace });
	}
	fixture.setHcom({ agents: running(luna, woken) });

	const snapshot = await fixture.refresh(cookie);

	expect(named(snapshot, 'luna')).toMatchObject({ status: 'working', running: true });
	expect(named(snapshot, 'orin')).toMatchObject({ status: 'closed', running: false });
	expect(named(snapshot, 'nova')).toMatchObject({ status: 'idle', running: true });
	expect(named(snapshot, 'vela')).toMatchObject({ status: 'closed', running: false });
});

test('a closed controller\'s question cannot be answered and a message is refused; a wake resumes it', async () => {
	const { luna, orin } = scene();
	fixture.setHcom({ agents: running(luna) });
	await fixture.refresh(cookie);

	const answer = await post('/api/answers', {
		controllerId: orin.session_id,
		questionId: 'Q-1',
		revision: 1,
		sectionSha256: orin.questions[0].section_sha256,
		select: [1],
		text: '',
		note: ''
	});
	expect(answer).toMatchObject({ status: 409, body: { status: 'ended', reason: CLOSED_ANSWER_REASON } });
	const message = await post('/api/messages', { controllerId: orin.session_id, text: '還在嗎' });
	expect(message).toMatchObject({ status: 409, body: { ok: false, reason: CLOSED_REASON } });
	expect(injects()).toEqual([]);

	writeFileSync(
		join(commandDir, 'herdr.json'),
		JSON.stringify({ panes: [{ workspace_id: 'wA', cwd: orin.workspace, pane_id: 'wA:p1' }], workspaces: [{ workspace_id: 'wA', number: 1, label: 'alpha' }] })
	);
	const wake = await post('/api/wake', { controllerId: orin.session_id, text: '接回來', newRound: false });
	expect(wake.body).toMatchObject({ ok: true, entry: { route: 'resume' } });
	expect(resumes().map((call) => call.args.slice(0, 2))).toEqual([['r', orin.session_id]]);
	expect(injects()).toEqual([]);

	// The resume is still open: a read settles it with the same list it judges the roster by.
	const lists = () => readLog<string[]>(fixture.dir, 'hcom-list-calls.jsonl').length;
	const before = lists();
	await fixture.refresh(cookie);
	expect(lists() - before).toBe(1);
});

test('closed, then the list cannot be read, then it can again: the last list stands in meanwhile', async () => {
	const { luna, orin } = scene();
	fixture.setHcom({ agents: running(luna) });
	expect(named(await fixture.refresh(cookie), 'orin')?.status).toBe('closed');

	fixture.setHcom({ agents: running(luna), listFail: { exit: 1, stderr: 'hcom broke' } });
	const failed = await fixture.refresh(cookie);
	expect(named(failed, 'orin')?.status).toBe('closed');
	expect(named(failed, 'luna')?.status).toBe('working');
	expect(titled(failed, '已關閉主控的題目')).toBeUndefined();
	expect(failed.errors).toEqual([expect.stringContaining('hcom 的 Agent 清單讀不到')]);
	expect(failed.errors[0]).toContain('沿用上次讀到的清單');
	const message = await post('/api/messages', { controllerId: orin.session_id, text: '還在嗎' });
	expect(message.body.reason).toBe(CLOSED_REASON);

	// Back, and orin is listed again: it was resumed elsewhere, so it is active once more.
	fixture.setHcom({ agents: running(luna, orin) });
	const back = await fixture.refresh(cookie);
	expect(back.errors).toEqual([]);
	expect(named(back, 'orin')).toMatchObject({ status: 'waiting', pendingCount: 1, herdr: { workspace: 'ws-alpha', tab: 'tab-1', pane: 'pane-1' } });
	expect(titled(back, '已關閉主控的題目')).toMatchObject({ kind: 'question', controllerId: orin.session_id });
});

test('a closed controller that reappears in the list is active again, typed into and answerable', async () => {
	const { luna, orin } = scene();
	fixture.setHcom({ agents: running(luna) });
	expect(named(await fixture.refresh(cookie), 'orin')?.status).toBe('closed');

	fixture.setHcom({ agents: running(luna, orin) });
	expect(named(await fixture.refresh(cookie), 'orin')?.status).toBe('waiting');
	const message = await post('/api/messages', { controllerId: orin.session_id, text: '回來了嗎' });
	expect(message).toMatchObject({ status: 200, body: { ok: true } });
	expect(injects()).toEqual([['orin', '回來了嗎', '--enter']]);
});

test('a list that cannot be read since startup shows every bound controller as active, with an error', async () => {
	const hcomDir = mkdtempSync(join(tmpdir(), 'lat-board-closed-start-'));
	writeFileSync(join(hcomDir, 'hcom.json'), JSON.stringify({ listFail: { exit: 3, stderr: 'not ready' } }));
	const cold = await startFixture({
		env: { ...commandEnv, LAT_BOARD_HCOM_COMMAND: JSON.stringify([NODE, join(import.meta.dir, 'fake-hcom.mjs'), hcomDir]) }
	});
	try {
		const coldCookie = await cold.login();
		const luna = cold.bound('beta', 'luna', { questions: [question({ id: 'Q-1', title: '啟動時的題目' })] });
		cold.list([luna]);

		const snapshot = await cold.refresh(coldCookie);

		expect(named(snapshot, 'luna')).toMatchObject({ status: 'waiting', pendingCount: 1 });
		expect(titled(snapshot, '啟動時的題目')).toMatchObject({ kind: 'question' });
		expect(snapshot.errors).toEqual([expect.stringContaining('hcom 的 Agent 清單讀不到')]);
		expect(snapshot.errors[0]).toContain('主控暫時都顯示為啟用中');
	} finally {
		await cold.cleanup();
		rmSync(hcomDir, { recursive: true, force: true });
	}
});

test('the bindings are never changed: the helper is only asked to list them', async () => {
	const { luna, orin } = scene();
	fixture.setHcom({ agents: running(luna) });
	await fixture.refresh(cookie);

	expect(fixture.helperArgs('answer')).toEqual([]);
	expect(fixture.helperArgs('notify')).toEqual([]);
	expect(fixture.listed()).toEqual([luna, orin]);
});
