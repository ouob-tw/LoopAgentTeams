// Sending text to and interrupting an agent on the 所有 Agent tab, and the operation record its
// page shows. Herdr, hcom, the input command and the helper are fakes; nothing real is typed into.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAction, AgentActionResponse } from '../src/lib/board/agent-actions.ts';
import { NODE, startFixture, until, type Fixture } from './harness.ts';

// The fake input command's plan and call log, known before the fixture makes its own directory.
const injectDir = mkdtempSync(join(tmpdir(), 'lat-board-inject-'));

let fixture: Fixture;
let cookie: string;

beforeAll(async () => {
	fixture = await startFixture(34, {
		env: {
			LAT_BOARD_INJECT_COMMAND: JSON.stringify([NODE, join(import.meta.dir, 'fake-inject.mjs'), injectDir]),
			LAT_BOARD_INJECT_TIMEOUT_SECONDS: '2',
			LAT_BOARD_HERDR_TIMEOUT_SECONDS: '2'
		}
	});
	cookie = await fixture.login();
});
afterAll(async () => {
	await fixture.cleanup();
	rmSync(injectDir, { recursive: true, force: true });
});
beforeEach(async () => {
	for (const file of ['herdr-calls.jsonl', 'herdr.json', 'hcom.json']) rmSync(join(fixture.dir, file), { force: true });
	for (const file of ['inject-calls.jsonl', 'inject.json']) rmSync(join(injectDir, file), { force: true });
	rmSync(join(fixture.dir, 'board-state', 'sent-log.jsonl'), { force: true });
	fixture.list([]);
	setHerdr([herdrAgent('s-linked'), herdrAgent('s-plain', { client: 'codex' })]);
	fixture.setHcom({ agents: [{ name: 'lino', session_id: 's-linked', status: 'listening' }] });
	// Each test starts from lists the board has read, so every agent's pairing is known.
	await fixture.refresh(cookie);
});

function herdrAgent(session: string, fields: { client?: string; pane?: string } = {}) {
	return {
		agent: fields.client ?? 'claude',
		agent_session: { kind: 'id', value: session },
		agent_status: 'idle',
		cwd: `/projects/${session}`,
		pane_id: fields.pane ?? `wA:p-${session}`,
		tab_id: `wA:t-${session}`,
		workspace_id: 'wA'
	};
}
function setHerdr(agents: object[], extra: object = {}) {
	const tabs = agents.map((agent) => ({ tab_id: (agent as { tab_id: string }).tab_id, workspace_id: 'wA', label: 'tab' }));
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({ agents, workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }], tabs, ...extra })
	);
}

const lines = (file: string): string[][] =>
	existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
/** The Herdr commands that act on something, not the lists every read makes. */
const herdrCalls = () => lines(join(fixture.dir, 'herdr-calls.jsonl'));
const injectCalls = () => lines(join(injectDir, 'inject-calls.jsonl'));

async function post(path: string, body: object, as = cookie): Promise<{ status: number; body: AgentActionResponse }> {
	const response = await fixture.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cookie: as });
	return { status: response.status, body: await response.json() };
}
const send = (session: string, text: string, extra: object = {}) => post('/api/agents/send', { session, text, ...extra });
const interrupt = (session: string, extra: object = {}) => post('/api/agents/interrupt', { session, ...extra });
async function record(session: string): Promise<{ status: number; entries: AgentAction[] }> {
	const response = await fixture.fetch(`/api/agents/log?session=${encodeURIComponent(session)}`, { cookie });
	return { status: response.status, entries: response.ok ? (await response.json()).entries : [] };
}

test('text for an agent linked to hcom goes through the input command, for one that is not through Herdr', async () => {
	const linked = await send('s-linked', '看一下測試\r\n第二行');
	expect(linked.status).toBe(200);
	expect(linked.body).toMatchObject({ ok: true, reason: null, entry: { action: 'send', route: 'hcom', ok: true } });
	expect(injectCalls()).toEqual([['lino', '看一下測試\n第二行', '--enter']]);

	// Herdr takes its second argument as the text whatever it looks like, so it is passed as is.
	const plain = await send('s-plain', '--wait');
	expect(plain.status).toBe(200);
	expect(plain.body.entry).toMatchObject({ action: 'send', route: 'herdr', pane: 'wA:p-s-plain', text: '--wait', ok: true });
	expect(herdrCalls()).toEqual([['agent', 'prompt', 'wA:p-s-plain', '--wait']]);
	expect(injectCalls()).toHaveLength(1);
});

