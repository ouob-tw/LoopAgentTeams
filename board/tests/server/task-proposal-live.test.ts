// What a logged-in page hears of the 任務提案 waiting (#761), on the built board: the list on the
// event stream when it connects and whenever it changes (a new proposal, a rejection), with the
// board's address the passkey works at; and one Web Push per new proposal to every subscribed device,
// through a fake push service on this host, saying only that one waits and who proposed it — never
// the task's name, command or folder.
import { afterAll, afterEach, expect, test } from 'bun:test';
import { until, type Fixture } from '../harness.ts';
import { decrypt, deviceKeys } from '../push-keys.ts';
import { commandTask, parsed, submit, withAgents, type AgentDouble } from '../task-proposal-fixture.ts';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

const BOARD = 'https://board.example.test';
const received: Buffer[] = [];
const service = Bun.serve({
	port: 0,
	hostname: '127.0.0.1',
	async fetch(request) {
		received.push(Buffer.from(await request.arrayBuffer()));
		return new Response(null, { status: 201 });
	}
});
const ORIGIN = `http://127.0.0.1:${service.port}`;

let fixture: Fixture | undefined;
afterEach(async () => {
	await fixture?.cleanup();
	fixture = undefined;
});
afterAll(() => service.stop(true));

test('a new proposal reaches open pages at once and pushes a set sentence with its proposer only; a decided one leaves the list without a push', async () => {
	const { board, agents } = await withAgents(
		[
			{ name: 'ctrl', client: 'claude' },
			{ name: 'luna', client: 'codex' }
		],
		{ env: { LAT_BOARD_PUSH_TEST_ORIGIN: ORIGIN, LAT_BOARD_URL: BOARD } },
		(started) => (fixture = started)
	);
	const [ctrl, luna] = agents;
	writeFileSync(
		join(ctrl.folder, '.lat/sessions', 'session-ctrl.json'),
		JSON.stringify({ client: 'claude', session_id: 'session-ctrl', role: 'orchestrator', workspace: ctrl.folder, hcom_name: 'ctrl', status: 'active' })
	);
	const cookie = await board.login('phone');
	const keys = deviceKeys();
	const subscribed = await board.fetch('/api/push/subscription', { method: 'PUT', cookie, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: `${ORIGIN}/push/phone`, keys: keys.json }) });
	expect(subscribed.status).toBe(200);
	const watch = board.watch(cookie);
	try {
		await until(() => watch.proposals.length > 0, 10_000, 'the list on connecting');
		expect(watch.proposals.at(-1)).toEqual({ proposals: [], origin: BOARD });

		const propose = async (agent: AgentDouble, name: string) => {
			const reply = parsed(await submit(board, agent, commandTask(agent.folder, { name, command: { command: 'rsync -a ~/secret-notes /mnt/backup', folder: agent.folder, checks: [] } })));
			expect(reply).toMatchObject({ ok: true, status: 'pending' });
			return reply.id as string;
		};
		const first = await propose(ctrl, '備份秘密筆記');
		await until(() => watch.proposals.at(-1)?.proposals.length === 1, 10_000, 'the first proposal on the stream');
		expect(watch.proposals.at(-1)!.proposals[0]).toMatchObject({ id: first, proposer: { name: 'grp-ctrl', role: 'controller' }, task: { name: '備份秘密筆記' } });
		const second = await propose(luna, '另一個備份');
		await until(() => watch.proposals.at(-1)?.proposals.length === 2, 10_000, 'the second proposal on the stream');

		await until(() => received.length >= 2, 10_000, 'a push for each proposal');
		const pushes = received.map((body) => decrypt(body, keys));
		expect(pushes).toEqual([
			{ title: '任務提案待核准', body: '有一筆新的任務提案等你核准\n已查證：grp-ctrl（Claude） · LAT 主控', alert: `task-proposal-${first}` },
			{ title: '任務提案待核准', body: '有一筆新的任務提案等你核准\n已查證：grp-luna（Codex）', alert: `task-proposal-${second}` }
		]);
		for (const text of ['備份', 'rsync', 'secret', ctrl.folder, luna.folder]) expect(JSON.stringify(pushes)).not.toContain(text);

		const rejected = await board.fetch(`/api/task-proposals/${first}/reject`, { method: 'POST', cookie, headers: { 'content-type': 'application/json' }, body: '{}' });
		expect(rejected.status).toBe(200);
		await until(() => watch.proposals.at(-1)?.proposals.length === 1, 10_000, 'the rejected proposal gone from the stream');
		expect(watch.proposals.at(-1)!.proposals.map((proposal) => proposal.id)).toEqual([second]);
		expect(received).toHaveLength(2);
	} finally {
		watch.close();
	}
});
