// The 所有 Agent tab: every agent Herdr lists, paired with hcom's list, and each one's conversation.
// Herdr, hcom and the helper are the harness's fakes; nothing real is listed or read.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TranscriptUpdate } from '../src/lib/board/transcript.ts';
import type { Agent, BoardSnapshot } from '../src/lib/board/types.ts';
import { startFixture, until, type Fixture } from './harness.ts';

let fixture: Fixture;
let cookie: string;

beforeAll(async () => {
	fixture = await startFixture(31);
	cookie = await fixture.login();
});
afterAll(() => fixture.cleanup());
beforeEach(() => {
	for (const name of ['hcom.json', 'herdr.json']) rmSync(join(fixture.dir, name), { force: true });
	fixture.list([]);
});

/** One agent as `herdr agent list` prints it. */
function herdrAgent(session: string, fields: { client?: string; status?: string; cwd?: string; pane?: string; tab?: string; workspace?: string } = {}) {
	const workspace = fields.workspace ?? 'wA';
	return {
		agent: fields.client ?? 'claude',
		agent_session: { agent: fields.client ?? 'claude', kind: 'id', source: 'herdr:claude', value: session },
		agent_status: fields.status ?? 'idle',
		cwd: fields.cwd ?? `/projects/${session}`,
		focused: false,
		pane_id: fields.pane ?? `${workspace}:p-${session}`,
		tab_id: fields.tab ?? `${workspace}:t-${session}`,
		terminal_title_stripped: 'Claude Code',
		workspace_id: workspace
	};
}

const WORKSPACES = [
	{ workspace_id: 'wB', number: 2, label: 'Beta', focused: false },
	{ workspace_id: 'wA', number: 1, label: 'Alpha', focused: false }
];

function setHerdr(agents: object[], extra: object = {}) {
	const tabs = agents.map((agent) => {
		const { tab_id, workspace_id, agent_session } = agent as { tab_id: string; workspace_id: string; agent_session: { value: string } | null };
		return { tab_id, workspace_id, label: `tab-${agent_session?.value ?? tab_id}`, number: 1, pane_count: 1 };
	});
	writeFileSync(join(fixture.dir, 'herdr.json'), JSON.stringify({ agents, workspaces: WORKSPACES, tabs, ...extra }));
}

const hcomAgent = (name: string, session: string | null, fields: { status?: string; pane?: string } = {}) => ({
	name,
	session_id: session,
	status: fields.status ?? 'listening',
	launch_context: fields.pane ? { pane_id: fields.pane } : null
});

const agent = (snapshot: BoardSnapshot, id: string): Agent | undefined => snapshot.agents.find((entry) => entry.id === id);
const summary = (snapshot: BoardSnapshot) => snapshot.agents.map((entry) => [entry.id, entry.name, entry.hcom, entry.status, entry.statusSource]);

