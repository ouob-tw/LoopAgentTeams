// Approving, rejecting and the task a 任務提案 becomes (#760), on the built board: a logged-in
// device at the board's https address asks for a challenge bound to one proposal at the version its
// card showed, signs it with the board's passkey (a software authenticator, tests/soft-passkey.ts)
// with the holder checked, and the board commits 核准中 with everything the task is made from, makes
// the task under the proposal's fixed task ID and writes 已核准. A board stopped halfway finishes
// from the saved record at its next start. Each final result is told to the proposer once over the
// fake hcom, found by its session. Every folder, the socket and hcom are the fixture's own.
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, expect, test } from 'bun:test';
import { DAY, jsonLines, logged, until, type Fixture } from '../harness.ts';
import { decrypt, deviceKeys } from '../push-keys.ts';
import { SoftPasskey } from '../soft-passkey.ts';
import { agentTask, asAgent, commandTask, listed, parsed, proposalsDir, stored, submit, withAgents, type AgentDouble } from '../task-proposal-fixture.ts';

const ORIGIN = 'https://lat.ouob.net';
const RP_ID = 'lat.ouob.net';
const T0 = Date.parse('2026-11-28T01:00:00.000Z');

/** A push service on this host: every push the board sends to it. */
const pushed: { path: string; body: Buffer }[] = [];
const pushService = Bun.serve({
	port: 0,
	hostname: '127.0.0.1',
	async fetch(request) {
		pushed.push({ path: new URL(request.url).pathname, body: Buffer.from(await request.arrayBuffer()) });
		return new Response(null, { status: 201 });
	}
});
const PUSH_ORIGIN = `http://127.0.0.1:${pushService.port}`;
afterAll(() => pushService.stop(true));

let fixture: Fixture | undefined;
afterEach(async () => {
	if (fixture) chmodSync(proposalsDir(fixture), 0o700);
	await fixture?.cleanup();
	fixture = undefined;
});

type Call = { body?: unknown; cookie?: string; http?: boolean; raw?: string };
/** A request through the trusted proxy, over HTTPS unless `http`. */
function call(board: Fixture, method: string, path: string, { body, cookie, http = false, raw }: Call = {}) {
	return board.fetch(path, {
		method,
		headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.1', ...(http ? {} : { 'x-forwarded-proto': 'https' }) },
		body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
		cookie
	});
}

interface Setup {
	board: Fixture;
	agents: AgentDouble[];
	cookie: string;
	deviceId: string;
	passkey: SoftPasskey;
	passkeyId: string;
}

/** The server's log lines with this name once there are `count` of them: what it writes reaches
 *  the test's pipe a little after the response. */
const linesOf = (board: Fixture, message: string, count: number) =>
	until(() => {
		const lines = logged(board.serverOutput(), message);
		return lines.length >= count && lines;
	}, 5_000, `${count} ${message} line(s)`);

/** A logged-in device's cookie and ID, from its login line once the server's output has it. */
async function loggedIn(board: Fixture, label: string) {
	const before = logged(board.serverOutput(), 'login_totp').length;
	const cookie = await board.login(label);
	const line = await until(() => logged(board.serverOutput(), 'login_totp')[before], 5_000, `the login line of ${label}`);
	return { cookie, deviceId: String(line.device_id) };
}

/** A board at the https address with these agents, a logged-in device and one board passkey. */
async function setup(names: { name: string; client: 'claude' | 'codex' }[] = [{ name: 'luna', client: 'codex' }], env: Record<string, string> = {}): Promise<Setup> {
	const { board, agents } = await withAgents(names, { clock: T0, env: { LAT_BOARD_URL: ORIGIN, LAT_BOARD_TRUSTED_PROXIES: '127.0.0.1', ...env } }, (started) => (fixture = started));
	const { cookie, deviceId } = await loggedIn(board, 'phone');
	const passkey = new SoftPasskey(ORIGIN, RP_ID);
	const started = await call(board, 'POST', '/api/passkeys/options', { cookie });
	const { options, enrollment } = await started.json();
	expect((await call(board, 'POST', '/api/passkeys', { cookie, body: { enrollment, response: passkey.register(options) } })).status).toBe(200);
	const passkeyId = (await (await call(board, 'GET', '/api/passkeys', { cookie })).json()).passkeys[0].id;
	return { board, agents, cookie, deviceId, passkey, passkeyId };
}

const proposalOf = async (board: Fixture, agent: AgentDouble, task: unknown) => {
	const reply = parsed(await submit(board, agent, task));
	expect(reply).toMatchObject({ ok: true, status: 'pending' });
	return reply.id as string;
};
const card = async (board: Fixture, cookie: string, id: string) => (await call(board, 'GET', `/api/task-proposals/${id}`, { cookie })).json();
const askChallenge = async (board: Fixture, cookie: string, id: string, contentHash?: string) =>
	call(board, 'POST', `/api/task-proposals/${id}/challenge`, { cookie, body: { contentHash: contentHash ?? (await card(board, cookie, id)).contentHash } });
