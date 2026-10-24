// Board asks on the built board: asks put in the shared folder as the hook writes them show in the
// snapshot and on their agent's status, an answer is taken once and written as the result the hook
// reads, every attempt goes in the agent's operation record, and a restart keeps what waits.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BoardSnapshot } from '../../src/lib/board/types.ts';
import { startFixture, until, type Fixture } from '../harness.ts';

let fixture: Fixture;
let cookie: string;
let asksDir: string;

const QUESTIONS = [
	{ question: 'Pick a color?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'Choose red.' }, { label: 'Blue', description: 'Choose blue.' }] },
	{ question: 'Pick fruits?', header: 'Fruit', multiSelect: true, options: [{ label: 'Apple', description: 'a' }, { label: 'Cherry', description: 'c' }] }
];

/** An ask as the hook writes it, by the agent of session `s-ask`. */
function putAsk(id: string, questions: object[] = QUESTIONS, deadlineMs = 10 * 60_000) {
	const now = Date.now();
	writeFileSync(
		join(asksDir, `${id}.json`),
		JSON.stringify({
			id,
			client: 'claude',
			session_id: 's-ask',
			hcom_name: null,
			herdr_pane: 'wA:p-s-ask',
			cwd: '/work',
			kind: 'question',
			tool_use_id: 'toolu_1',
			tool_input: { questions },
			created_at: new Date(now).toISOString(),
			deadline_at: new Date(now + deadlineMs).toISOString(),
			hook_pid: process.pid,
			outcome: null,
			outcome_at: null
		}),
		{ mode: 0o600 }
	);
}

const answer = (id: string, picks: object[]) =>
	fixture.fetch('/api/asks/answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, picks }), cookie });
const pick = (select: number[], text = '') => ({ select, other: text !== '', text });
const asking = (snapshot: BoardSnapshot) => snapshot.agents.find((agent) => agent.id === 's-ask')?.asking;

beforeAll(async () => {
	fixture = await startFixture();
	cookie = await fixture.login();
	asksDir = join(fixture.dir, 'board-asks');
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents: [{ agent: 'claude', agent_session: { kind: 'id', value: 's-ask' }, agent_status: 'blocked', cwd: '/work', pane_id: 'wA:p-s-ask', tab_id: 'wA:t-s-ask', workspace_id: 'wA' }],
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
			tabs: [{ tab_id: 'wA:t-s-ask', workspace_id: 'wA', label: 'asker' }]
		})
	);
	await fixture.refresh(cookie);
}, 30_000);
afterAll(async () => {
	await fixture?.cleanup();
});

test('the board keeps a heartbeat in the shared folder', () => {
	const beat = statSync(join(asksDir, 'heartbeat'));
	expect(Date.now() - beat.mtimeMs).toBeLessThan(60_000);
	expect(beat.mode & 0o777).toBe(0o600);
});

test('an ask in the folder shows at once, and its agent is waiting for an answer', async () => {
	const watch = fixture.watch(cookie);
	putAsk('ask-shown');
	const snapshot = await until(() => watch.snapshots.find((entry) => entry.asks.some((ask) => ask.id === 'ask-shown')), 5_000, 'the ask to be pushed');
	expect(snapshot.asks.find((ask) => ask.id === 'ask-shown')).toMatchObject({ sessionId: 's-ask', questions: QUESTIONS, state: 'waiting', answers: null });
	expect(asking(snapshot)).toBe(true);
	watch.close();
});

test('an answer is written as the result the hook reads, once; the next one is refused', async () => {
	putAsk('ask-answered');
	await fixture.refresh(cookie);
	// Not every question answered: refused, nothing written.
	const partial = await answer('ask-answered', [pick([2]), pick([])]);
	expect(partial.status).toBe(400);
	expect(existsSync(join(asksDir, 'ask-answered.result.json'))).toBe(false);

	const taken = await answer('ask-answered', [pick([2]), pick([1, 2], 'Mango')]);
	expect([taken.status, (await taken.json()).status]).toEqual([200, 'accepted']);
	const result = JSON.parse(readFileSync(join(asksDir, 'ask-answered.result.json'), 'utf8'));
	expect(result).toMatchObject({ kind: 'answer', answers: { 'Pick a color?': 'Blue', 'Pick fruits?': 'Apple, Cherry, Mango' } });
	expect(statSync(join(asksDir, 'ask-answered.result.json')).mode & 0o777).toBe(0o600);

	const again = await answer('ask-answered', [pick([1]), pick([1])]);
	expect([again.status, await again.json()]).toEqual([409, { status: 'taken', reason: '已有人作答', logError: null }]);
	expect(JSON.parse(readFileSync(join(asksDir, 'ask-answered.result.json'), 'utf8')).answers['Pick a color?']).toBe('Blue');

	const snapshot = await fixture.refresh(cookie);
	expect(snapshot.asks.find((ask) => ask.id === 'ask-answered')?.state).toBe('answered');
	const log = await (await fixture.fetch('/api/agents/log?session=s-ask', { cookie })).json();
	const entries = log.entries.filter((entry: { action: string }) => entry.action === 'board-ask');
	expect(entries.slice(0, 2)).toMatchObject([
		{ ok: false, error: '已有人作答', text: 'Pick a color? → Red\nPick fruits? → Apple' },
		{ ok: true, error: null, text: 'Pick a color? → Blue\nPick fruits? → Apple, Cherry, Mango', agentId: 's-ask', name: 'asker' }
	]);
});

test('an ask the hook handed back reads as filled, and one it gave up on as timed out', async () => {
	putAsk('ask-filled', [QUESTIONS[0]]);
	putAsk('ask-late', [QUESTIONS[0]]);
	await fixture.refresh(cookie);
	await answer('ask-filled', [pick([], 'A small turtle')]);
	const file = join(asksDir, 'ask-filled.json');
	writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), outcome: 'filled' }));
	writeFileSync(join(asksDir, 'ask-late.result.json'), JSON.stringify({ kind: 'timeout', at: new Date().toISOString() }));
	const snapshot = await fixture.refresh(cookie);
	const state = (id: string) => snapshot.asks.find((ask) => ask.id === id);
	expect(state('ask-filled')).toMatchObject({ state: 'filled', answers: { 'Pick a color?': 'A small turtle' } });
	expect(state('ask-late')?.state).toBe('timed_out');
	expect((await answer('ask-late', [pick([1])])).status).toBe(409);
});

test('after a restart a waiting ask is still there and can be answered', async () => {
	putAsk('ask-restart', [QUESTIONS[0]]);
	await fixture.stop();
	await fixture.start();
	const snapshot = await fixture.refresh(cookie);
	expect(snapshot.asks.find((ask) => ask.id === 'ask-restart')?.state).toBe('waiting');
	expect(asking(snapshot)).toBe(true);
	expect((await answer('ask-restart', [pick([1])])).status).toBe(200);
	expect(JSON.parse(readFileSync(join(asksDir, 'ask-restart.result.json'), 'utf8')).answers).toEqual({ 'Pick a color?': 'Red' });
});