test('lists every Herdr agent across workspaces, named and stated by hcom when linked, by Herdr otherwise', async () => {
	const lead = fixture.bound('lat', 'lead', { session_id: 's-lead' });
	fixture.list([lead]);
	setHerdr([
		herdrAgent('s-beta', { workspace: 'wB', status: 'working', cwd: '/projects/beta', client: 'codex' }),
		herdrAgent('s-lead', { status: 'done' }),
		herdrAgent('s-pane', { status: 'idle', pane: 'wA:p9' }),
		herdrAgent('s-plain', { status: 'blocked' }),
		herdrAgent('s-done', { status: 'done' }),
		// Herdr does not know its session yet: listed, without a key.
		{ ...herdrAgent('s-none'), agent_session: null }
	]);
	fixture.setHcom({
		agents: [
			hcomAgent('lead', 's-lead', { status: 'active' }),
			// Linked through its pane: hcom has no session for it yet.
			hcomAgent('pano', null, { status: 'blocked', pane: 'wA:p9' }),
			// In hcom only, in tmux or a subagent: never listed.
			hcomAgent('tmux-only', 's-elsewhere')
		]
	});

	const snapshot = await fixture.refresh(cookie);

	expect(snapshot.errors).toEqual([]);
	// Alpha (workspace 1) first; within it who needs the user first: blocked, done, working, idle.
	expect(summary(snapshot)).toEqual([
		['s-pane', 'pano', 'linked', 'blocked', 'hcom'],
		['s-plain', 'tab-s-plain', 'none', 'blocked', 'herdr'],
		['s-done', 'tab-s-done', 'none', 'done', 'herdr'],
		['s-lead', 'lead', 'linked', 'working', 'hcom'],
		[null, 'tab-wA:t-s-none', 'none', 'idle', 'herdr'],
		['s-beta', 'tab-s-beta', 'none', 'working', 'herdr']
	]);
	expect(snapshot.agents.find((entry) => entry.id === null)).toMatchObject({ controller: false, herdr: { pane: 'wA:p-s-none' } });
	expect(agent(snapshot, 's-lead')).toMatchObject({ controller: true, hcomName: 'lead', client: 'claude' });
	expect(agent(snapshot, 's-plain')).toMatchObject({ controller: false, hcomName: null });
	expect(agent(snapshot, 's-beta')).toEqual({
		id: 's-beta',
		name: 'tab-s-beta',
		hcomName: null,
		hcom: 'none',
		client: 'codex',
		folder: '/projects/beta',
		herdr: { workspace: 'wB', workspaceLabel: 'Beta', workspaceNumber: 2, tab: 'wB:t-s-beta', pane: 'wB:p-s-beta' },
		status: 'working',
		statusSource: 'herdr',
		controller: false,
		inHerdr: true,
		switch: null
	});
	// The roster of controllers is untouched.
	expect(snapshot.controllers.map((controller) => controller.hcomName)).toEqual(['lead']);

	const listed = await fixture.fetch('/api/agents', { cookie });
	expect(listed.status).toBe(200);
	expect((await listed.json()).agents).toEqual(snapshot.agents);
});

test('an agent gone from Herdr\'s list leaves the tab; one that comes is added', async () => {
	setHerdr([herdrAgent('s-one'), herdrAgent('s-two')]);
	expect((await fixture.refresh(cookie)).agents.map((entry) => entry.id)).toEqual(['s-one', 's-two']);
	setHerdr([herdrAgent('s-two'), herdrAgent('s-three')]);
	expect((await fixture.refresh(cookie)).agents.map((entry) => entry.id)).toEqual(['s-three', 's-two']);
});

test('a Herdr list that cannot be read is reported and the last one stands in until one can', async () => {
	setHerdr([herdrAgent('s-kept')]);
	await fixture.refresh(cookie);

	setHerdr([herdrAgent('s-new')], { fail: { 'agent list': { exit: 1, stderr: 'herdr server not running' } } });
	let snapshot = await fixture.refresh(cookie);
	expect(snapshot.agents.map((entry) => entry.id)).toEqual(['s-kept']);
	expect(snapshot.errors).toEqual(['Herdr 的 Agent 清單讀不到：herdr server not running，所有 Agent 分頁沿用上次讀到的清單']);

	setHerdr([herdrAgent('s-new')], { raw: { 'tab list': 'not json' } });
	snapshot = await fixture.refresh(cookie);
	expect(snapshot.agents.map((entry) => entry.id)).toEqual(['s-kept']);
	expect(snapshot.errors).toEqual(['Herdr 的分頁清單讀不到：輸出不是預期的 JSON，所有 Agent 分頁沿用上次讀到的清單']);

	setHerdr([{ pane_id: 'wA:p1' }]);
	expect((await fixture.refresh(cookie)).errors).toEqual(['Herdr 的 Agent 清單不是預期的格式，所有 Agent 分頁沿用上次讀到的清單']);

	setHerdr([herdrAgent('s-new')]);
	snapshot = await fixture.refresh(cookie);
	expect(snapshot.errors).toEqual([]);
	expect(snapshot.agents.map((entry) => entry.id)).toEqual(['s-new']);
});

test('without any hcom list read since the start every agent\'s link is unknown; a list read later settles them', async () => {
	setHerdr([herdrAgent('s-linked', { status: 'done' }), herdrAgent('s-plain', { status: 'working' })]);
	fixture.setHcom({ listFail: { exit: 1, stderr: 'hcom broke' } });
	// A cold start: the restarted board has never read hcom's list.
	await fixture.stop();
	await fixture.start();
	cookie = await fixture.login();

	let snapshot = await fixture.board(cookie);
	expect(summary(snapshot)).toEqual([
		['s-linked', 'tab-s-linked', 'unknown', 'done', 'herdr'],
		['s-plain', 'tab-s-plain', 'unknown', 'working', 'herdr']
	]);

	fixture.setHcom({ agents: [hcomAgent('linko', 's-linked', { status: 'active' })] });
	snapshot = await fixture.refresh(cookie);
	expect(summary(snapshot)).toEqual([
		['s-linked', 'linko', 'linked', 'working', 'hcom'],
		['s-plain', 'tab-s-plain', 'none', 'working', 'herdr']
	]);
});

