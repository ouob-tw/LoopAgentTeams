// Closing a whole Herdr workspace from its heading on the Herdr tab. Herdr is a fake: `workspace
// close` takes the workspace and everything in it out of its lists; nothing real is closed.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFixture, type Fixture } from '../harness.ts';

let fixture: Fixture;
let cookie: string;

beforeAll(async () => {
	// The board runs in a plain terminal pane of workspace wA.
	fixture = await startFixture({ env: { HERDR_PANE_ID: 'wA:p-board', LAT_BOARD_HERDR_TIMEOUT_SECONDS: '2' } });
	cookie = await fixture.login();
});
afterAll(() => fixture.cleanup());
beforeEach(async () => {
	for (const file of ['herdr-calls.jsonl', 'herdr.json']) rmSync(join(fixture.dir, file), { force: true });
	rmSync(join(fixture.dir, 'board-state', 'sent-log.jsonl'), { force: true });
	setHerdr();
	await fixture.refresh(cookie);
});

const agent = (workspace: string, name: string) => ({
	agent: 'claude',
	agent_session: { kind: 'id', value: `s-${name}` },
	agent_status: 'idle',
	cwd: `/projects/${name}`,
	pane_id: `${workspace}:p-${name}`,
	tab_id: `${workspace}:t-${name}`,
	workspace_id: workspace
});
/** wA holds the board's own pane and one agent; wB two agents and a plain terminal tab. */
function setHerdr(extra: object = {}) {
	const agents = [agent('wA', 'alpha'), agent('wB', 'beta'), agent('wB', 'gamma')];
	const plain = [{ pane_id: 'wA:p-board', tab_id: 'wA:t-board', workspace_id: 'wA' }, { pane_id: 'wB:p-shell', tab_id: 'wB:t-shell', workspace_id: 'wB' }];
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents,
			panes: [...agents.map(({ pane_id, tab_id, workspace_id }) => ({ pane_id, tab_id, workspace_id })), ...plain],
			workspaces: [
				{ workspace_id: 'wA', number: 1, label: 'Alpha' },
				{ workspace_id: 'wB', number: 2, label: 'Beta' }
			],
			tabs: [...agents, ...plain].map(({ tab_id, workspace_id }) => ({ tab_id, workspace_id, label: tab_id.split(':t-')[1] })),
			...extra
		})
	);
}

const herdrCalls = (): string[][] => {
	const file = join(fixture.dir, 'herdr-calls.jsonl');
	return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((call: string[]) => call[1] === 'close') : [];
};
const workspaces = () => JSON.parse(readFileSync(join(fixture.dir, 'herdr.json'), 'utf8')).workspaces.map((workspace: { workspace_id: string }) => workspace.workspace_id);

async function check(workspace: string) {
	const response = await fixture.fetch(`/api/agents/workspace/close?workspace=${encodeURIComponent(workspace)}`, { cookie });
	return { status: response.status, body: await response.json() };
}
async function close(body: object, as = cookie) {
	const response = await fixture.fetch('/api/agents/workspace/close', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
		cookie: as
	});
	return { status: response.status, body: await response.json() };
}

test('a workspace is closed with everything in it once the user confirmed its agents and tabs, plain terminal tabs included', async () => {
	const contents = await check('wB');
	expect(contents).toEqual({ status: 200, body: { label: 'Beta', agents: 2, tabs: 3, own: false } });

	const closed = await close({ workspace: 'wB', agents: 2, tabs: 3 });
	expect(closed.status).toBe(200);
	expect(closed.body).toMatchObject({ ok: true, reason: null, entry: { action: 'close-workspace', route: 'herdr', text: '工作區「Beta」（2 個 Agent、3 個分頁）', ok: true } });
	expect(herdrCalls()).toEqual([['workspace', 'close', 'wB']]);
	expect(workspaces()).toEqual(['wA']);
	// The page's list no longer has its agents.
	const listed = await (await fixture.fetch('/api/agents', { cookie })).json();
	expect(listed.agents.map((candidate: { id: string }) => candidate.id)).toEqual(['s-alpha']);
});

test('the workspace the board runs in is not offered for closing, and is refused', async () => {
	expect(await check('wA')).toEqual({ status: 200, body: { label: 'Alpha', agents: 1, tabs: 2, own: true } });
	const refused = await close({ workspace: 'wA', agents: 1, tabs: 2 });
	expect(refused.status).toBe(409);
	expect(refused.body).toMatchObject({ ok: false, entry: { action: 'close-workspace', route: null, ok: false } });
	expect(refused.body.reason).toContain('看板自己所在的窗格就在這個工作區裡');
	expect(herdrCalls()).toEqual([]);
	expect(workspaces()).toEqual(['wA', 'wB']);
});

test('a workspace that now has other agents or tabs than the user confirmed is not closed', async () => {
	const refused = await close({ workspace: 'wB', agents: 1, tabs: 3 });
	expect(refused.status).toBe(409);
	expect(refused.body.reason).toBe('工作區裡現在有 2 個 Agent、3 個分頁，和確認時的 1 個 Agent、3 個分頁不同，沒有關閉；請重新確認。');
	expect(herdrCalls()).toEqual([]);
});

test('a workspace Herdr no longer lists, a list that cannot be read, or a close Herdr refuses, says why', async () => {
	expect((await check('wZ')).status).toBe(404);
	expect((await close({ workspace: 'wZ', agents: 0, tabs: 0 })).body.reason).toBe('工作區已不在 Herdr 的清單上，沒有關閉。');

	setHerdr({ fail: { 'pane list': { exit: 1, stderr: 'herdr socket gone' } } });
	const unread = await check('wB');
	expect(unread.status).toBe(502);
	expect(unread.body.reason).toContain('herdr socket gone');
	expect((await close({ workspace: 'wB', agents: 2, tabs: 3 })).body.reason).toContain('herdr socket gone');
	expect(herdrCalls()).toEqual([]);

	setHerdr({ fail: { 'workspace close': { exit: 1, stderr: JSON.stringify({ error: { code: 'internal', message: 'busy' } }) } } });
	const failed = await close({ workspace: 'wB', agents: 2, tabs: 3 });
	expect(failed.status).toBe(502);
	expect(failed.body).toMatchObject({ ok: false, reason: 'Herdr 沒有關閉工作區：busy', entry: { route: 'herdr' } });
});

test('requests that are not a workspace close are refused, and closing needs a logged-in device', async () => {
	expect((await close({ workspace: '', agents: 0, tabs: 0 })).status).toBe(400);
	expect((await close({ workspace: 'wB', agents: -1, tabs: 3 })).status).toBe(400);
	expect((await close({ workspace: 'wB' })).status).toBe(400);
	expect((await check('')).status).toBe(400);
	expect((await close({ workspace: 'wB', agents: 2, tabs: 3 }, '')).status).toBe(401);
	expect(herdrCalls()).toEqual([]);
});
