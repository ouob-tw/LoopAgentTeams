// Board asks after the hook stopped waiting, on the built board: an answer to a timed-out ask goes
// to its agent as a message through the usual relay, once, and only while Herdr's list has the
// agent; an ask whose hook was ended in the terminal takes no answer; ended asks go after 7 days.
// Herdr, hcom and the input command are fakes; nothing real is typed into.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { AgentAction } from '../../src/lib/board/agent-actions.ts';
import { ASK_TAKEN_REASON } from '../../src/lib/board/board-asks.ts';
import { DAY, NODE, startFixture, until, type Fixture } from '../harness.ts';

const HOOK = join(import.meta.dir, '../../hooks/board-ask.py');

const injectDir = mkdtempSync(join(tmpdir(), 'lat-board-inject-'));

let fixture: Fixture;
let cookie: string;
let asksDir: string;

const QUESTION = { question: 'Pick a color?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'Choose red.' }, { label: 'Blue', description: 'Choose blue.' }] };

/** An ask as the hook writes it, by the agent of session `s-ask`, `ageMs` old. */
function putAsk(id: string, { ageMs = 0, hookPid = process.pid }: { ageMs?: number; hookPid?: number } = {}) {
	const created = Date.now() - ageMs;
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
			tool_input: { questions: [QUESTION] },
			created_at: new Date(created).toISOString(),
			deadline_at: new Date(created + 10 * 60_000).toISOString(),
			hook_pid: hookPid,
			outcome: null,
			outcome_at: null
		}),
		{ mode: 0o600 }
	);
}
/** The hook's mark at its deadline, as it writes it. */
function timeOut(id: string, at = new Date()) {
	writeFileSync(join(asksDir, `${id}.result.json`), JSON.stringify({ kind: 'timeout', at: at.toISOString() }));
	const file = join(asksDir, `${id}.json`);
	writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), outcome: 'timed_out', outcome_at: at.toISOString() }));
}

function setHerdr(listed: boolean, extra: object = {}) {
	const agents = listed
		? [{ agent: 'claude', agent_session: { kind: 'id', value: 's-ask' }, agent_status: 'idle', cwd: '/work', pane_id: 'wA:p-s-ask', tab_id: 'wA:t-s-ask', workspace_id: 'wA' }]
		: [];
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({ agents, workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }], tabs: listed ? [{ tab_id: 'wA:t-s-ask', workspace_id: 'wA', label: 'asker' }] : [], ...extra })
	);
}

const lines = (file: string): string[][] => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
/** The Herdr commands that act on something, not the lists every read makes. */
const herdrCalls = () => lines(join(fixture.dir, 'herdr-calls.jsonl'));
const injectCalls = () => lines(join(injectDir, 'inject-calls.jsonl'));

async function answer(id: string, select: number[]) {
	const response = await fixture.fetch('/api/asks/answer', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ id, picks: [{ select, other: false, text: '' }] }),
		cookie
	});
	return { status: response.status, body: await response.json() };
}
const stateOf = async (id: string) => (await fixture.refresh(cookie)).asks.find((ask) => ask.id === id)?.state;
async function boardAskEntries(): Promise<AgentAction[]> {
	const log = await (await fixture.fetch('/api/agents/log?session=s-ask', { cookie })).json();
	return log.entries.filter((entry: AgentAction) => entry.action === 'board-ask');
}

beforeAll(async () => {
	fixture = await startFixture({
		env: {
			LAT_BOARD_INJECT_COMMAND: JSON.stringify([NODE, join(import.meta.dir, '../fake-inject.mjs'), injectDir]),
			LAT_BOARD_INJECT_TIMEOUT_SECONDS: '2',
			LAT_BOARD_HERDR_TIMEOUT_SECONDS: '2'
		}
	});
	cookie = await fixture.login();
	asksDir = join(fixture.dir, 'board-asks');
}, 30_000);
afterAll(async () => {
	await fixture?.cleanup();
	rmSync(injectDir, { recursive: true, force: true });
});
beforeEach(async () => {
	for (const file of ['herdr-calls.jsonl', 'hcom.json']) rmSync(join(fixture.dir, file), { force: true });
	rmSync(join(injectDir, 'inject-calls.jsonl'), { force: true });
	rmSync(join(fixture.dir, 'board-state', 'sent-log.jsonl'), { force: true });
	for (const name of readdirSync(asksDir)) if (name !== 'heartbeat') rmSync(join(asksDir, name));
	setHerdr(true);
	await fixture.refresh(cookie);
});

