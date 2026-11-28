// 任務提案 as the built board takes them (#759): the agent's command sends over the board's local
// socket, the board's acceptor verifies the sender from the connection (the first claude/codex
// ancestor, its HCOM environment, hcom's list), the board checks the task as 新增任務 does, keeps
// the proposal in its folder and lists it through its logged-in API. Agents here are stand-in
// processes named `claude` or `codex` that run the command as their child; hcom is the fake one.
// Every folder, the socket and hcom are the fixture's own.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { DAY, logged, until, type Fixture } from '../harness.ts';
import { agentFolder, asAgent, commandTask, filesIn, listed, parsed, proposalsDir, stored, submit, agentTask, withAgents as startWithAgents, type AgentDouble } from '../task-proposal-fixture.ts';

let fixture: Fixture | undefined;
afterEach(async () => {
	await fixture?.cleanup();
	fixture = undefined;
});
const withAgents = (names: Parameters<typeof startWithAgents>[0], options?: Parameters<typeof startWithAgents>[1]) => startWithAgents(names, options, (board) => (fixture = board));

test('an agent submits a proposal: the board keeps its verified sender and the brief in full, and lists it to a logged-in device', async () => {
	const { board, agents } = await withAgents([{ name: 'luna', client: 'codex' }]);
	const [luna] = agents;
	writeFileSync(join(luna.folder, 'brief.md'), '# 每週整理\n\n把 needs-triage 的 issue 分類。\n');
	const result = await submit(board, luna, agentTask(luna.folder));
	expect(result.stderr).toBe('');
	const reply = parsed(result);
	expect(result.code).toBe(0);
	expect(reply).toMatchObject({ ok: true, status: 'pending' });
	expect(reply.id).toMatch(/^[a-f0-9]{12}$/);

	const file = stored(board, reply.id);
	expect(file.proposer).toMatchObject({ name: 'grp-luna', client: 'codex', role: 'agent', folder: luna.folder, processId: 'process-luna', sessionId: 'session-luna' });
	expect(Number.isInteger(file.proposer.pid) && Number.isInteger(file.proposer.startTime)).toBe(true);
	expect(Date.parse(file.expiresAt) - Date.parse(file.createdAt)).toBe(DAY);
	expect(file.brief).toMatchObject({ path: join(luna.folder, 'brief.md'), text: '# 每週整理\n\n把 needs-triage 的 issue 分類。\n' });
	expect(file.task).toMatchObject({ name: '每週整理 issue', kind: 'agent', agent: { client: 'codex', brief: 'brief.md' } });
	const mode = (path: string) => Bun.spawnSync(['stat', '-c', '%a', path]).stdout.toString().trim();
	expect(mode(proposalsDir(board))).toBe('700');
	expect(mode(join(proposalsDir(board), `${reply.id}.json`))).toBe('600');
	expect(mode(board.serverEnv().LAT_BOARD_PROPOSAL_SOCKET)).toBe('600');

	const cookie = await board.login();
	const list = await (await board.fetch('/api/task-proposals', { cookie })).json();
	expect(list.proposals).toHaveLength(1);
	expect(list.proposals[0]).toMatchObject({ id: reply.id, proposer: { name: 'grp-luna', role: 'agent' }, brief: { text: file.brief.text } });
	expect(list.proposals[0].contentHash).toBe(new Bun.CryptoHasher('sha256').update(readFileSync(join(proposalsDir(board), `${reply.id}.json`))).digest('hex'));
	const detail = await (await board.fetch(`/api/task-proposals/${reply.id}`, { cookie })).json();
	expect(detail).toMatchObject({ id: reply.id, status: 'pending', result: null });

	const status = await asAgent(board, luna, ['status', reply.id]);
	expect(status.stdout.trim()).toBe(`等待中：${reply.id}`);
	expect(logged(board.serverOutput(), 'task_proposal_received')).toMatchObject([{ proposal_id: reply.id, proposer: 'grp-luna', role: 'agent' }]);
});

