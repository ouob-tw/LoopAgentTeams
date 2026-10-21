// Waiting for a started client to run in Herdr (`waitToAppear`) while Herdr's lists cannot be read,
// against the fake hcom and Herdr commands. Nothing here starts an agent or touches a real Herdr.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitToAppear } from '../src/lib/server/appear.ts';
import { loadConfig } from '../src/lib/server/config.ts';
import { NODE } from './harness.ts';

const dir = mkdtempSync(join(tmpdir(), 'lat-board-appear-'));
const config = loadConfig({
	LAT_BOARD_HCOM_COMMAND: JSON.stringify([NODE, join(import.meta.dir, 'fake-hcom.mjs'), dir]),
	LAT_BOARD_HERDR_COMMAND: JSON.stringify([NODE, join(import.meta.dir, 'fake-herdr.mjs'), dir])
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const broken = { exit: 1, stderr: 'herdr socket gone' };
/** How many times Herdr's agent list was asked for. */
const agentLists = () => {
	const file = join(dir, 'herdr-list-calls.jsonl');
	return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter((line) => line === '["agent","list"]').length : 0;
};

beforeEach(() => {
	rmSync(join(dir, 'herdr-list-calls.jsonl'), { force: true });
	// hcom lists the client, without a pane: only Herdr's lists can end the wait early.
	writeFileSync(join(dir, 'hcom.json'), JSON.stringify({ agents: [{ name: 'tavi', session_id: 's-tavi' }] }));
});

test('when Herdr\'s list cannot be read 5 times in a row, the wait gives up, saying so with the error', async () => {
	writeFileSync(join(dir, 'herdr.json'), JSON.stringify({ workspaces: [], tabs: [], agents: [], fail: { 'agent list': broken } }));

	const appeared = await waitToAppear(config, { name: 'tavi' }, Date.now() + 60_000, '@tavi');

	expect(appeared.found).toBeNull();
	const reason = 'reason' in appeared ? appeared.reason : '';
	expect(reason).toContain('讀不到');
	expect(reason).toContain('herdr socket gone');
	expect(reason).toContain('@tavi');
	expect(agentLists()).toBe(5);
}, 20_000);

test('one read of Herdr\'s list in between starts the count again', async () => {
	writeFileSync(
		join(dir, 'herdr.json'),
		JSON.stringify({ workspaces: [], tabs: [], agents: [], failSeries: { 'agent list': [broken, broken, broken, broken, null] }, fail: { 'agent list': broken } })
	);

	const appeared = await waitToAppear(config, { name: 'tavi' }, Date.now() + 60_000, '@tavi');

	expect(appeared.found).toBeNull();
	expect('reason' in appeared ? appeared.reason : '').toContain('讀不到');
	// 4 failures, the read that starts the count again, then 5 more failures.
	expect(agentLists()).toBe(10);
}, 30_000);