/** A challenge's options, asked for as the card shows the proposal now. */
async function challengeFor(board: Fixture, cookie: string, id: string) {
	const response = await askChallenge(board, cookie, id);
	expect(response.status).toBe(200);
	return (await response.json()).options as { challenge: string; userVerification: string };
}
const approve = (board: Fixture, cookie: string, id: string, response: unknown) => call(board, 'POST', `/api/task-proposals/${id}/approve`, { cookie, body: { response } });
/** Ask, sign with `passkey` (or as `answer` signs) and approve: the approval's response. */
async function approveWith(s: Pick<Setup, 'board' | 'cookie' | 'passkey'>, id: string, answer = (options: { challenge: string }) => s.passkey.answer(options)) {
	return approve(s.board, s.cookie, id, answer(await challengeFor(s.board, s.cookie, id)));
}
const reject = (board: Fixture, cookie: string, id: string, body?: unknown) => call(board, 'POST', `/api/task-proposals/${id}/reject`, { cookie, body });
const tasksOf = async (board: Fixture, cookie: string) => ((await (await call(board, 'GET', '/api/automation', { cookie })).json()).tasks as { task: Record<string, any> }[]).map((view) => view.task);
const resultPath = (board: Fixture, id: string) => join(proposalsDir(board), `${id}.result.json`);
const resultOf = (board: Fixture, id: string) => JSON.parse(readFileSync(resultPath(board, id), 'utf8'));
const notifyOf = (board: Fixture, id: string) => {
	const path = join(proposalsDir(board), `${id}.notify.json`);
	return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
};
const sends = (board: Fixture) => jsonLines(join(board.dir, 'hcom-send-calls.jsonl')) as { args: string[]; text: string; agentLike: string[] }[];
const notified = (board: Fixture, id: string, status = 'sent') => until(() => notifyOf(board, id)?.status === status && notifyOf(board, id), 10_000, `the message about ${id} to be ${status}`);
const sentLog = (board: Fixture) => jsonLines(join(board.dir, 'board-state', 'sent-log.jsonl')) as Record<string, any>[];

test('approving with the board passkey makes one task equal to the proposal, with its source; 已核准 with the task ID, told to the proposer once', async () => {
	const s = await setup();
	const { board, cookie, agents } = s;
	const [luna] = agents;
	const id = await proposalOf(board, luna, commandTask(luna.folder));
	const options = await challengeFor(board, cookie, id);
	// The holder must be checked: fingerprint, face or device PIN.
	expect(options.userVerification).toBe('required');
	const approved = await approve(board, cookie, id, s.passkey.answer(options));
	expect(approved.status).toBe(200);
	expect(await approved.json()).toEqual({ ok: true, id, status: 'approved', taskId: `proposal-${id}` });

	const tasks = await tasksOf(board, cookie);
	expect(tasks).toHaveLength(1);
	const { id: taskId, paused, createdAt, updatedAt, source, ...settings } = tasks[0];
	expect(taskId).toBe(`proposal-${id}`);
	expect(settings).toEqual(stored(board, id).task);
	expect(source).toEqual({
		kind: 'proposal',
		proposalId: id,
		proposer: { name: 'grp-luna', client: 'codex', role: 'agent', folder: luna.folder, sessionId: 'session-luna' },
		proposedAt: stored(board, id).createdAt,
		approvedAt: new Date(T0).toISOString(),
		deviceId: s.deviceId,
		passkeyId: s.passkeyId
	});
	expect(resultOf(board, id)).toMatchObject({ status: 'approved', taskId, approval: { taskId, task: stored(board, id).task, source: { deviceId: s.deviceId } } });
	// The save is logged as by the approving device, as a form's would be.
	expect(sentLog(board).filter((line) => line.kind === 'automation-task-save')).toMatchObject([{ taskId, deviceId: s.deviceId, proposalId: id, unattended: null }]);

	const status = await asAgent(board, luna, ['status', id]);
	expect(status.stdout.trim()).toBe(`已核准：${id}\n任務編號：${taskId}`);
	expect(JSON.parse((await asAgent(board, luna, ['--json', 'status', id])).stdout)).toEqual({ version: 1, id, status: 'approved', at: expect.any(String), taskId, ok: true });

	// One message, to the proposer's name for its session, with no task content.
	await notified(board, id);
	expect(sends(board)).toHaveLength(1);
	const [message] = sends(board);
	expect(message.args).toEqual(['send', '@grp-luna', '--intent', 'inform', '--from', 'lat-board']);
	expect(message.text).toBe(`任務提案 ${id}：已核准\n任務編號：${taskId}\n查詢結果：task-proposal.py status ${id}`);
	expect(message.agentLike).toEqual([]);
	expect((await card(board, cookie, id)).notify).toMatchObject({ attempt: 1, status: 'sent', to: 'grp-luna' });
	// 登入紀錄 has the challenge and the approval, with the passkey that signed.
	expect(await linesOf(board, 'task_proposal_challenge', 1)).toMatchObject([{ result: 'start', device_id: s.deviceId }]);
	expect(await linesOf(board, 'task_proposal_approve', 1)).toMatchObject([{ result: 'success', device_id: s.deviceId, passkey_id: s.passkeyId }]);

	// Once only: the same answer again, or another approval, makes nothing more.
	expect((await approve(board, cookie, id, s.passkey.answer(options))).status).toBe(409);
	const again = await askChallenge(board, cookie, id);
	expect([again.status, (await again.json()).error]).toEqual([409, 'ended']);
	expect(await tasksOf(board, cookie)).toHaveLength(1);
	expect(sends(board)).toHaveLength(1);
});

