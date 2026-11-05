// The 畫面分頁 on the server: the pane's screen pushed to the pages that have the tab open, secrets
// masked first, read only while one has; keys typed into the pane in order, stopped at the first that
// failed or may not have arrived, and never sent again; the 恢復畫面 after such a request; and the
// operation record's one entry for presses in a row. Herdr and hcom are fakes.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAction } from '../../src/lib/board/agent-actions.ts';
import type { KeysResponse, ScreenUpdate } from '../../src/lib/board/screen.ts';
import { jsonLines, sleep, startFixture, until, type Fixture } from '../harness.ts';

let fixture: Fixture;
let cookie: string;

const PANE = 'wA:p-s-plain';
const OWN = 'wA:p-s-board';
const ESC = '\x1b';
/** Put together from pieces, so no key-like literal sits in the source for secret scanners to flag. */
const KEY = ['gh', 'p_', '0123456789abcdefABCDEF0123456789abcd'].join('');

beforeAll(async () => {
	fixture = await startFixture({ env: { HERDR_PANE_ID: OWN, LAT_BOARD_HERDR_TIMEOUT_SECONDS: '1' } });
	cookie = await fixture.login();
});
afterAll(async () => {
	await fixture.cleanup();
});
beforeEach(async () => {
	for (const file of ['herdr-calls.jsonl', 'herdr-list-calls.jsonl', 'herdr-socket-calls.jsonl']) rmSync(join(fixture.dir, file), { force: true });
	rmSync(join(fixture.dir, 'board-state', 'sent-log.jsonl'), { force: true });
	fixture.list([]);
	setHerdr();
	fixture.setHcom({ agents: [] });
	await fixture.refresh(cookie);
});

function herdrAgent(session: string, pane: string) {
	return { agent: 'claude', agent_session: { kind: 'id', value: session }, agent_status: 'blocked', cwd: `/projects/${session}`, pane_id: pane, tab_id: `wA:t-${session}`, workspace_id: 'wA' };
}
function setHerdr(extra: object = {}) {
	const agents = [herdrAgent('s-plain', PANE), herdrAgent('s-board', OWN)];
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents,
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
			tabs: agents.map((agent) => ({ tab_id: agent.tab_id, workspace_id: 'wA', label: 'tab' })),
			screens: { [PANE]: [`${ESC}[1;34m❯ 1. Yes${ESC}[0m\r\n  2. No\r\n  token ${KEY}`] },
			...extra
		})
	);
}
function changeHerdr(change: (plan: Record<string, any>) => void) {
	const file = join(fixture.dir, 'herdr.json');
	const plan = JSON.parse(readFileSync(file, 'utf8'));
	change(plan);
	writeFileSync(file, JSON.stringify(plan));
}
const herdrCalls = (): string[][] => jsonLines(join(fixture.dir, 'herdr-calls.jsonl'));
const reads = (): string[][] => jsonLines(join(fixture.dir, 'herdr-list-calls.jsonl')).filter((args: string[]) => args[0] === 'pane' && (args[1] === 'read' || args[1] === 'get'));

async function keys(body: object, as: string | undefined = cookie): Promise<{ status: number; body: KeysResponse }> {
	const response = await fixture.fetch('/api/agents/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cookie: as });
	return { status: response.status, body: await response.json() };
}

/** A page's open 畫面分頁: every screen update its stream carried, as raw data too. */
function follow(session: string) {
	const updates: ScreenUpdate[] = [];
	const raw: string[] = [];
	const abort = new AbortController();
	const done = (async () => {
		const response = await fixture.fetch(`/api/agents/screen/events?session=${encodeURIComponent(session)}`, { cookie, signal: abort.signal });
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) return;
				buffer += decoder.decode(value, { stream: true });
				let end: number;
				while ((end = buffer.indexOf('\n\n')) >= 0) {
					const block = buffer.slice(0, end);
					buffer = buffer.slice(end + 2);
					raw.push(block);
					if (block.startsWith('event: screen\n')) updates.push(JSON.parse(block.slice(block.indexOf('data: ') + 6)));
				}
			}
		} catch {
			// Aborted.
		}
	})();
	return { updates, raw, close: async () => (abort.abort(), await done) };
}

