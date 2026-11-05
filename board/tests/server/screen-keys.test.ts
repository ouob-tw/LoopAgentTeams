// Failures recovered stay listed for 10 minutes per agent, so an update may list those of earlier
// tests: each test looks only for its own. Waits are bounded conditions, not counts in a fixed time,
// so a loaded host only makes them slower; every page a test opened is closed after it, so a test
// that fails leaves no screen reader behind for the next one.
// The 畫面分頁 on the server: the pane's screen pushed to the pages that have the tab open, secrets
// masked first, read only while one has; keys typed into the pane in order, stopped at the first that
// failed or may not have arrived, and never sent again; the 恢復畫面 after such a request; and the
// operation record's one entry for presses in a row. Herdr and hcom are fakes.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
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
function setHerdr(extra: object = {}, on: Fixture = fixture) {
	const agents = [herdrAgent('s-plain', PANE), herdrAgent('s-board', OWN)];
	writeFileSync(
		join(on.dir, 'herdr.json'),
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

async function keys(body: object, as: string | undefined = cookie, on: Fixture = fixture): Promise<{ status: number; body: KeysResponse }> {
	const response = await on.fetch('/api/agents/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cookie: as });
	return { status: response.status, body: await response.json() };
}

/** The pages a test opened and has not closed. */
const open = new Set<() => Promise<void>>();
afterEach(async () => {
	await Promise.all([...open].map((close) => close()));
});

/** A page's open 畫面分頁: every screen update its stream carried, as raw data too. */
function follow(session: string, on: Fixture = fixture, as: string = cookie) {
	const updates: ScreenUpdate[] = [];
	const raw: string[] = [];
	const abort = new AbortController();
	const done = (async () => {
		const response = await on.fetch(`/api/agents/screen/events?session=${encodeURIComponent(session)}`, { cookie: as, signal: abort.signal });
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
	const close = async () => {
		open.delete(close);
		abort.abort();
		await done;
	};
	open.add(close);
	return { updates, raw, close };
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
	expect(first.ok).toBe(true);
	if (!first.ok) throw new Error('unreadable');
	expect(first.text).toContain(`${ESC}[1;34m❯ 1. Yes${ESC}[0m`);
	expect(first.text).toContain(`token ${'*'.repeat(KEY.length)}`);
	expect(page.raw.join('\n')).not.toContain(KEY.slice(4, 20));
	expect(reads()).toContainEqual(['pane', 'read', PANE, '--source', 'visible', '--format', 'ansi']);
	// Read again and again, about every second (each time `pane get` and `pane read`), pushed only
	// when it changed: two more rounds come within a loose bound, and no push with them.
	const readsBefore = reads().length;
	await until(() => reads().length - readsBefore >= 2 * 2, 8_000, 'two more rounds of reads');
	expect(page.updates).toHaveLength(1);
	changeHerdr((plan) => (plan.screens[PANE] = ['$ done']));
	await until(() => page.updates.length === 2, 5_000, 'the changed screen');
	expect(page.updates[1]).toMatchObject({ ok: true, text: '$ done' });

	// A second page on the same pane shares the reads and gets the same screen at once.
	const other = follow('s-plain');
	await until(() => other.updates[0], 5_000, "the other page's screen");
	expect(other.updates[0]).toEqual(page.updates[1]);
	await other.close();
	await page.close();
	// Reads stop: a read already under way may still finish, then none for 1.5 s.
	const deadline = Date.now() + 10_000;
	for (let quiet = reads().length; ; quiet = reads().length) {
		await sleep(1_500);
		if (reads().length === quiet) break;
		if (Date.now() > deadline) throw new Error('the screen is still read after the last page closed');
	}
});

test('a pane scrolled up in Herdr shows its last screenful, without scrolling it', async () => {
	const lines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join('\r\n');
	setHerdr({ paneScroll: { [PANE]: { viewport_rows: 3, offset_from_bottom: 5 } }, recent: { [PANE]: lines } });
	const page = follow('s-plain');
	const first = await until(() => page.updates[0], 5_000, 'the first screen');
	await page.close();
	expect(first).toMatchObject({ ok: true, text: 'line 8\r\nline 9\r\nline 10' });
	expect(reads()).toContainEqual(['pane', 'read', PANE, '--source', 'recent', '--lines', '3', '--format', 'ansi']);
	expect(jsonLines(join(fixture.dir, 'herdr-socket-calls.jsonl')).filter((args: string[]) => args.join(' ').includes('scroll'))).toEqual([]);
	expect(herdrCalls()).toEqual([]);
});

test('which lines the pane wrapped is asked of Herdr only when it changes what is masked', async () => {
	const width = 24;
	const wrapped = `key ${KEY}`;
	const screen = ['password=hunter2abc', '$ ls', wrapped.slice(0, width), wrapped.slice(width), '$ '].join('\r\n');
	setHerdr({ screens: { [PANE]: [screen] }, unwrapped: { [PANE]: ['password=hunter2abc', '$ ls', wrapped, '$ '].join('\r\n') } });
	const page = follow('s-plain');
	const first = await until(() => page.updates[0], 5_000, 'the first screen');
	await page.close();
	expect(first).toMatchObject({ ok: true, text: ['password=**********', '$ ls', `key ${'*'.repeat(width - 4)}`, '*'.repeat(wrapped.length - width), '$ '].join('\r\n') });
	expect(reads()).toContainEqual(['pane', 'read', PANE, '--source', 'recent-unwrapped', '--lines', '24']);

	// Nothing wrapped would change it: not asked.
	rmSync(join(fixture.dir, 'herdr-list-calls.jsonl'), { force: true });
	setHerdr({ screens: { [PANE]: [['$ cat .env', 'password=hunter2abc'].join('\r\n')] } });
	const plain = follow('s-plain');
	await until(() => plain.updates[0], 5_000, 'the plain screen');
	await plain.close();
	expect(reads().some((args) => args.includes('recent-unwrapped'))).toBe(false);
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

test('after a failed press the screen is read again and pushed as its 恢復畫面, unchanged or not; a failed read keeps it waiting', async () => {
	const page = follow('s-plain');
	await until(() => page.updates[0], 5_000, 'the first screen');
	const before = page.updates[0];
	setHerdr({ fail: { 'pane send-keys': { exit: 1, stderr: 'boom' }, 'pane get': { exit: 1, stderr: 'herdr is down' } } });
	const failed = await keys({ session: 's-plain', keys: [{ key: 'enter' }], recovery: 'rec-1' });
	expect(failed.body.ok).toBe(false);
	// The read again fails: pushed as such, the request not yet recovered.
	const down = await until(() => page.updates.find((update) => !update.ok), 5_000, 'the failed read');
	expect(down.recovered).not.toContain('rec-1');
	await sleep(1_200);
	expect(page.updates.every((update) => !update.recovered.includes('rec-1'))).toBe(true);
	// Herdr answers again with the very same screen: that read is the 恢復畫面.
	setHerdr();
	const back = await until(() => page.updates.find((update) => update.recovered.includes('rec-1')), 5_000, 'the 恢復畫面');
	expect(back.ok && back.text).toBe(before.ok && before.text);

	// With Herdr up, the 恢復畫面 comes after the failure, though the screen did not change.
	setHerdr({ fail: { 'pane send-keys': { exit: 1, stderr: 'boom' } } });
	const count = page.updates.length;
	await keys({ session: 's-plain', keys: [{ key: 'esc' }], recovery: 'rec-2' });
	const again = await until(() => page.updates.slice(count).find((update) => update.recovered.includes('rec-2')), 5_000, 'the second 恢復畫面');
	expect(again.ok && again.text).toBe(before.ok && before.text);
	await page.close();
	// Nothing was typed again meanwhile.
	expect(herdrCalls()).toEqual([
		['pane', 'send-keys', PANE, 'enter'],
		['pane', 'send-keys', PANE, 'esc']
	]);
});

test('a failure whose page lost its connection, or that came while no page had the tab open, is recovered when one opens it again', async () => {
	const page = follow('s-plain');
	await until(() => page.updates[0], 5_000, 'the first screen');
	setHerdr({ fail: { 'pane send-keys': { exit: 1, stderr: 'boom' }, 'pane get': { exit: 1, stderr: 'herdr is down' } } });
	await keys({ session: 's-plain', keys: [{ key: 'enter' }], recovery: 'gone-1' });
	await until(() => page.updates.find((update) => !update.ok), 5_000, 'the failed read');
	// The only page drops off before any read succeeds.
	await page.close();
	// Another failure while no page has the tab open.
	await keys({ session: 's-plain', keys: [{ key: 'esc' }], recovery: 'gone-2' });
	setHerdr();
	const back = follow('s-plain');
	const first = await until(() => back.updates.find((update) => update.ok && update.recovered.includes('gone-1') && update.recovered.includes('gone-2')), 5_000, 'both 恢復畫面');
	await back.close();
	expect(first.ok).toBe(true);
});

test('after the agent moves to another pane (a model switch), the open tab follows the pane Herdr lists it in now', async () => {
	const page = follow('s-plain');
	await until(() => page.updates[0], 5_000, 'the first screen');
	changeHerdr((plan) => {
		plan.agents = plan.agents.map((agent: { pane_id: string }) => (agent.pane_id === PANE ? { ...agent, pane_id: 'wA:p-moved' } : agent));
		plan.screens['wA:p-moved'] = ['$ the new pane'];
	});
	await fixture.refresh(cookie);
	await until(() => page.updates.find((update) => update.ok && update.text === '$ the new pane'), 5_000, "the new pane's screen");
	await page.close();
	const sent = await keys({ session: 's-plain', keys: [{ key: 'enter' }], recovery: 'moved' });
	expect(sent.body.ok).toBe(true);
	expect(herdrCalls()).toEqual([['pane', 'send-keys', 'wA:p-moved', 'enter']]);
});

test('a page whose key request got no answer asks for the 恢復畫面 itself', async () => {
	const page = follow('s-plain');
	await until(() => page.updates[0], 5_000, 'the first screen');
	const response = await fixture.fetch('/api/agents/screen/recover', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: 's-plain', recovery: 'lost-1' }), cookie });
	expect(response.status).toBe(200);
	await until(() => page.updates.find((update) => update.recovered.includes('lost-1')), 5_000, 'the 恢復畫面');
	await page.close();
	expect(herdrCalls()).toEqual([]);
});

test('a key request may carry up to 200 inputs, text up to 10000 characters and a recovery ID up to 100; one more is refused and nothing is sent', async () => {
	// Herdr fails the first input, so a request that is taken types one and skips the rest.
	setHerdr({ fail: { 'pane send-text': { exit: 1, stderr: 'boom' } } });
	const most = await keys({ session: 's-plain', keys: Array.from({ length: 200 }, () => ({ text: 'x' })), recovery: 'r'.repeat(100) });
	expect(most.status).toBe(502);
	expect(most.body.results).toHaveLength(200);
	const longest = await keys({ session: 's-plain', keys: [{ text: 'y'.repeat(10_000) }], recovery: 'bound-text' });
	expect(longest.body.results).toEqual(['failed']);
	expect(herdrCalls().map((call) => [call[1], call[3].length])).toEqual([
		['send-text', 1],
		['send-text', 10_000]
	]);
	for (const body of [
		{ session: 's-plain', keys: Array.from({ length: 201 }, () => ({ text: 'x' })), recovery: 'bound-201' },
		{ session: 's-plain', keys: [{ text: 'y'.repeat(10_001) }], recovery: 'bound-10001' },
		{ session: 's-plain', keys: [{ key: 'enter' }], recovery: 'r'.repeat(101) }
	]) {
		const refused = await keys(body);
		expect(refused.status).toBe(400);
		expect(refused.body).toEqual({ error: 'invalid_keys' } as unknown as KeysResponse);
	}
	const recover = (recovery: string) => fixture.fetch('/api/agents/screen/recover', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: 's-plain', recovery }), cookie });
	expect((await recover('q'.repeat(100))).status).toBe(200);
	const over = await recover('q'.repeat(101));
	expect(over.status).toBe(400);
	expect(await over.json()).toEqual({ error: 'invalid_recovery' });
	expect(herdrCalls()).toHaveLength(2);
});