test('two agents submitting at the same time each get their own verified name', async () => {
	const { board, agents } = await withAgents([
		{ name: 'luna', client: 'claude' },
		{ name: 'nova', client: 'codex' }
	]);
	const results = await Promise.all(agents.flatMap((agent) => [0, 1].map(() => submit(board, agent, commandTask(agent.folder)))));
	const replies = results.map(parsed);
	expect(replies.every((reply) => reply.ok && reply.status === 'pending')).toBe(true);
	const names = replies.map((reply) => stored(board, reply.id).proposer);
	expect(names.map((proposer) => [proposer.name, proposer.client])).toEqual([
		['grp-luna', 'claude'],
		['grp-luna', 'claude'],
		['grp-nova', 'codex'],
		['grp-nova', 'codex']
	]);
	expect(new Set(replies.map((reply) => reply.id)).size).toBe(4);
});

test('a sender outside an agent, with a name hcom does not list, or that ends while it is checked is refused and leaves nothing', async () => {
	const { board, agents } = await withAgents([{ name: 'luna', client: 'claude' }]);
	const [luna] = agents;

	const outside = await submit(board, null, commandTask(luna.folder), { HCOM_INSTANCE_NAME: 'luna', HCOM_TOOL: 'claude', HCOM_PROCESS_ID: 'process-luna' });
	expect(parsed(outside)).toMatchObject({ ok: false, error: 'refused', reason: '找不到送出它的 Claude 或 Codex 程序：請在 Agent 裡執行這個指令' });

	const impostor = await submit(board, { ...luna, name: 'mira' }, commandTask(luna.folder));
	expect(impostor.code).toBe(1);
	expect(parsed(impostor).reason).toBe('HCOM 名稱對不上：mira 和 hcom 名單裡的名稱不同');

	const unknown = await submit(board, { ...luna, processId: 'process-of-nobody' }, commandTask(luna.folder));
	expect(parsed(unknown).reason).toBe('HCOM 名稱對不上：hcom 的名單裡沒有 luna 這個程序');

	const wrongClient = await submit(board, luna, commandTask(luna.folder), { HCOM_TOOL: 'codex' });
	expect(parsed(wrongClient).reason).toBe('HCOM 記錄的 client（codex）和送出的程序（claude）不符');

	// The agent ends after the walk, while its name is looked up in hcom's list.
	const gate = join(board.dir, 'gate');
	const ending = submit(board, luna, commandTask(luna.folder), { PROPOSAL_GATE: gate });
	const pid = Number(await until(() => existsSync(`${gate}.pid`) && readFileSync(`${gate}.pid`, 'utf8').trim(), 5_000, 'the agent to start'));
	board.setHcom({ agents: [listed(luna)], acceptorListKill: pid });
	writeFileSync(gate, '');
	const ended = await ending;
	expect(JSON.parse(ended.stdout)).toMatchObject({ ok: false, error: 'refused', reason: '送出的程序在查證途中結束或被替換' });

	expect(filesIn(board)).toEqual([]);
	expect(logged(board.serverOutput(), 'task_proposal_refused')).toHaveLength(5);
	expect(logged(board.serverOutput(), 'task_proposal_received')).toHaveLength(0);
});