test('while hcom\'s list cannot be read the last pairing stands, and an agent that appears meanwhile is unknown until it can', async () => {
	setHerdr([herdrAgent('s-linked'), herdrAgent('s-plain')]);
	fixture.setHcom({ agents: [hcomAgent('linko', 's-linked', { status: 'active' })] });
	await fixture.refresh(cookie);

	fixture.setHcom({ listFail: { exit: 1, stderr: 'hcom broke' } });
	setHerdr([herdrAgent('s-linked'), herdrAgent('s-plain'), herdrAgent('s-late')]);
	let snapshot = await fixture.refresh(cookie);
	expect(summary(snapshot)).toEqual([
		['s-linked', 'linko', 'linked', 'working', 'hcom'],
		['s-late', 'tab-s-late', 'unknown', 'idle', 'herdr'],
		['s-plain', 'tab-s-plain', 'none', 'idle', 'herdr']
	]);

	fixture.setHcom({ agents: [hcomAgent('linko', 's-linked', { status: 'listening' }), hcomAgent('lato', 's-late')] });
	snapshot = await fixture.refresh(cookie);
	expect(summary(snapshot)).toEqual([
		['s-late', 'lato', 'linked', 'idle', 'hcom'],
		['s-linked', 'linko', 'linked', 'idle', 'hcom'],
		['s-plain', 'tab-s-plain', 'none', 'idle', 'herdr']
	]);
});

test('an outage keeps each agent\'s own pairing: a new session in a linked pane is unknown, a linked one that moved stays linked', async () => {
	setHerdr([herdrAgent('s-old', { pane: 'wA:p1' }), herdrAgent('s-moving', { pane: 'wA:p2' })]);
	fixture.setHcom({ agents: [hcomAgent('olda', 's-old', { pane: 'wA:p1' }), hcomAgent('movo', null, { status: 'active', pane: 'wA:p2' })] });
	expect(summary(await fixture.refresh(cookie))).toEqual([
		['s-moving', 'movo', 'linked', 'working', 'hcom'],
		['s-old', 'olda', 'linked', 'idle', 'hcom']
	]);

	fixture.setHcom({ listFail: { exit: 1, stderr: 'hcom broke' } });
	// s-old's pane now runs a new session, and s-moving runs in another pane.
	setHerdr([herdrAgent('s-new', { pane: 'wA:p1', status: 'working' }), herdrAgent('s-moving', { pane: 'wA:p7' })]);
	expect(summary(await fixture.refresh(cookie))).toEqual([
		['s-moving', 'movo', 'linked', 'working', 'hcom'],
		['s-new', 'tab-s-new', 'unknown', 'working', 'herdr']
	]);
});

test('a status change reaches open pages through the board\'s own reads', async () => {
	setHerdr([herdrAgent('s-busy', { status: 'working' })]);
	await fixture.refresh(cookie);
	const watch = fixture.watch(cookie);
	await until(() => watch.latest()?.agents.length, 5_000, 'the first snapshot');

	setHerdr([herdrAgent('s-busy', { status: 'done' })]);
	// Any read picks it up; a binding change is one the file watch sees.
	fixture.touchRegistry();
	await until(() => agent(watch.latest()!, 's-busy')?.status === 'done', 10_000, 'the status change');
	watch.close();
});

function record(session: string, texts: string[]): void {
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	const lines = texts.map((text, index) => ({ kind: index % 2 ? 'assistant' : 'user', time: '2026-10-19T09:00:00.000Z', text }));
	writeFileSync(join(fixture.dir, 'transcripts', `${session}.jsonl`), lines.map((line) => JSON.stringify(line) + '\n').join(''));
}