test('an interrupt sends Esc through Herdr to either kind of agent', async () => {
	expect((await interrupt('s-linked')).body).toMatchObject({ ok: true, entry: { action: 'interrupt', route: 'herdr', pane: 'wA:p-s-linked' } });
	expect((await interrupt('s-plain')).status).toBe(200);
	expect(herdrCalls()).toEqual([
		['agent', 'send-keys', 'wA:p-s-linked', 'esc'],
		['agent', 'send-keys', 'wA:p-s-plain', 'esc']
	]);
	expect(injectCalls()).toEqual([]);
});

test('Herdr refusing the text, as at a confirmation screen, is shown in its words and not tried again', async () => {
	const stderr = JSON.stringify({ error: { code: 'agent_blocked', message: 'agent is blocked on an approval prompt' }, id: 'cli:agent:prompt' });
	setHerdr([herdrAgent('s-linked'), herdrAgent('s-plain')], { fail: { 'agent prompt': { exit: 1, stderr } } });

	const refused = await send('s-plain', '繼續');
	expect(refused.status).toBe(502);
	expect(refused.body.ok).toBe(false);
	expect(refused.body.reason).toContain('agent is blocked on an approval prompt');
	expect(refused.body.reason).toContain('確認畫面');
	expect(herdrCalls()).toEqual([['agent', 'prompt', 'wA:p-s-plain', '繼續']]);

	// An interrupt that fails says why too.
	setHerdr([herdrAgent('s-plain')], { fail: { 'agent send-keys': { exit: 1, stderr: JSON.stringify({ error: { code: 'x', message: 'pane went away' } }) } } });
	const failed = await interrupt('s-plain');
	expect(failed.status).toBe(502);
	expect(failed.body.reason).toContain('pane went away');

	const { entries } = await record('s-plain');
	expect(entries.map((entry) => [entry.action, entry.ok])).toEqual([
		['interrupt', false],
		['send', false]
	]);
	expect(entries[1]).toMatchObject({ text: '繼續', error: refused.body.reason });
});

test('the server asks Herdr and hcom again for every request and ignores what the page claims', async () => {
	// Moved to another pane, and no longer linked, since the page last looked.
	setHerdr([herdrAgent('s-linked', { pane: 'wA:p-moved' })]);
	fixture.setHcom({ agents: [] });

	const sent = await send('s-linked', 'hi', { pane: 'wA:p-s-linked', hcomName: 'lino', hcom: 'linked' });
	expect(sent.body.entry).toMatchObject({ route: 'herdr', pane: 'wA:p-moved' });
	await interrupt('s-linked', { pane: 'wA:p-s-linked' });
	expect(herdrCalls()).toEqual([
		['agent', 'prompt', 'wA:p-moved', 'hi'],
		['agent', 'send-keys', 'wA:p-moved', 'esc']
	]);
	expect(injectCalls()).toEqual([]);
});

test('an agent Herdr no longer lists, or a Herdr list that cannot be read, refuses both and runs nothing', async () => {
	setHerdr([herdrAgent('s-linked')]);
	const gone = await send('s-plain', 'hi');
	expect(gone.status).toBe(409);
	expect(gone.body.reason).toContain('不在 Herdr 的清單上');
	expect((await interrupt('s-plain')).status).toBe(409);
	// Its record is not offered once it is gone.
	expect((await record('s-plain')).status).toBe(404);

	setHerdr([herdrAgent('s-linked')], { fail: { 'agent list': { exit: 1, stderr: 'server not running' } } });
	const unread = await interrupt('s-linked');
	expect(unread.status).toBe(409);
	expect(unread.body.reason).toContain('server not running');
	expect((await send('s-linked', 'hi')).status).toBe(409);
	expect(herdrCalls()).toEqual([]);
	expect(injectCalls()).toEqual([]);
});