test('the role comes from LAT session records: LAT 主控 for an active match, 一般 Agent otherwise, 無法判斷 for a broken record, which is still accepted', async () => {
	const { board, agents } = await withAgents([
		{ name: 'ctrl', client: 'claude' },
		{ name: 'done', client: 'claude' },
		{ name: 'other', client: 'codex' },
		{ name: 'plain', client: 'codex' },
		{ name: 'broken', client: 'claude' }
	]);
	const record = (agent: AgentDouble, fields: Record<string, unknown>) =>
		writeFileSync(
			join(agent.folder, '.lat/sessions', `session-${agent.name}.json`),
			JSON.stringify({ client: agent.client, session_id: `session-${agent.name}`, role: 'orchestrator', workspace: agent.folder, hcom_name: agent.name, status: 'active', ...fields })
		);
	const [ctrl, done, other, plain, broken] = agents;
	record(ctrl, {});
	record(done, { status: 'ended' });
	record(other, { hcom_name: 'someone-else' });
	writeFileSync(join(broken.folder, '.lat/sessions', 'session-broken.json'), '{"status": "act');
	// A controller working in a subfolder of its git checkout: its record is at the checkout's top.
	const checkout = join(board.dir, 'checkout');
	mkdirSync(join(checkout, 'board'), { recursive: true });
	expect(Bun.spawnSync(['git', 'init', '-q', checkout]).exitCode).toBe(0);
	const sub: AgentDouble = { name: 'sub', client: 'claude', processId: 'process-sub', folder: join(checkout, 'board') };
	board.setHcom({ agents: [...agents, sub].map((agent) => listed(agent)) });
	mkdirSync(join(checkout, '.lat/sessions'), { recursive: true });
	writeFileSync(join(checkout, '.lat/sessions/session-sub.json'), JSON.stringify({ client: 'claude', session_id: 'session-sub', role: 'orchestrator', workspace: checkout, hcom_name: 'sub', status: 'active' }));
	const roles: Record<string, string> = {};
	for (const agent of [...agents, sub]) {
		const reply = parsed(await submit(board, agent, commandTask(agent.folder)));
		expect(reply).toMatchObject({ ok: true, status: 'pending' });
		roles[agent.name] = stored(board, reply.id).proposer.role;
	}
	expect(roles).toEqual({ ctrl: 'controller', done: 'agent', other: 'agent', plain: 'agent', broken: 'unknown', sub: 'controller' });
	void plain;
});

test('a proposal the 新增任務 checks refuse is 無效 with the field errors, and never waits', async () => {
	const { board, agents } = await withAgents([{ name: 'luna', client: 'codex' }]);
	const [luna] = agents;
	const result = await submit(board, luna, commandTask(join(luna.folder, 'missing'), { time: '25:00', limitMinutes: 0 }));
	expect(result.code).toBe(1);
	const reply = parsed(result);
	expect(reply).toMatchObject({ ok: true, status: 'invalid', errors: { time: '時間請寫成 00:00 到 23:59，例如 09:30', limitMinutes: '上限請填 1 到 1440 分鐘' } });
	expect(reply.errors.folder).toContain('找不到這個資料夾');
	const missingBrief = parsed(await submit(board, luna, agentTask(luna.folder)));
	expect(missingBrief).toMatchObject({ status: 'invalid', errors: { brief: '資料夾裡找不到這個檔案：brief.md' } });

	const text = await asAgent(board, luna, ['status', reply.id]);
	expect(text.stdout).toContain(`無效：${reply.id}\n- `);
	const cookie = await board.login();
	expect((await (await board.fetch('/api/task-proposals', { cookie })).json()).proposals).toEqual([]);
	expect(await (await board.fetch(`/api/task-proposals/${reply.id}`, { cookie })).json()).toMatchObject({ status: 'invalid', task: null, result: { status: 'invalid' } });
});