test('a challenge works once, for 5 minutes, for its proposal and login, signed with the holder checked at the board address; pd\'s passkey and a test login cannot', async () => {
	const s = await setup();
	const { board, cookie, passkey, agents } = s;
	const [luna] = agents;
	const first = await proposalOf(board, luna, commandTask(luna.folder));
	const second = await proposalOf(board, luna, commandTask(luna.folder, { name: '第二個' }));
	const other = await loggedIn(board, 'laptop');
	const failure = async (response: Response) => [response.status, (await response.json()).error];

	// Another proposal, another login.
	expect(await failure(await approve(board, cookie, second, passkey.answer(await challengeFor(board, cookie, first))))).toEqual([409, 'approval_failed']);
	expect(await failure(await approve(board, other.cookie, first, passkey.answer(await challengeFor(board, cookie, first))))).toEqual([409, 'approval_failed']);
	// Past 5 minutes.
	const late = await challengeFor(board, cookie, first);
	board.setClock(T0 + 5 * 60_000);
	expect(await failure(await approve(board, cookie, first, passkey.answer(late)))).toEqual([409, 'approval_failed']);
	// Another origin, another RP, no user verification.
	for (const signed of [{ origin: 'https://evil.example' }, { rpId: 'evil.example' }, { verified: false }])
		expect(await failure(await approveWith(s, first, (options) => passkey.answer(options, signed)))).toEqual([409, 'approval_failed']);
	// A passkey the board did not register (pd's own, say).
	const pdPasskey = new SoftPasskey(ORIGIN, RP_ID);
	expect(await failure(await approveWith(s, first, (options) => pdPasskey.answer(options)))).toEqual([409, 'approval_failed']);
	// A used one, even right.
	const used = passkey.answer(await challengeFor(board, cookie, first));
	expect(await failure(await approve(board, cookie, second, used))).toEqual([409, 'approval_failed']);
	expect(await failure(await approve(board, cookie, first, used))).toEqual([409, 'approval_failed']);
	expect((await linesOf(board, 'task_proposal_approval_refused', 9)).map((line) => line.cause)).toEqual([
		'other-proposal',
		'other-login',
		'expired-challenge',
		'signature',
		'signature',
		'signature',
		'unknown-passkey',
		'other-proposal',
		'unknown-challenge'
	]);
	// Over plain http there is no passkey at all.
	expect(await failure(await call(board, 'POST', `/api/task-proposals/${first}/challenge`, { cookie, http: true, body: { contentHash: (await card(board, cookie, first)).contentHash } }))).toEqual([409, 'passkey_unavailable']);
	expect(await tasksOf(board, cookie)).toHaveLength(0);

	// A test login may not even ask, approve or reject.
	const issued = await board.cli('test-login', '--url', board.url, '--label', 'qa');
	const code = issued.stdout.match(new RegExp(`${board.url}/login/test#(\\S+)`))![1];
	const redeemed = await board.fetch('/api/login/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
	const testCookie = redeemed.headers.getSetCookie()[0].split(';')[0];
	for (const path of ['challenge', 'approve', 'reject']) {
		const refused = await call(board, 'POST', `/api/task-proposals/${first}/${path}`, { cookie: testCookie, body: { contentHash: 'a'.repeat(64), response: { id: 'x' } } });
		expect([refused.status, (await refused.json()).error]).toEqual([403, 'test_device']);
	}

	// Signed right, it goes through.
	expect((await (await approveWith(s, first)).json()).status).toBe('approved');
	expect((await tasksOf(board, cookie)).map((task) => task.id)).toEqual([`proposal-${first}`]);
});

test('a passkey deleted or a login revoked after the challenge fails the approval with no task', async () => {
	const s = await setup();
	const { board, cookie, passkey, agents } = s;
	const [luna] = agents;
	const id = await proposalOf(board, luna, commandTask(luna.folder));

	const options = await challengeFor(board, cookie, id);
	const backup = new SoftPasskey(ORIGIN, RP_ID);
	const started = await (await call(board, 'POST', '/api/passkeys/options', { cookie })).json();
	expect((await call(board, 'POST', '/api/passkeys', { cookie, body: { enrollment: started.enrollment, response: backup.register(started.options) } })).status).toBe(200);
	expect((await call(board, 'DELETE', `/api/passkeys/${s.passkeyId}`, { cookie })).status).toBe(200);
	expect((await (await approve(board, cookie, id, passkey.answer(options))).json()).error).toBe('approval_failed');

	const other = await loggedIn(board, 'laptop');
	const revoked = await challengeFor(board, other.cookie, id);
	expect((await board.cli('revoke', other.deviceId)).code).toBe(0);
	const answer = await approve(board, other.cookie, id, backup.answer(revoked));
	expect([answer.status, await answer.json()]).toEqual([401, { error: 'unpaired' }]);

	expect(await tasksOf(board, cookie)).toHaveLength(0);
	expect(existsSync(resultPath(board, id))).toBe(false);
});

test('a proposal changed after its card was shown gets no challenge; changed after the challenge, it makes no task and still waits', async () => {
	const s = await setup();
	const { board, cookie, passkey, agents } = s;
	const [luna] = agents;
	const id = await proposalOf(board, luna, commandTask(luna.folder));
	const file = join(proposalsDir(board), `${id}.json`);
	const change = (name: string) => writeFileSync(file, JSON.stringify({ ...stored(board, id), task: { ...stored(board, id).task, name } }, null, '\t'));

	const shown = (await card(board, cookie, id)).contentHash;
	change('偷換的名稱');
	const refused = await askChallenge(board, cookie, id, shown);
	expect([refused.status, (await refused.json()).error]).toEqual([409, 'changed']);

	const options = await challengeFor(board, cookie, id);
	change('又偷換一次');
	const approved = await approve(board, cookie, id, passkey.answer(options));
	expect([approved.status, (await approved.json()).error]).toEqual([409, 'changed']);
	expect(await tasksOf(board, cookie)).toHaveLength(0);
	expect((await card(board, cookie, id)).status).toBe('pending');
});

test('approval against rejection, withdrawal and expiry: whichever result lands first counts, and a task exists only for an approval', async () => {
	const s = await setup();
	const { board, cookie, passkey, agents } = s;
	const [luna] = agents;
	const ids: string[] = [];
	for (let n = 0; n < 5; n++) ids.push(await proposalOf(board, luna, commandTask(luna.folder, { name: `任務 ${n}` })));
	const ended = async (response: Response) => [response.status, (await response.json()).error];

	// Rejected, then the signed approval arrives.
	let options = await challengeFor(board, cookie, ids[0]);
	expect((await reject(board, cookie, ids[0])).status).toBe(200);
	expect(await ended(await approve(board, cookie, ids[0], passkey.answer(options)))).toEqual([409, 'ended']);
	// Withdrawn by its agent, then approved.
	options = await challengeFor(board, cookie, ids[1]);
	expect((await asAgent(board, luna, ['withdraw', ids[1]])).code).toBe(0);
	expect(await ended(await approve(board, cookie, ids[1], passkey.answer(options)))).toEqual([409, 'ended']);
	// Approved, then rejected and withdrawn.
	expect((await (await approveWith(s, ids[2])).json()).status).toBe('approved');
	expect(await ended(await reject(board, cookie, ids[2], { reason: '晚了' }))).toEqual([409, 'ended']);
	expect(parsed(await asAgent(board, luna, ['--json', 'withdraw', ids[2]]))).toMatchObject({ ok: false, error: 'ended', status: 'approved' });
	// Both at once.
	options = await challengeFor(board, cookie, ids[3]);
	const [byPasskey, byReject] = await Promise.all([approve(board, cookie, ids[3], passkey.answer(options)), reject(board, cookie, ids[3])]);
	expect([byPasskey.status, byReject.status].sort()).toEqual([200, 409]);
	const winner = resultOf(board, ids[3]).status;
	expect(['approved', 'rejected']).toContain(winner);
	// Expired while the user signed.
	board.setClock(T0 + DAY - 60_000);
	options = await challengeFor(board, cookie, ids[4]);
	board.setClock(T0 + DAY);
	expect(await ended(await approve(board, cookie, ids[4], passkey.answer(options)))).toEqual([409, 'ended']);
	expect(resultOf(board, ids[4]).status).toBe('expired');

	const tasks = (await tasksOf(board, cookie)).map((task) => task.id).sort();
	expect(tasks).toEqual([`proposal-${ids[2]}`, ...(winner === 'approved' ? [`proposal-${ids[3]}`] : [])].sort());
	// Every final result but the withdrawal is told, once each.
	for (const id of [ids[0], ids[2], ids[3], ids[4]]) await notified(board, id);
	expect(notifyOf(board, ids[1])).toBeNull();
	expect(sends(board).map((sent) => sent.text.split('\n')[0]).sort()).toEqual(
		[`任務提案 ${ids[0]}：已拒絕`, `任務提案 ${ids[2]}：已核准`, `任務提案 ${ids[3]}：${winner === 'approved' ? '已核准' : '已拒絕'}`, `任務提案 ${ids[4]}：已過期`].sort()
	);
});

test('a proposal never changes a task already there, whatever its fields say; the board\'s own 新增任務 needs no passkey', async () => {
	const s = await setup();
	const { board, cookie, agents } = s;
	const [luna] = agents;
	// 新增任務 on the board: no challenge, no passkey.
	const created = await call(board, 'POST', '/api/automation', { cookie, body: commandTask(luna.folder, { name: '自己建的' }) });
	expect(created.status).toBe(201);
	const own = await created.json();
	expect(logged(board.serverOutput(), 'task_proposal_challenge')).toHaveLength(0);
	const [before] = await tasksOf(board, cookie);

	// A proposal naming that task, paused, under the same name, makes a task of its own.
	const id = await proposalOf(board, luna, { ...commandTask(luna.folder, { name: '自己建的' }), id: own.id, paused: true, source: { kind: 'proposal' } });
	expect(await (await approveWith(s, id)).json()).toMatchObject({ status: 'approved', taskId: `proposal-${id}` });
	const after = await tasksOf(board, cookie);
	expect(after.find((task) => task.id === own.id)).toEqual(before);
	expect(after.find((task) => task.id === `proposal-${id}`)).toMatchObject({ name: '自己建的', paused: false, source: { proposalId: id } });
	expect(after).toHaveLength(2);
});

test('a rejection keeps the optional reason, which the proposer\'s query and wait return; a reason too long or not text is a 400', async () => {
	const s = await setup();
	const { board, cookie, agents } = s;
	const [luna] = agents;
	const id = await proposalOf(board, luna, commandTask(luna.folder));
	const waiting = asAgent(board, luna, ['wait', id, '--timeout', '20']);
	expect((await reject(board, cookie, id, { reason: 'x'.repeat(501) })).status).toBe(400);
	expect((await reject(board, cookie, id, { reason: 3 })).status).toBe(400);
	const done = await reject(board, cookie, id, { reason: '  時間改到晚上  ' });
	expect(await done.json()).toEqual({ ok: true, id, status: 'rejected', reason: '時間改到晚上' });
	expect((await waiting).stdout.trim()).toBe(`已拒絕：${id}\n原因：時間改到晚上`);
	expect(resultOf(board, id)).toMatchObject({ status: 'rejected', reason: '時間改到晚上', deviceId: s.deviceId });
	await notified(board, id);
	expect(sends(board).map((sent) => sent.text)).toEqual([`任務提案 ${id}：已拒絕\n原因：時間改到晚上\n查詢結果：task-proposal.py status ${id}`]);

	// No reason at all is a rejection too.
	const plain = await proposalOf(board, luna, commandTask(luna.folder));
	expect(await (await reject(board, cookie, plain)).json()).toEqual({ ok: true, id: plain, status: 'rejected' });
});

/** An unattended agent task with its brief in the agent's folder. */
function unattendedTask(folder: string) {
	const task = agentTask(folder);
	return { ...task, agent: { ...task.agent, client: 'claude', model: 'claude-opus-5-5', unattended: { goal: '整理 issue', done: ['needs-triage 清空'], scope: { ticket_confirmation: true } } } };
}

test('a board stopped after 核准中, or after the task and before 已核准, finishes at its next start from the saved record alone: one task, 已核准', async () => {
	const s = await setup([{ name: 'luna', client: 'claude' }]);
	const { board, cookie, agents } = s;
	const [luna] = agents;
	writeFileSync(join(luna.folder, 'brief.md'), '# 核准的說明\n');
	const id = await proposalOf(board, luna, unattendedTask(luna.folder));
	const taskId = `proposal-${id}`;
	expect((await (await approveWith(s, id)).json()).status).toBe('approved');
	await notified(board, id);
	const [made] = await tasksOf(board, cookie);
	const copy = made.agent.brief;
	const approved = resultOf(board, id);
	const automationDir = join(board.dir, 'board-state', 'automation');
	/** Back to 核准中 as it was committed, before the task was made (or with it). */
	const backToApproving = (withTask: boolean) => {
		const { taskId: _made, ...approving } = approved;
		writeFileSync(resultPath(board, id), JSON.stringify({ ...approving, status: 'approving', at: approved.approval.source.approvedAt }));
		if (!withTask) rmSync(join(automationDir, `${taskId}.json`));
		if (!withTask) rmSync(copy);
	};

	// Stopped after 核准中, before anything was told: the proposal and the agent's brief changed
	// meanwhile, then the proposal is gone.
	await board.stop();
	backToApproving(false);
	rmSync(join(proposalsDir(board), `${id}.notify.json`));
	writeFileSync(join(luna.folder, 'brief.md'), '# 改過的說明\n');
	writeFileSync(join(proposalsDir(board), `${id}.json`), JSON.stringify({ ...stored(board, id), task: { ...stored(board, id).task, name: '偷換' } }));
	await board.start();
	let tasks = await tasksOf(board, cookie);
	expect(tasks).toHaveLength(1);
	const { createdAt: _a, updatedAt: _b, ...again } = tasks[0];
	const { createdAt: _c, updatedAt: _d, ...first } = made;
	expect(again).toEqual(first);
	expect(readFileSync(copy, 'utf8')).toBe('# 核准的說明\n');
	expect(resultOf(board, id)).toMatchObject({ status: 'approved', taskId });
	// The grant's save is the approving device's again, as an unattended run needs it.
	const saves = sentLog(board).filter((line) => line.kind === 'automation-task-save');
	expect(saves).toHaveLength(2);
	expect(saves[1]).toMatchObject({ taskId, deviceId: s.deviceId, proposalId: id, unattended: { goal: '整理 issue', done: ['needs-triage 清空'], maxHours: 1 } });
	// The 已核准 written at the start is told, to the proposer the saved approval names.
	await notified(board, id);
	expect(sends(board).map((sent) => [sent.args[1], sent.text.split('\n')[0]])).toEqual([
		['@grp-luna', `任務提案 ${id}：已核准`],
		['@grp-luna', `任務提案 ${id}：已核准`]
	]);

	await board.stop();
	rmSync(join(proposalsDir(board), `${id}.json`));
	backToApproving(false);
	await board.start();
	expect((await tasksOf(board, cookie)).map((task) => [task.id, task.name, task.source.proposer.name])).toEqual([[taskId, '每週整理 issue', 'grp-luna']]);

	// Stopped after the task, before 已核准: the task stays the one made then.
	await board.stop();
	backToApproving(true);
	const before = (await Bun.file(join(automationDir, `${taskId}.json`)).json()).createdAt;
	await board.start();
	tasks = await tasksOf(board, cookie);
	expect(tasks.map((task) => [task.id, task.createdAt])).toEqual([[taskId, before]]);
	expect(resultOf(board, id).status).toBe('approved');
	// Told once per 已核准 written; finishing it again tells nothing more.
	await Bun.sleep(300);
	expect(sends(board)).toHaveLength(2);
});

test('a damaged saved approval ends 核准失敗 with no task and a push; a task that cannot be made ends 核准失敗 and is told; a 已核准 that cannot be written is retried with no second task', async () => {
	const s = await setup(undefined, { LAT_BOARD_PUSH_TEST_ORIGIN: PUSH_ORIGIN });
	const { board, cookie, agents } = s;
	const [luna] = agents;
	const automationDir = join(board.dir, 'board-state', 'automation');
	const keys = deviceKeys();
	expect((await call(board, 'PUT', '/api/push/subscription', { cookie, body: { endpoint: `${PUSH_ORIGIN}/push/phone`, keys: keys.json } })).status).toBe(200);

	// The task cannot be made: its folder went after the proposal came in.
	const gone = join(board.dir, 'gone-folder');
	Bun.spawnSync(['mkdir', '-p', gone]);
	const failing = await proposalOf(board, luna, commandTask(gone));
	rmSync(gone, { recursive: true });
	const failed = await (await approveWith(s, failing)).json();
	expect(failed).toMatchObject({ ok: true, status: 'approve-failed' });
	expect(failed.reason).toStartWith('建立任務失敗：');
	await notified(board, failing);
	expect(sends(board).at(-1)!.text).toStartWith(`任務提案 ${failing}：核准失敗\n原因：建立任務失敗：`);

	// Damaged: the saved task no longer matches its hash.
	const id = await proposalOf(board, luna, commandTask(luna.folder));
	expect((await (await approveWith(s, id)).json()).status).toBe('approved');
	const approved = resultOf(board, id);
	await board.stop();
	rmSync(join(automationDir, `proposal-${id}.json`));
	const { taskId: _made, ...approving } = approved;
	writeFileSync(resultPath(board, id), JSON.stringify({ ...approving, status: 'approving', approval: { ...approved.approval, task: { ...approved.approval.task, name: '偷換' } } }));
	await board.start();
	expect(resultOf(board, id)).toEqual({ version: 1, id, status: 'approve-failed', at: expect.any(String), reason: '核准紀錄損壞，請 Agent 重新提案' });
	expect(await tasksOf(board, cookie)).toHaveLength(0);
	// The user hears of it: one push, with no task content; a task that just could not be made pushes nothing.
	// Each new proposal also pushes that one waits (#761); only the failure pushes are counted here.
	const failurePushes = () => pushed.filter((entry) => entry.path === '/push/phone').map((entry) => decrypt(entry.body, keys) as Record<string, string>).filter((message) => message.title !== '任務提案待核准');
	const [push] = await until(() => failurePushes().length > 0 && failurePushes(), 10_000, 'the push');
	expect(push).toEqual({ title: '任務提案核准失敗', body: '核准紀錄損壞，沒有建立任務；請 Agent 重新提案', alert: `task-proposal-${id}` });
	expect(failurePushes()).toHaveLength(1);
	expect((await asAgent(board, luna, ['status', id])).stdout.trim()).toBe(`核准失敗：${id}\n原因：核准紀錄損壞，請 Agent 重新提案`);

	// Damaged after its task was made: that task came from the approval as it was, so it stands.
	const madeFirst = await proposalOf(board, luna, commandTask(luna.folder, { name: '先建好' }));
	expect((await (await approveWith(s, madeFirst)).json()).status).toBe('approved');
	const kept = resultOf(board, madeFirst);
	await board.stop();
	writeFileSync(resultPath(board, madeFirst), '{"status": "approv');
	await board.start();
	expect(resultOf(board, madeFirst)).toEqual({ version: 1, id: madeFirst, status: 'approved', at: expect.any(String), taskId: kept.taskId });
	expect((await tasksOf(board, cookie)).map((task) => task.id)).toEqual([`proposal-${madeFirst}`]);
	expect((await call(board, 'DELETE', `/api/automation/proposal-${madeFirst}`, { cookie })).status).toBe(204);

	// A result that cannot be read just now is left as it is.
	const locked = await proposalOf(board, luna, commandTask(luna.folder, { name: '鎖住' }));
	expect((await reject(board, cookie, locked)).status).toBe(200);
	chmodSync(resultPath(board, locked), 0o000);
	await card(board, cookie, locked);
	expect((await (await call(board, 'GET', '/api/task-proposals', { cookie })).json()).proposals.map((proposal: { id: string }) => proposal.id)).not.toContain(locked);
	chmodSync(resultPath(board, locked), 0o600);
	expect(resultOf(board, locked).status).toBe('rejected');

	// 已核准 cannot be written: 核准中 stays until a later look can write it; one task all along.
	const retried = await proposalOf(board, luna, commandTask(luna.folder, { name: '重試' }));
	expect((await (await approveWith(s, retried)).json()).status).toBe('approved');
	const done = resultOf(board, retried);
	const { taskId: _t, ...approvingAgain } = done;
	writeFileSync(resultPath(board, retried), JSON.stringify({ ...approvingAgain, status: 'approving' }));
	chmodSync(proposalsDir(board), 0o500);
	expect((await card(board, cookie, retried)).status).toBe('approving');
	await linesOf(board, 'task_proposal_result_unsaved', 1);
	chmodSync(proposalsDir(board), 0o700);
	expect((await card(board, cookie, retried)).result).toMatchObject({ status: 'approved', taskId: `proposal-${retried}` });
	expect((await tasksOf(board, cookie)).map((task) => task.id)).toEqual([`proposal-${retried}`]);
	// Still the one push, from the damaged record alone.
	expect(failurePushes()).toHaveLength(1);
});

test('a proposal-made agent task runs from the approved brief, after the original changes and the proposal is cleared; a new brief path makes it a plain task', async () => {
	const s = await setup();
	const { board, agents } = s;
	const [luna] = agents;
	writeFileSync(join(luna.folder, 'brief.md'), '# 核准的說明\n');
	const id = await proposalOf(board, luna, agentTask(luna.folder));
	expect((await (await approveWith(s, id)).json()).status).toBe('approved');
	const [task] = await tasksOf(board, s.cookie);
	const copy = join(board.dir, 'board-state', 'automation', 'approved', `proposal-${id}.md`);
	expect(task.agent.brief).toBe(copy);
	expect(task.source.brief).toEqual({ path: copy, from: join(luna.folder, 'brief.md'), sha256: stored(board, id).brief.sha256 });
	writeFileSync(join(luna.folder, 'brief.md'), '# 改過的說明\n');

	// A run is told to read the copy.
	writeFileSync(
		join(board.dir, 'herdr.json'),
		JSON.stringify({ workspaces: [{ workspace_id: 'wA', number: 1, label: 'AUTOMATION' }], tabs: [], panes: [], agents: [] })
	);
	expect((await call(board, 'POST', `/api/automation/${task.id}/run`, { cookie: s.cookie })).status).toBe(202);
	const launch = await until(() => (jsonLines(join(board.dir, 'hcom-calls.jsonl')) as { args: string[] }[]).find((entry) => entry.args[0] === 'codex'), 10_000, 'the run to launch its agent');
	expect(launch.args[launch.args.indexOf('--hcom-prompt') + 1]).toStartWith(`讀取並照做 ${copy}，`);
	expect(readFileSync(copy, 'utf8')).toBe('# 核准的說明\n');

	// The proposal is cleared 7 days on; the task keeps its copy. (The login is over by then too.)
	board.setClock(T0 + 8 * DAY);
	const cookie = await board.login('phone');
	expect((await call(board, 'GET', '/api/task-proposals', { cookie })).status).toBe(200);
	expect(existsSync(join(proposalsDir(board), `${id}.json`))).toBe(false);
	expect(readFileSync(copy, 'utf8')).toBe('# 核准的說明\n');
	expect((await tasksOf(board, cookie))[0].agent.brief).toBe(copy);
	// A run after the clean-up still reads the copy. (The first one is past its limit by now, or stopped here.)
	await call(board, 'POST', `/api/automation/${task.id}/stop`, { cookie });
	for (let tries = 0; (await (await call(board, 'GET', '/api/automation', { cookie })).json()).tasks[0].runs[0].status === 'running'; tries++) {
		expect(tries).toBeLessThan(100);
		await Bun.sleep(100);
	}
	expect((await call(board, 'POST', `/api/automation/${task.id}/run`, { cookie })).status).toBe(202);
	const launches = await until(() => {
		const all = (jsonLines(join(board.dir, 'hcom-calls.jsonl')) as { args: string[] }[]).filter((entry) => entry.args[0] === 'codex');
		return all.length === 2 && all;
	}, 10_000, 'the second run to launch its agent');
	expect(launches[1].args[launches[1].args.indexOf('--hcom-prompt') + 1]).toStartWith(`讀取並照做 ${copy}，`);

	// Edited to the agent's own brief again: an ordinary agent task, its source kept.
	const { id: _id, paused: _p, createdAt: _c, updatedAt: _u, source: _s, ...settings } = task;
	const edited = await call(board, 'PUT', `/api/automation/${task.id}`, { cookie, body: { ...settings, agent: { ...settings.agent, brief: 'brief.md' } } });
	expect(edited.status).toBe(200);
	const [after] = await tasksOf(board, cookie);
	expect(after.agent.brief).toBe('brief.md');
	expect(after.source).toMatchObject({ proposalId: id });
	expect(after.source.brief).toBeUndefined();
	expect(existsSync(copy)).toBe(false);
});

test('each result message goes once, to the proposer found by its session: a rename still reaches it; gone, another session or two with it send nothing; a failed send leaves the result', async () => {
	const s = await setup();
	const { board, cookie, agents } = s;
	const [luna] = agents;
	const ids: string[] = [];
	for (let n = 0; n < 6; n++) ids.push(await proposalOf(board, luna, commandTask(luna.folder, { name: `任務 ${n}` })));
	const rejectWith = async (id: string, agents: object[], extra: object = {}) => {
		board.setHcom({ agents, ...extra });
		expect((await reject(board, cookie, id)).status).toBe(200);
	};

	await rejectWith(ids[0], [listed(luna, { name: 'grp-luna2', base_name: 'luna2' })]);
	expect((await notified(board, ids[0])).to).toBe('grp-luna2');
	await rejectWith(ids[1], []);
	expect((await notified(board, ids[1], 'failed')).reason).toBe('提出這個提案的 Agent 已不在 hcom 的名單裡');
	await rejectWith(ids[2], [listed(luna, { session_id: 'session-of-another' })]);
	expect((await notified(board, ids[2], 'failed')).reason).toBe('grp-luna 現在是另一個 session，不是提出這個提案的 Agent');
	await rejectWith(ids[3], [listed(luna), listed(luna, { name: 'grp-twin', base_name: 'twin' })]);
	expect((await notified(board, ids[3], 'failed')).reason).toBe('hcom 的名單裡有 2 個 Agent 用同一個 session，認不出是哪一個');
	await rejectWith(ids[4], [listed(luna)], { send: { exit: 1, stderr: 'hcom is down' } });
	expect((await notified(board, ids[4], 'failed')).reason).toBe('hcom 傳送失敗：hcom is down');
	expect(resultOf(board, ids[4]).status).toBe('rejected');
	expect(sends(board).map((sent) => sent.args[1])).toEqual(['@grp-luna2', '@grp-luna']);
	expect((await linesOf(board, 'task_proposal_notify_skipped', 3)).map((line) => line.proposal_id)).toEqual([ids[1], ids[2], ids[3]]);

	// An invalid proposal is told at once; a withdrawal never.
	board.setHcom({ agents: [listed(luna)] });
	const invalid = parsed(await submit(board, luna, commandTask(luna.folder, { time: '25:00' })));
	expect(invalid.status).toBe('invalid');
	expect((await notified(board, invalid.id)).status).toBe('sent');
	expect(sends(board).at(-1)!.text).toBe(`任務提案 ${invalid.id}：無效\n有問題的欄位：time\n查詢結果：task-proposal.py status ${invalid.id}`);
	expect((await asAgent(board, luna, ['withdraw', ids[5]])).code).toBe(0);
	await Bun.sleep(300);
	expect(notifyOf(board, ids[5])).toBeNull();
	expect(sends(board)).toHaveLength(3);
});

test('a board stopped while it sends a result message, before or after the send, never sends it again and records 通知結果不明', async () => {
	const s = await setup();
	const { board, cookie, agents } = s;
	const [luna] = agents;
	const before = await proposalOf(board, luna, commandTask(luna.folder));
	const after = await proposalOf(board, luna, commandTask(luna.folder, { name: '第二個' }));

	// Before: stopped while the recipient is looked up.
	board.setHcom({ agents: [listed(luna)], listDelayMs: 3_000 });
	expect((await reject(board, cookie, before)).status).toBe(200);
	expect(notifyOf(board, before)).toMatchObject({ attempt: 1, status: 'sending' });
	await board.stop();
	// After: the message has gone out, and the board stops before it records so.
	board.setHcom({ agents: [listed(luna)], send: { sleepMs: 3_000 } });
	await board.start();
	expect(notifyOf(board, before)).toMatchObject({ status: 'unknown', reason: '看板在傳送通知時重新啟動，不確定有沒有送到' });
	expect((await reject(board, cookie, after)).status).toBe(200);
	await until(() => sends(board).length === 1, 10_000, 'the message to go out');
	await board.stop();
	await board.start();
	expect(notifyOf(board, after)).toMatchObject({ status: 'unknown' });
	expect((await linesOf(board, 'task_proposal_notify_unknown', 2)).map((line) => line.proposal_id)).toEqual([before, after]);
	await Bun.sleep(3_500);
	expect(sends(board)).toHaveLength(1);
	expect(resultOf(board, before).status).toBe('rejected');
	expect((await card(board, cookie, after)).notify.status).toBe('unknown');
});

test('the new routes give a device not logged in, or no longer, the generic answer only; malformed ones get the generic 400', async () => {
	const s = await setup();
	const { board, cookie, agents } = s;
	const [luna] = agents;
	const id = await proposalOf(board, luna, commandTask(luna.folder));
	const other = await loggedIn(board, 'laptop');
	expect((await board.cli('revoke', other.deviceId)).code).toBe(0);
	// A login past its idle time, as the board's clock has it.
	const idle = await loggedIn(board, 'tablet');
	board.setClock(T0 + 8 * DAY);
	const cookieNow = await board.login('phone');
	for (const path of ['challenge', 'approve', 'reject']) {
		for (const who of [undefined, other.cookie, idle.cookie, 'lat_board_device=not-a-token']) {
			const response = await call(board, 'POST', `/api/task-proposals/${id}/${path}`, { cookie: who, body: { contentHash: 'a'.repeat(64), reason: 'x' } });
			expect([response.status, await response.text()]).toEqual([401, JSON.stringify({ error: 'unpaired' })]);
		}
		const badId = await call(board, 'POST', `/api/task-proposals/NOT-AN-ID/${path}`, { cookie: cookieNow, body: {} });
		expect([badId.status, await badId.json()]).toEqual([400, { error: 'bad-request' }]);
		const notJson = await call(board, 'POST', `/api/task-proposals/${id}/${path}`, { cookie: cookieNow, raw: '{' });
		expect([notJson.status, await notJson.json()]).toEqual([400, { error: 'bad-request' }]);
	}
	// Eight days on it has expired, and nothing above ended it otherwise.
	expect((await card(board, cookieNow, id)).status).toBe('expired');
});