test('while hcom cannot tell whether an agent is linked, text is refused but an interrupt still goes', async () => {
	// It appears while hcom's list cannot be read.
	fixture.setHcom({ listFail: { exit: 1, stderr: 'hcom down' } });
	setHerdr([herdrAgent('s-linked'), herdrAgent('s-plain'), herdrAgent('s-new')]);

	const refused = await send('s-new', 'hi');
	expect(refused.status).toBe(409);
	expect(refused.body.reason).toContain('HCOM 連線無法確認');
	expect((await interrupt('s-new')).status).toBe(200);
	// The pairings read before the outage still stand.
	expect((await send('s-plain', 'hi')).body.entry.route).toBe('herdr');
	expect(herdrCalls()).toEqual([
		['agent', 'send-keys', 'wA:p-s-new', 'esc'],
		['agent', 'prompt', 'wA:p-s-plain', 'hi']
	]);

	// hcom's list is read again: it is known not to be linked, and text goes.
	fixture.setHcom({ agents: [] });
	expect((await send('s-new', 'hi')).body).toMatchObject({ ok: true, entry: { route: 'herdr' } });
});

test('the sends and interrupts of one agent run one after another', async () => {
	writeFileSync(join(injectDir, 'inject.json'), JSON.stringify({ lino: { sleepMs: 700 } }));
	let sendDone = 0;
	const sending = send('s-linked', 'slow').then((result) => ((sendDone = Date.now()), result));
	await Bun.sleep(100);
	const interrupted = await interrupt('s-linked');
	const interruptDone = Date.now();
	expect(interrupted.status).toBe(200);
	expect((await sending).status).toBe(200);
	expect(sendDone).toBeGreaterThan(0);
	expect(sendDone).toBeLessThanOrEqual(interruptDone);
});

test('every send and interrupt is in the agent\'s record, newest first, on every device', async () => {
	await send('s-plain', '第一則');
	await interrupt('s-plain');
	await send('s-linked', '別的 Agent');
	const { status, entries } = await record('s-plain');
	expect(status).toBe(200);
	expect(entries.map((entry) => [entry.action, entry.text, entry.ok])).toEqual([
		['interrupt', null, true],
		['send', '第一則', true]
	]);
	expect(entries[0]).toMatchObject({ kind: 'agent-action', agentId: 's-plain', route: 'herdr' });
	// A controller's sent log is not mixed with it.
	const controllerLog = await fixture.fetch('/api/messages?controller=s-plain', { cookie });
	expect((await controllerLog.json()).entries).toEqual([]);
});

test('requests that are not a send or an interrupt are refused before anything runs', async () => {
	expect((await send('s-plain', '  \n')).status).toBe(400);
	expect((await post('/api/agents/send', { session: '', text: 'hi' })).status).toBe(400);
	expect((await post('/api/agents/interrupt', { session: 3 })).status).toBe(400);
	expect((await fixture.fetch('/api/agents/log', { cookie })).status).toBe(400);
	expect(herdrCalls()).toEqual([]);
});

test('sending, interrupting and the record need a logged-in device', async () => {
	expect((await post('/api/agents/send', { session: 's-plain', text: 'hi' }, '')).status).toBe(401);
	expect((await post('/api/agents/interrupt', { session: 's-plain' }, '')).status).toBe(401);
	expect((await fixture.fetch('/api/agents/log?session=s-plain')).status).toBe(401);
	expect(herdrCalls()).toEqual([]);
});

test('every action is announced to open pages, though the list of agents does not change', async () => {
	const watch = fixture.watch(cookie);
	await until(() => watch.snapshots.length > 0, 5_000, 'the first snapshot');
	const before = watch.snapshots.length;
	await interrupt('s-plain');
	await send('s-new', 'gone');
	await until(() => watch.agentActions.length >= 2, 5_000, 'the announcements');
	expect(watch.agentActions).toEqual(['s-plain', 's-new']);
	// Nothing the snapshot shows changed, so no new snapshot carried it.
	expect(watch.snapshots.length).toBe(before);
	watch.close();
});
