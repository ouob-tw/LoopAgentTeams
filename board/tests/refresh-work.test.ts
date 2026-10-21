// The board reads only new stop history and gets its complete Herdr roster without CLI lists.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFixture, type Fixture } from './harness.ts';
let fixture: Fixture;
let cookie: string;
const now = Date.parse('2026-10-21T12:00:00Z');
const lines = (name: string): any[] => {
	const file = join(fixture.dir, name);
	return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
};
beforeAll(async () => { fixture = await startFixture(90); cookie = await fixture.login(); });
afterAll(async () => { await fixture?.cleanup(); });
test('second stop read overlaps the last event by one second; failures keep the successful cursor', async () => {
	await fixture.stop();
	await fixture.start();
	fixture.setClock(now);
	const event = { id: 214, instance: 'tavi', ts: new Date(now - 60000).toISOString(), data: { action: 'stopped', by: 'pty', snapshot: { session_id: 's-214', tool: 'claude', directory: '/project' } } };
	writeFileSync(join(fixture.dir, 'hcom-events.jsonl'), JSON.stringify(event) + '\n');
	await fixture.refresh(cookie);
	await fixture.refresh(cookie);
	const after = () => { const args = lines('hcom-events-calls.jsonl').at(-1); return args[args.indexOf('--after') + 1]; };
	expect(after()).toBe(new Date(now - 61000).toISOString());
	fixture.setHcom({ eventsFail: { exit: 1, stderr: 'offline' } });
	await fixture.refresh(cookie);
	await fixture.refresh(cookie);
	fixture.setHcom({});
	await fixture.refresh(cookie);
	expect(after()).toBe(new Date(now - 61000).toISOString());
});
test('a read uses three socket lists and no Herdr CLI list; controller location includes plain tabs', async () => {
	const controller = fixture.bound('alpha', 'tavi', { herdr_workspace: 'wA', herdr_tab: 'wA:t2' });
	fixture.list([controller]);
	writeFileSync(join(fixture.dir, 'herdr.json'), JSON.stringify({ workspaces: [{ workspace_id: 'wA', number: 3, label: 'Alpha' }], tabs: [{ tab_id: 'wA:t1', workspace_id: 'wA', label: 'shell' }, { tab_id: 'wA:t2', workspace_id: 'wA', label: 'controller' }], agents: [{ agent: 'claude', agent_status: 'idle', cwd: '/project', pane_id: 'pane-1', tab_id: 'wA:t2', workspace_id: 'wA', agent_session: { value: controller.session_id } }] }));
	const count = lines('herdr-socket-calls.jsonl').length;
	const snapshot = await fixture.refresh(cookie);
	expect(lines('herdr-list-calls.jsonl')).toEqual([]);
	expect(lines('herdr-socket-calls.jsonl').slice(count)).toEqual(expect.arrayContaining([['agent', 'list'], ['workspace', 'list'], ['tab', 'list']]));
	expect(snapshot.agents.find(agent => agent.id === controller.session_id)?.herdr.tabPlace).toEqual({ label: 'controller', position: 2 });
	expect(snapshot.controllers.find(row => row.id === controller.session_id)?.herdrPlace).toEqual({ workspace: { label: 'Alpha', number: 3 }, tab: { label: 'controller', position: 2 } });
	expect((await fixture.fetch('/api/herdr-place?controller=' + controller.session_id, { cookie })).status).toBe(404);
});