test('only the agent that sent a proposal can withdraw it, and only one result ever lands', async () => {
	const { board, agents } = await withAgents([
		{ name: 'luna', client: 'codex' },
		{ name: 'nova', client: 'codex' }
	]);
	const [luna, nova] = agents;
	const first = parsed(await submit(board, luna, commandTask(luna.folder))).id;
	const second = parsed(await submit(board, luna, commandTask(luna.folder))).id;

	const foreign = await asAgent(board, nova, ['--json', 'withdraw', first]);
	expect(foreign.code).toBe(1);
	expect(parsed(foreign)).toMatchObject({ ok: false, error: 'not-yours' });
	// A later agent that hcom gave the same name is not the one that sent it.
	board.setHcom({ agents: [listed(luna, { launch_context: { process_id: 'process-luna-later' } }), listed(nova)] });
	const namesake = await asAgent(board, { ...luna, processId: 'process-luna-later' }, ['--json', 'withdraw', first]);
	expect(parsed(namesake)).toMatchObject({ ok: false, error: 'not-yours' });
	board.setHcom({ agents: [listed(luna), listed(nova)] });
	expect(existsSync(join(proposalsDir(board), `${first}.result.json`))).toBe(false);

	// Two withdrawals at once: one takes the result, the other finds it taken.
	const both = await Promise.all([0, 1].map(() => asAgent(board, luna, ['--json', 'withdraw', first])));
	expect(both.map((result) => result.code).sort()).toEqual([0, 1]);
	expect(both.map(parsed).find((reply) => !reply.ok)).toMatchObject({ error: 'ended', status: 'withdrawn' });
	expect((await asAgent(board, luna, ['status', first])).stdout.trim()).toBe(`已撤回：${first}`);

	// Another result got there first (a rejection, linked the same way): the withdrawal loses.
	const rejected = { version: 1, id: second, status: 'rejected', at: new Date().toISOString() };
	writeFileSync(join(proposalsDir(board), `${second}.result.json`), JSON.stringify(rejected));
	const late = await asAgent(board, luna, ['withdraw', second]);
	expect(late.code).toBe(1);
	expect(late.stdout.trim()).toBe('這個提案已經有結果：已拒絕');
	expect(JSON.parse(readFileSync(join(proposalsDir(board), `${second}.result.json`), 'utf8'))).toEqual(rejected);

	const cookie = await board.login();
	expect((await (await board.fetch('/api/task-proposals', { cookie })).json()).proposals).toEqual([]);
});

test('an unanswered proposal expires after 24 hours, and an ended one goes with its result 7 days later', async () => {
	const start = Date.now();
	const { board, agents } = await withAgents([{ name: 'luna', client: 'codex' }], { clock: start });
	const [luna] = agents;
	const kept = parsed(await submit(board, luna, commandTask(luna.folder))).id;
	const withdrawn = parsed(await submit(board, luna, commandTask(luna.folder))).id;
	expect((await asAgent(board, luna, ['withdraw', withdrawn])).code).toBe(0);
	const cookie = await board.login();

	board.setClock(start + DAY - 60_000);
	expect((await (await board.fetch('/api/task-proposals', { cookie })).json()).proposals.map((proposal: { id: string }) => proposal.id)).toEqual([kept]);
	board.setClock(start + DAY);
	expect((await (await board.fetch('/api/task-proposals', { cookie })).json()).proposals).toEqual([]);
	expect((await asAgent(board, luna, ['status', kept])).stdout.trim()).toBe(`已過期：${kept}`);
	expect(logged(board.serverOutput(), 'task_proposal_expired')).toMatchObject([{ proposal_id: kept }]);
	// The expiry's message is sent behind the answers above: wait for its record.
	await until(() => logged(board.serverOutput(), 'task_proposal_notified').length === 1, 10_000, 'the expiry to be told');

	// The withdrawal ended at the start, the expiry a day later; the expiry's message record goes with it.
	board.setClock(start + 7 * DAY + 60_000);
	await board.fetch('/api/task-proposals', { cookie });
	expect(filesIn(board)).toEqual([`${kept}.json`, `${kept}.notify.json`, `${kept}.result.json`]);
	board.setClock(start + 8 * DAY);
	await board.fetch('/api/task-proposals', { cookie });
	expect(filesIn(board)).toEqual([]);
	expect((await asAgent(board, luna, ['status', kept])).stdout.trim()).toBe(`找不到這個提案：${kept}`);
});