test('keys need a logged-in device and a well-formed request', async () => {
	const anonymous = await fixture.fetch('/api/agents/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: 's-plain', keys: [{ key: 'enter' }], recovery: 'r' }) });
	expect(anonymous.status).toBe(401);
	for (const body of [
		{ session: 's-plain', keys: [], recovery: 'r' },
		{ session: 's-plain', keys: [{ key: 'f13' }], recovery: 'r' },
		{ session: 's-plain', keys: [{ text: '' }], recovery: 'r' },
		{ session: 's-plain', keys: [{ key: 'enter', text: 'x' }], recovery: 'r' },
		{ session: 's-plain', keys: [{ key: 'enter' }] }
	]) {
		expect((await keys(body)).status).toBe(400);
	}
	expect(herdrCalls()).toEqual([]);
});

test('named keys go through send-keys and text through send-text, one by one in order; the record keeps kinds and counts, not the text', async () => {
	const sent = await keys({ session: 's-plain', keys: [{ key: 'down' }, { text: '2' }, { key: 'enter' }, { text: '--help 秘密' }, { key: 'shift+tab' }], recovery: 'r1' });
	expect(sent.status).toBe(200);
	expect(sent.body).toMatchObject({ ok: true, results: ['sent', 'sent', 'sent', 'sent', 'sent'], entry: { action: 'keys', route: 'herdr', pane: PANE, text: null } });
	expect(herdrCalls()).toEqual([
		['pane', 'send-keys', PANE, 'down'],
		['pane', 'send-text', PANE, '2'],
		['pane', 'send-keys', PANE, 'enter'],
		['pane', 'send-text', PANE, '--help 秘密'],
		['pane', 'send-keys', PANE, 'shift+tab']
	]);
	expect(sent.body.entry.keys).toEqual([
		{ kind: '↓', count: 1 },
		{ kind: '文字', count: 10 },
		{ kind: 'Enter', count: 1 },
		{ kind: 'Shift+Tab', count: 1 }
	]);
	expect(readFileSync(join(fixture.dir, 'board-state', 'sent-log.jsonl'), 'utf8')).not.toContain('秘密');
});

test('presses a few seconds apart show as one entry in the operation record; a failed one stands apart', async () => {
	await keys({ session: 's-plain', keys: [{ key: 'down' }], recovery: 'a' });
	await keys({ session: 's-plain', keys: [{ key: 'down' }, { key: 'enter' }], recovery: 'b' });
	changeHerdr((plan) => (plan.fail = { 'pane send-keys': { exit: 1, stderr: JSON.stringify({ error: { code: 'x', message: 'nope' } }) } }));
	await keys({ session: 's-plain', keys: [{ key: 'esc' }], recovery: 'c' });
	const response = await fixture.fetch('/api/agents/log?session=s-plain', { cookie });
	const entries: AgentAction[] = (await response.json()).entries;
	expect(entries.map((entry) => [entry.action, entry.ok, entry.keys ?? null])).toEqual([
		['keys', false, null],
		['keys', true, [{ kind: '↓', count: 2 }, { kind: 'Enter', count: 1 }]]
	]);
});

test('the first key that fails stops the rest; nothing is sent again', async () => {
	const refused = JSON.stringify({ error: { code: 'invalid_key', message: 'pane is gone' } });
	setHerdr({ failSeries: { 'pane send-keys': [null, { exit: 1, stderr: refused }] } });
	const failed = await keys({ session: 's-plain', keys: [{ key: 'down' }, { key: 'up' }, { text: '1' }, { key: 'enter' }], recovery: 'r2' });
	expect(failed.status).toBe(502);
	expect(failed.body.ok).toBe(false);
	expect(failed.body.results).toEqual(['sent', 'failed', 'skipped', 'skipped']);
	expect(failed.body.reason).toContain('pane is gone');
	expect(failed.body.reason).toContain('後面 2 個沒有送');
	expect(herdrCalls()).toEqual([
		['pane', 'send-keys', PANE, 'down'],
		['pane', 'send-keys', PANE, 'up']
	]);
	await sleep(300);
	expect(herdrCalls()).toHaveLength(2);
});

test('a key Herdr does not answer in time may have arrived: reported as uncertain, the rest not sent', async () => {
	setHerdr({ slowMs: { 'pane send-text': 1_500 } });
	const unsure = await keys({ session: 's-plain', keys: [{ key: 'esc' }, { text: '3' }, { key: 'enter' }], recovery: 'r3' });
	expect(unsure.body.ok).toBe(false);
	expect(unsure.body.results).toEqual(['sent', 'uncertain', 'skipped']);
	expect(unsure.body.reason).toContain('可能已經送進去');
	await sleep(1_700);
	expect(herdrCalls()).toEqual([
		['pane', 'send-keys', PANE, 'esc'],
		['pane', 'send-text', PANE, '3']
	]);
});

test("the board's own pane takes no keys", async () => {
	const refused = await keys({ session: 's-board', keys: [{ key: 'enter' }], recovery: 'r4' });
	expect(refused.body.ok).toBe(false);
	expect(refused.body.reason).toContain('看板自己所在的窗格');
	expect(refused.body.results).toEqual(['skipped']);
	expect(herdrCalls()).toEqual([]);
});

test('an open tab gets the bottom screen with its colours and the key masked, again only when it changes; none open, none read', async () => {
	const page = follow('s-plain');
	const first = await until(() => page.updates[0], 5_000, 'the first screen');
	expect(first).toMatchObject({ ok: true, recovered: [] });
	if (!first.ok) throw new Error('unreadable');
	expect(first.text).toContain(`${ESC}[1;34m❯ 1. Yes${ESC}[0m`);
	expect(first.text).toContain(`token ${'*'.repeat(KEY.length)}`);
	expect(page.raw.join('\n')).not.toContain(KEY.slice(4, 20));
	expect(reads()).toContainEqual(['pane', 'read', PANE, '--source', 'visible', '--format', 'ansi']);
	// Read about every second, pushed only when it changed.
	const readsBefore = reads().length;
	await sleep(2_300);
	expect(reads().length - readsBefore).toBeGreaterThanOrEqual(2 * 2);
	expect(page.updates).toHaveLength(1);
	changeHerdr((plan) => (plan.screens[PANE] = ['$ done']));
	await until(() => page.updates.length === 2, 3_000, 'the changed screen');
	expect(page.updates[1]).toEqual({ ok: true, text: '$ done', recovered: [] });

	// A second page on the same pane shares the reads and gets the same screen at once.
	const other = follow('s-plain');
	await until(() => other.updates[0], 2_000, "the other page's screen");
	expect(other.updates[0]).toEqual(page.updates[1]);
	await other.close();
	await page.close();
	await sleep(1_200);
	const quiet = reads().length;
	await sleep(1_500);
	expect(reads().length).toBe(quiet);
});

test('a pane scrolled up in Herdr shows its last screenful, without scrolling it', async () => {
	const lines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join('\r\n');
	setHerdr({ paneScroll: { [PANE]: { viewport_rows: 3, offset_from_bottom: 5 } }, recent: { [PANE]: lines } });
	const page = follow('s-plain');
	const first = await until(() => page.updates[0], 5_000, 'the first screen');
	await page.close();
	expect(first).toEqual({ ok: true, text: 'line 8\r\nline 9\r\nline 10', recovered: [] });
	expect(reads()).toContainEqual(['pane', 'read', PANE, '--source', 'recent', '--lines', '3', '--format', 'ansi']);
	expect(jsonLines(join(fixture.dir, 'herdr-socket-calls.jsonl')).filter((args: string[]) => args.join(' ').includes('scroll'))).toEqual([]);
	expect(herdrCalls()).toEqual([]);
});

test('a pane that cannot be read says why', async () => {
	setHerdr({ screens: {} });
	const page = follow('s-plain');
	const first = await until(() => page.updates[0], 5_000, 'the first update');
	await page.close();
	expect(first.ok).toBe(false);
	if (first.ok) throw new Error('read');
	expect(first.reason).toContain('not found');
});

test('after a failed press the screen is read again at once and pushed as its 恢復畫面, unchanged or not; a failed read keeps it waiting', async () => {
	const page = follow('s-plain');
	await until(() => page.updates[0], 5_000, 'the first screen');
	const before = page.updates[0];
	setHerdr({ fail: { 'pane send-keys': { exit: 1, stderr: 'boom' }, 'pane get': { exit: 1, stderr: 'herdr is down' } } });
	const failed = await keys({ session: 's-plain', keys: [{ key: 'enter' }], recovery: 'rec-1' });
	expect(failed.body.ok).toBe(false);
	// The read again fails: pushed as such, the request not yet recovered.
	const down = await until(() => page.updates.find((update) => !update.ok), 3_000, 'the failed read');
	expect(down.recovered).toEqual([]);
	await sleep(1_200);
	expect(page.updates.every((update) => !update.recovered.includes('rec-1'))).toBe(true);
	// Herdr answers again with the very same screen: that read is the 恢復畫面.
	setHerdr();
	const back = await until(() => page.updates.find((update) => update.recovered.includes('rec-1')), 3_000, 'the 恢復畫面');
	expect(back).toEqual({ ...before, recovered: ['rec-1'] });

	// With Herdr up, the 恢復畫面 comes right after the failure, though the screen did not change.
	setHerdr({ fail: { 'pane send-keys': { exit: 1, stderr: 'boom' } } });
	const count = page.updates.length;
	await keys({ session: 's-plain', keys: [{ key: 'esc' }], recovery: 'rec-2' });
	const again = await until(() => page.updates.slice(count).find((update) => update.recovered.includes('rec-2')), 900, 'the second 恢復畫面');
	expect(again.ok && again.text).toBe(before.ok && before.text);
	await page.close();
	// Nothing was typed again meanwhile.
	expect(herdrCalls()).toEqual([
		['pane', 'send-keys', PANE, 'enter'],
		['pane', 'send-keys', PANE, 'esc']
	]);
});

test('a page whose key request got no answer asks for the 恢復畫面 itself', async () => {
	const page = follow('s-plain');
	await until(() => page.updates[0], 5_000, 'the first screen');
	const response = await fixture.fetch('/api/agents/screen/recover', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: 's-plain', recovery: 'lost-1' }), cookie });
	expect(response.status).toBe(200);
	await until(() => page.updates.find((update) => update.recovered.includes('lost-1')), 900, 'the 恢復畫面');
	await page.close();
	expect(herdrCalls()).toEqual([]);
});