test('keys are refused, nothing sent, for an agent Herdr no longer lists and for one whose model switch is unfinished', async () => {
	setHerdr({ agents: [herdrAgent('s-board', OWN)] });
	await fixture.refresh(cookie);
	const gone = await keys({ session: 's-plain', keys: [{ key: 'enter' }], recovery: 'gone-keys' });
	expect(gone.status).toBe(409);
	expect(gone.body.reason).toContain('不在 Herdr 的清單上');
	expect(gone.body.results).toEqual(['skipped']);

	setHerdr();
	// A switch whose stop failed stays open until it is continued or given up.
	const open = { id: 'switch-open', kind: 'switch', time: new Date().toISOString(), controllerId: 's-plain', hcomName: '', client: 'claude', from: null, to: { model: null, effort: 'high' }, route: 'restart', state: 'stop-failed', error: 'boom', pane: null };
	writeFileSync(join(fixture.dir, 'board-state', 'sent-log.jsonl'), JSON.stringify(open) + '\n');
	await fixture.refresh(cookie);
	const switching = await keys({ session: 's-plain', keys: [{ key: 'enter' }], recovery: 'switch-keys' });
	expect(switching.status).toBe(409);
	expect(switching.body.reason).toContain('切換');
	expect(switching.body.results).toEqual(['skipped']);
	expect(herdrCalls()).toEqual([]);
});