test('with the board stopped, submit and withdraw say 看板沒在執行 and leave nothing; a dead acceptor is started again and logged', async () => {
	const { board, agents } = await withAgents([{ name: 'luna', client: 'codex' }]);
	const [luna] = agents;
	const id = parsed(await submit(board, luna, commandTask(luna.folder))).id;

	const acceptor = Number(logged(board.serverOutput(), 'proposal_acceptor_ready')[0].pid);
	process.kill(acceptor, 'SIGKILL');
	await until(() => logged(board.serverOutput(), 'proposal_acceptor_ready').length === 2, 15_000, 'the acceptor to be started again');
	expect(logged(board.serverOutput(), 'proposal_acceptor_exited')).toMatchObject([{ pid: acceptor, signal: 'SIGKILL' }]);
	expect(logged(board.serverOutput(), 'proposal_acceptor_restarted')).toHaveLength(1);
	expect(parsed(await submit(board, luna, commandTask(luna.folder)))).toMatchObject({ ok: true, status: 'pending' });

	await board.stop();
	const before = filesIn(board);
	const offline = await asAgent(board, luna, ['submit'], { input: JSON.stringify(commandTask(luna.folder)) });
	expect([offline.code, offline.stdout.trim()]).toEqual([3, '看板沒在執行']);
	const gone = await asAgent(board, luna, ['withdraw', id]);
	expect([gone.code, gone.stdout.trim()]).toEqual([3, '看板沒在執行']);
	expect(filesIn(board)).toEqual(before);
	// Query reads the files without the board.
	expect((await asAgent(board, luna, ['status', id])).stdout.trim()).toBe(`等待中：${id}`);

	// Started again, the board still has what it took in.
	await board.start();
	await until(() => logged(board.serverOutput(), 'proposal_acceptor_ready').length === 3, 10_000, 'the acceptor of the restarted board');
	const cookie = await board.login();
	expect((await (await board.fetch('/api/task-proposals', { cookie })).json()).proposals.map((proposal: { id: string }) => proposal.id)).toContain(id);
});

test('the list and detail APIs give a device not logged in, expired or revoked only the generic answer, and a malformed ID the generic 400', async () => {
	const start = Date.now();
	const { board, agents } = await withAgents([{ name: 'luna', client: 'codex' }], { clock: start });
	const [luna] = agents;
	const id = parsed(await submit(board, luna, commandTask(luna.folder, { command: { command: 'echo secret-command', folder: luna.folder, checks: [] } }))).id;
	const paths = ['/api/task-proposals', `/api/task-proposals/${id}`];
	const generic = async (cookie?: string) => {
		for (const path of paths) {
			const response = await board.fetch(path, cookie ? { cookie } : {});
			const body = await response.text();
			expect([response.status, body]).toEqual([401, '{"error":"unpaired"}']);
		}
	};
	await generic();
	await generic('lat_board_device=not-a-token');

	const revoked = await board.login('phone-browser');
	const listedDevices = (await board.cli('devices')).stdout.trim().split('\n').map((line) => line.split(/\s+/));
	const phone = listedDevices.find((row) => row.includes('phone-browser'))!;
	expect((await board.cli('revoke', phone[0])).code).toBe(0);
	await generic(revoked);

	const cookie = await board.login();
	for (const bad of ['NOT-AN-ID', 'abc', `${id}0`]) {
		const response = await board.fetch(`/api/task-proposals/${bad}`, { cookie });
		expect([response.status, await response.text()]).toEqual([400, '{"error":"bad-request"}']);
	}
	expect((await board.fetch('/api/task-proposals/0123456789ab', { cookie })).status).toBe(404);
	expect((await board.fetch('/api/task-proposals', { cookie })).status).toBe(200);

	// 31 days on, the login is over (and the proposal long expired): the generic answer again.
	board.setClock(start + 31 * DAY);
	await generic(cookie);
});