test('an answer after the deadline goes as a message that starts with the question, once', async () => {
	putAsk('late');
	timeOut('late');
	expect(await stateOf('late')).toBe('timed_out');

	expect(await answer('late', [2])).toMatchObject({ status: 200, body: { status: 'accepted' } });
	const [call] = herdrCalls();
	expect(call.slice(0, 3)).toEqual(['agent', 'prompt', 'wA:p-s-ask']);
	const message = call[3];
	expect(message).toContain('逾時');
	expect(message.indexOf('Pick a color?')).toBeLessThan(message.indexOf('Blue'));
	expect(message.indexOf('Pick a color?')).toBeGreaterThan(-1);

	const snapshot = await fixture.refresh(cookie);
	expect(snapshot.asks.find((ask) => ask.id === 'late')).toMatchObject({ state: 'relayed', answers: { 'Pick a color?': 'Blue' } });
	expect(await boardAskEntries()).toMatchObject([{ ok: true, route: 'herdr', text: message, name: 'asker' }]);

	expect(await answer('late', [1])).toMatchObject({ status: 409, body: { status: 'taken', reason: '已有人作答' } });
	expect(herdrCalls()).toHaveLength(1);
});

test('two answers after the deadline at once: one message, the other is told someone answered', async () => {
	putAsk('late-race');
	timeOut('late-race');
	await fixture.refresh(cookie);
	const results = await Promise.all([answer('late-race', [1]), answer('late-race', [2])]);
	expect(results.map((result) => result.body.status).toSorted()).toEqual(['accepted', 'taken']);
	expect(results.find((result) => result.body.status === 'taken')!.body.reason).toBe('已有人作答');
	expect(herdrCalls().filter((call) => call[1] === 'prompt')).toHaveLength(1);
	expect(await stateOf('late-race')).toBe('relayed');
});

test('an agent Herdr no longer lists gets nothing, even while hcom still lists it', async () => {
	putAsk('late-gone');
	timeOut('late-gone');
	setHerdr(false);
	fixture.setHcom({ agents: [{ name: 'asker', session_id: 's-ask', status: 'listening' }] });
	const result = await answer('late-gone', [1]);
	expect(result).toMatchObject({ status: 409, body: { status: 'agent_gone' } });
	expect(result.body.reason).toContain('不在 Herdr 的清單上');
	expect([herdrCalls(), injectCalls()]).toEqual([[], []]);
	expect(await stateOf('late-gone')).toBe('gone');
	expect((await answer('late-gone', [2])).status).toBe(409);
	expect([herdrCalls(), injectCalls()]).toEqual([[], []]);
});

test('a Herdr list that cannot be read sends nothing and keeps the ask open; once it can, the answer goes', async () => {
	putAsk('late-unread');
	timeOut('late-unread');
	setHerdr(true, { fail: { 'agent list': { exit: 1, stderr: 'server not running' } } });
	const failed = await answer('late-unread', [1]);
	expect(failed.body.status).toBe('error');
	expect(failed.body.reason).toContain('無法確認這個 Agent 仍在 Herdr 的清單上');
	expect(herdrCalls()).toEqual([]);
	setHerdr(true);
	expect(await stateOf('late-unread')).toBe('timed_out');

	expect(await answer('late-unread', [1])).toMatchObject({ status: 200, body: { status: 'accepted' } });
	expect(herdrCalls().filter((call) => call[1] === 'prompt')).toHaveLength(1);
	expect(await stateOf('late-unread')).toBe('relayed');
	expect((await boardAskEntries()).map((entry) => entry.ok)).toEqual([true, false]);
});