test('an agent keeps its newest 100 waiting failures: at 101 the oldest is dropped and never recovered', async () => {
	for (let n = 1; n <= 101; n++) {
		const response = await fixture.fetch('/api/agents/screen/recover', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: 's-plain', recovery: `cap-${n}` }), cookie });
		expect(response.status).toBe(200);
	}
	const page = follow('s-plain');
	const first = await until(() => page.updates.find((update) => update.ok && update.recovered.includes('cap-101')), 5_000, 'the 恢復畫面');
	await page.close();
	const mine = first.recovered.filter((id) => id.startsWith('cap-'));
	expect(mine).toHaveLength(100);
	expect(mine).not.toContain('cap-1');
	expect(mine).toContain('cap-2');
});

test('a recovered failure stays listed for 10 minutes on the board clock, then is dropped', async () => {
	const start = Date.now();
	fixture.setClock(start);
	try {
		const page = follow('s-plain');
		await until(() => page.updates[0], 5_000, 'the first screen');
		const response = await fixture.fetch('/api/agents/screen/recover', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: 's-plain', recovery: 'kept-1' }), cookie });
		expect(response.status).toBe(200);
		await until(() => page.updates.find((update) => update.recovered.includes('kept-1')), 5_000, 'the 恢復畫面');
		// Just under 10 minutes later: still listed, in a push the changed screen makes.
		fixture.setClock(start + 10 * 60_000 - 1_000);
		changeHerdr((plan) => (plan.screens[PANE] = ['$ nine minutes on']));
		const later = await until(() => page.updates.find((update) => update.ok && update.text === '$ nine minutes on'), 5_000, 'the screen 10 minutes on');
		expect(later.recovered).toContain('kept-1');
		// Past 10 minutes: the next read drops it, and that change is pushed though the screen is the same.
		fixture.setClock(start + 10 * 60_000 + 1_000);
		const dropped = await until(() => page.updates.find((update) => update.ok && update.text === '$ nine minutes on' && !update.recovered.includes('kept-1')), 5_000, 'kept-1 dropped');
		expect(dropped.recovered).not.toContain('kept-1');
	} finally {
		rmSync(join(fixture.dir, 'clock'), { force: true });
	}
});

test('the read after a failed press comes at once, not with the regular rhythm', async () => {
	// A board that reads an open screen only once a minute: a 恢復畫面 within seconds was read for the failure.
	const slow = await startFixture({ env: { HERDR_PANE_ID: OWN, LAT_BOARD_HERDR_TIMEOUT_SECONDS: '1', LAT_BOARD_SCREEN_SECONDS: '60' } });
	try {
		const as = await slow.login();
		setHerdr({}, slow);
		await slow.refresh(as);
		const page = follow('s-plain', slow, as);
		await until(() => page.updates[0], 5_000, 'the first screen');
		setHerdr({ fail: { 'pane send-keys': { exit: 1, stderr: 'boom' } } }, slow);
		const failed = await keys({ session: 's-plain', keys: [{ key: 'esc' }], recovery: 'soon-1' }, as, slow);
		expect(failed.body.ok).toBe(false);
		await until(() => page.updates.find((update) => update.recovered.includes('soon-1')), 20_000, 'the 恢復畫面');
		await page.close();
	} finally {
		await slow.cleanup();
	}
});