test('an agent\'s conversation is read by its client and session ID, a page at a time, live while open', async () => {
	setHerdr([herdrAgent('s-talk', { client: 'codex' })]);
	await fixture.refresh(cookie);
	record('s-talk', Array.from({ length: 60 }, (_, index) => `第 ${index} 段`));

	const latest = await fixture.fetch('/api/agents/transcript?session=s-talk', { cookie });
	const update: TranscriptUpdate = await latest.json();
	if (!update.ok) throw new Error(update.reason);
	expect(update.page.items.length).toBe(50);
	expect(update.page.before).not.toBeNull();
	expect(fixture.helperArgs('transcript').at(-1)).toEqual(['board', 'transcript', '--client=codex', '--session-id=s-talk']);

	const earlier: TranscriptUpdate = await (await fixture.fetch(`/api/agents/transcript?session=s-talk&before=${update.page.before}`, { cookie })).json();
	if (!earlier.ok) throw new Error(earlier.reason);
	expect(earlier.page.items.map((item) => (item as { text: string }).text)).toEqual(Array.from({ length: 10 }, (_, index) => `第 ${index} 段`));

	// The live feed: the latest page now, and again once the record grows.
	const abort = new AbortController();
	const response = await fixture.fetch('/api/agents/transcript/events?session=s-talk', { cookie, signal: abort.signal });
	expect(response.headers.get('content-type')).toBe('text/event-stream');
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let received = '';
	const next = async () => {
		while (!received.includes('\n\n')) received += decoder.decode((await reader.read()).value, { stream: true });
		const end = received.indexOf('\n\n');
		const block = received.slice(0, end);
		received = received.slice(end + 2);
		return block;
	};
	let block = await next();
	expect(block.startsWith('event: transcript')).toBe(true);
	record('s-talk', [...Array.from({ length: 60 }, (_, index) => `第 ${index} 段`), '新的一段']);
	do block = await next();
	while (!block.startsWith('event: transcript'));
	const pushed: TranscriptUpdate = JSON.parse(block.split('\ndata: ')[1]);
	if (!pushed.ok) throw new Error(pushed.reason);
	expect((pushed.page.items.at(-1) as { text: string }).text).toBe('新的一段');
	abort.abort();
});

test('a conversation that cannot be read says why; a session the tab does not list is not read', async () => {
	setHerdr([herdrAgent('s-missing')]);
	await fixture.refresh(cookie);
	rmSync(join(fixture.dir, 'transcripts', 's-missing.jsonl'), { force: true });

	const update: TranscriptUpdate = await (await fixture.fetch('/api/agents/transcript?session=s-missing', { cookie })).json();
	expect(update.ok).toBe(false);
	if (!update.ok) expect(update.reason).toBeTruthy();

	const calls = fixture.helperArgs('transcript').length;
	expect((await fixture.fetch('/api/agents/transcript?session=s-other', { cookie })).status).toBe(404);
	expect((await fixture.fetch('/api/agents/transcript/events?session=s-other', { cookie })).status).toBe(404);
	expect((await fixture.fetch('/api/agents/transcript', { cookie })).status).toBe(400);
	expect((await fixture.fetch('/api/agents/transcript?session=s-missing&before=x', { cookie })).status).toBe(400);
	expect(fixture.helperArgs('transcript').length).toBe(calls);
});

test('every agent endpoint needs a logged-in device', async () => {
	setHerdr([herdrAgent('s-private')]);
	await fixture.refresh(cookie);
	for (const path of ['/api/agents', '/api/agents/transcript?session=s-private', '/api/agents/transcript/events?session=s-private']) {
		const response = await fixture.fetch(path);
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'unpaired' });
	}
});

test('with no file change at all, the fallback read brings a status change to open pages', async () => {
	const quiet = await startFixture(36, {
		env: { LAT_BOARD_FALLBACK_SECONDS: '6', LAT_BOARD_HELPER_TIMEOUT_SECONDS: '2', LAT_BOARD_HCOM_LIST_TIMEOUT_SECONDS: '2', LAT_BOARD_HERDR_TIMEOUT_SECONDS: '2' }
	});
	try {
		const device = await quiet.login();
		const write = (status: string) =>
			writeFileSync(join(quiet.dir, 'herdr.json'), JSON.stringify({ agents: [herdrAgent('s-slow', { status })], workspaces: WORKSPACES, tabs: [] }));
		write('working');
		await quiet.refresh(device);
		const watch = quiet.watch(device);
		await until(() => watch.latest()?.agents[0]?.status === 'working', 5_000, 'the first snapshot');
		write('done');
		await until(() => watch.latest()?.agents[0]?.status === 'done', 8_000, 'the fallback read');
		watch.close();
	} finally {
		await quiet.cleanup();
	}
}, 20_000);