test('an ask whose hook process was ended while it waited reads as interrupted and takes no answer', async () => {
	// The real hook, asking into the board's folder; its process is ended as Esc in the terminal does.
	const hook = Bun.spawn(['uv', 'run', '--no-project', 'python', HOOK, 'hook'], {
		stdin: new TextEncoder().encode(JSON.stringify({ session_id: 's-ask', cwd: '/work', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [QUESTION] } })),
		stdout: 'pipe',
		env: { PATH: Bun.env.PATH ?? '', HOME: Bun.env.HOME ?? '', LAT_BOARD_ASKS_DIR: asksDir, HERDR_PANE_ID: 'wA:p-s-ask', LAT_BOARD_ASK_WAIT_SECONDS: '60' }
	});
	const file = await until(() => readdirSync(asksDir).find((name) => /^[0-9a-f]{32}\.json$/.test(name)), 10_000, 'the hook to ask');
	const id = file.slice(0, -'.json'.length);
	expect(await stateOf(id)).toBe('waiting');
	process.kill(JSON.parse(readFileSync(join(asksDir, `${id}.json`), 'utf8')).hook_pid, 'SIGKILL');
	await hook.exited;
	expect(await stateOf(id)).toBe('interrupted');
	expect(JSON.parse(readFileSync(join(asksDir, `${id}.result.json`), 'utf8')).kind).toBe('interrupted');
	expect((await answer(id, [1])).status).toBe(409);
	expect([herdrCalls(), injectCalls()]).toEqual([[], []]);
	// Recorded once, the later reads leaving it as it is.
	await fixture.refresh(cookie);
	expect((await boardAskEntries()).map((entry) => [entry.ok, entry.error, entry.text, entry.name])).toEqual([
		[false, ASK_TAKEN_REASON, 'Pick a color? → Red', 'asker'],
		[false, '已在終端機中斷，沒有作答', 'Pick a color?', 'asker']
	]);
});

test('an answer a board took and stopped before sending can be sent again after a restart', async () => {
	putAsk('late-orphan');
	timeOut('late-orphan');
	writeFileSync(join(asksDir, 'late-orphan.late.json'), JSON.stringify({ kind: 'answer', answers: { 'Pick a color?': 'Red' }, picks: null, at: new Date().toISOString() }));
	await fixture.stop();
	await fixture.start();
	expect(await stateOf('late-orphan')).toBe('timed_out');
	expect(await answer('late-orphan', [2])).toMatchObject({ status: 200, body: { status: 'accepted' } });
	const prompts = herdrCalls().filter((call) => call[1] === 'prompt');
	expect(prompts).toHaveLength(1);
	expect(prompts[0][3]).toContain('回答：Blue');
	expect(await stateOf('late-orphan')).toBe('relayed');
});

test('an ask that ended 7 days ago is removed with its files; a newer one, and one still open, stay', async () => {
	const ended = (id: string, ageMs: number) => {
		putAsk(id, { ageMs: ageMs + 60_000 });
		const at = new Date(Date.now() - ageMs).toISOString();
		writeFileSync(join(asksDir, `${id}.result.json`), JSON.stringify({ kind: 'interrupted', at }));
	};
	ended('old-interrupted', 7 * DAY + 60_000);
	ended('new-interrupted', 6 * DAY);
	putAsk('old-relayed', { ageMs: 8 * DAY });
	timeOut('old-relayed', new Date(Date.now() - 8 * DAY));
	writeFileSync(join(asksDir, 'old-relayed.late.json'), JSON.stringify({ kind: 'answer', answers: { 'Pick a color?': 'Red' }, picks: null, at: new Date(Date.now() - 8 * DAY).toISOString(), outcome: 'relayed', outcome_at: new Date(Date.now() - 8 * DAY).toISOString() }));
	// Timed out 8 days ago and never answered: not over, so kept.
	putAsk('old-open', { ageMs: 8 * DAY });
	timeOut('old-open', new Date(Date.now() - 8 * DAY));

	const snapshot = await fixture.refresh(cookie);
	expect(snapshot.asks.map((ask) => ask.id).toSorted()).toEqual(['new-interrupted', 'old-open']);
	expect(readdirSync(asksDir).filter((name) => name.startsWith('old-')).toSorted()).toEqual(['old-open.json', 'old-open.result.json']);
});
