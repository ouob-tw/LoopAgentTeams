// The board-ask hook on permission requests, as Claude and Codex run it: their PermissionRequest
// inputs (the #284 samples) on standard input, a temporary shared folder with a heartbeat the test
// writes, the answer the board would write, and for Claude a transcript the test writes. Codex's
// Stop and PostToolUse events are run the same way. What it prints, how it ends and what it leaves
// in the folder are all that is checked.
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readAsks, settleAsks, takePermission } from '../../src/lib/server/board-asks.ts';

const HOOK = join(import.meta.dir, '../../hooks/board-ask.py');
const LAT_DIR = join(import.meta.dir, '../../../skills/local/lat');

let dir: string;
let panelConfig: string;
let transcript: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'board-ask-perm-'));
	panelConfig = mkdtempSync(join(tmpdir(), 'board-ask-perm-panel-'));
	transcript = join(panelConfig, 'transcript.jsonl');
	const file = join(dir, 'heartbeat');
	writeFileSync(file, 'beat\n');
	const at = Date.now() / 1000;
	utimesSync(file, at, at);
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	rmSync(panelConfig, { recursive: true, force: true });
});

const BASH = { command: 'touch perm-probe.txt', description: 'Create empty probe file' };

/** Claude's PermissionRequest input for a Bash command (#284, C1). */
function claudeInput(overrides: Record<string, unknown> = {}) {
	return {
		session_id: 'session-claude',
		transcript_path: transcript,
		cwd: '/work/project',
		permission_mode: 'default',
		hook_event_name: 'PermissionRequest',
		tool_name: 'Bash',
		tool_input: BASH,
		permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
		...overrides
	};
}

/** Codex's input for an event (#284, X1 and X3): a PermissionRequest unless told otherwise. */
function codexInput(overrides: Record<string, unknown> = {}) {
	return {
		session_id: 'session-codex',
		turn_id: 'turn-1',
		transcript_path: '/nonexistent/rollout.jsonl',
		cwd: '/work/project',
		hook_event_name: 'PermissionRequest',
		model: 'gpt-6.1-sol',
		permission_mode: 'default',
		tool_name: 'Bash',
		tool_input: { command: 'touch cx-probe1.txt', description: 'May I create cx-probe1.txt with touch?' },
		...overrides
	};
}

function hook(payload: unknown, { client = 'claude', env = {} }: { client?: string; env?: Record<string, string> } = {}) {
	const process = Bun.spawn(['uv', 'run', '--no-project', 'python', HOOK, 'hook', ...(client === 'codex' ? ['--client', 'codex'] : [])], {
		stdin: new TextEncoder().encode(JSON.stringify(payload)),
		stdout: 'pipe',
		stderr: 'pipe',
		env: {
			PATH: Bun.env.PATH ?? '',
			HOME: Bun.env.HOME ?? '',
			LAT_BOARD_ASKS_DIR: dir,
			HERDR_PANE_ID: 'wA:p1',
			LAT_BOARD_ASK_WAIT_SECONDS: '20',
			LAT_BOARD_ASK_OBSERVE_SECONDS: '3',
			LAT_BOARD_LAT_DIR: LAT_DIR,
			HERDR_PLUGIN_CONFIG_DIR: panelConfig,
			...env
		}
	});
	return Promise.all([process.exited, new Response(process.stdout).text()]).then(([code, stdout]) => ({ code, stdout }));
}

async function waitingAsk(n = 1) {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const asks = readAsks(dir);
		if (asks.length >= n) return asks[n - 1];
		if (Date.now() > deadline) throw new Error('the hook wrote no ask');
		await Bun.sleep(25);
	}
}

async function until<T>(read: () => T, ok: (value: T) => boolean, ms = 10_000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = read();
		if (ok(value)) return value;
		if (Date.now() > deadline) throw new Error(`still ${JSON.stringify(value)}`);
		await Bun.sleep(50);
	}
}

const stateOf = (id: string) => readAsks(dir).find((ask) => ask.id === id);
const result = (id: string) => JSON.parse(readFileSync(join(dir, `${id}.result.json`), 'utf8'));

/** Claude's transcript lines: the assistant's tool use, and the tool result once there is one. */
const toolUse = (id: string, input: object = BASH, name = 'Bash') =>
	JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }) + '\n';
const toolResult = (id: string, content: string, isError = false) =>
	JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } }) + '\n';
const REJECTED =
	"The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

test('Claude: allow on the board comes back as allow', async () => {
	writeFileSync(transcript, toolUse('toolu_1'));
	const run = hook(claudeInput(), { env: { HCOM_INSTANCE_NAME: 'bure' } });
	const ask = await waitingAsk();
	expect(ask).toMatchObject({ kind: 'permission', client: 'claude', tool: 'Bash', toolInput: BASH, questions: [], state: 'waiting' });
	expect(JSON.parse(readFileSync(join(dir, `${ask.id}.json`), 'utf8'))).toMatchObject({ hcom_name: 'bure', herdr_pane: 'wA:p1', cwd: '/work/project', tool_name: 'Bash' });
	expect(takePermission(dir, ask.id, 'allow')).toBe(true);
	const { code, stdout } = await run;
	expect(code).toBe(0);
	expect(JSON.parse(stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
	// Sent: Claude's dialog was open too, so what it did is watched for.
	expect(stateOf(ask.id)!.state).toBe('sent');
});

test('Claude: deny on the board carries the reason and no interrupt', async () => {
	const run = hook(claudeInput());
	const ask = await waitingAsk();
	takePermission(dir, ask.id, 'deny', '先不要建檔');
	const output = JSON.parse((await run).stdout);
	expect(output).toEqual({
		hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: '使用者在看板拒絕了這個操作。理由：先不要建檔' } }
	});
});

test('Codex: allow and deny come back without updatedInput, for an MCP tool too', async () => {
	const run = hook(codexInput(), { client: 'codex' });
	const ask = await waitingAsk();
	expect(ask).toMatchObject({ kind: 'permission', client: 'codex', tool: 'Bash' });
	expect(JSON.parse(readFileSync(join(dir, `${ask.id}.json`), 'utf8')).turn_id).toBe('turn-1');
	takePermission(dir, ask.id, 'allow');
	expect(JSON.parse((await run).stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
	expect(stateOf(ask.id)!.state).toBe('filled');

	const mcp = hook(codexInput({ tool_name: 'mcp__probe__delete_widget', tool_input: { name: 'w1' } }), { client: 'codex' });
	const second = await waitingAsk(2);
	expect(second).toMatchObject({ tool: 'mcp__probe__delete_widget', toolInput: { name: 'w1' } });
	takePermission(dir, second.id, 'deny', 'no');
	const output = JSON.parse((await mcp).stdout);
	expect(output.hookSpecificOutput.decision).toEqual({ behavior: 'deny', message: '使用者在看板拒絕了這個操作。理由：no' });
	expect(JSON.stringify(output)).not.toContain('updatedInput');
});

test('Claude at its deadline: deny with interrupt, the ask timed out', async () => {
	const run = hook(claudeInput(), { env: { LAT_BOARD_ASK_WAIT_SECONDS: '0.5' } });
	const ask = await waitingAsk();
	const output = JSON.parse((await run).stdout);
	expect(output.hookSpecificOutput.decision).toMatchObject({ behavior: 'deny', interrupt: true });
	expect(result(ask.id).kind).toBe('timeout');
	expect(stateOf(ask.id)!.state).toBe('timed_out');
});

test('Codex at its deadline: no decision, handed back to the terminal, and no answer is taken', async () => {
	const run = hook(codexInput(), { client: 'codex', env: { LAT_BOARD_ASK_WAIT_SECONDS: '0.5' } });
	const ask = await waitingAsk();
	expect(await run).toEqual({ code: 0, stdout: '' });
	expect(result(ask.id).kind).toBe('handed_back');
	expect(stateOf(ask.id)!.state).toBe('handed_back');
	expect(takePermission(dir, ask.id, 'allow')).toBe(false);
});

for (const [said, content, decision] of [
	['allowed', 'done', 'allow'],
	['rejected', REJECTED, 'deny']
] as const) {
	test(`Claude answered in its terminal (${said}): the ask says so, no decision, and none at the deadline`, async () => {
		// An earlier identical call already answered does not count.
		writeFileSync(transcript, toolUse('toolu_old') + toolResult('toolu_old', 'old') + toolUse('toolu_now'));
		const run = hook(claudeInput(), { env: { LAT_BOARD_ASK_WAIT_SECONDS: '4' } });
		const ask = await waitingAsk();
		await Bun.sleep(1_200);
		expect(existsSync(join(dir, `${ask.id}.result.json`))).toBe(false);
		appendFileSync(transcript, toolResult('toolu_now', content, decision === 'deny'));
		const started = Date.now();
		expect(await run).toEqual({ code: 0, stdout: '' });
		// Ended at once, well before the 4 seconds were up.
		expect(Date.now() - started).toBeLessThan(3_000);
		expect(result(ask.id)).toMatchObject({ kind: 'terminal', decision });
		expect(stateOf(ask.id)).toMatchObject({ state: decision === 'deny' ? 'terminal_denied' : 'terminal', actual: decision, notAdopted: false });
		expect(takePermission(dir, ask.id, 'allow')).toBe(false);
	});
}

test('Claude answered in its terminal just before the deadline: no deny with interrupt', async () => {
	writeFileSync(transcript, toolUse('toolu_now'));
	// The transcript is looked at each second; the answer lands between the last look and the deadline.
	const run = hook(claudeInput(), { env: { LAT_BOARD_ASK_WAIT_SECONDS: '1.5' } });
	const ask = await waitingAsk();
	await Bun.sleep(1_150);
	appendFileSync(transcript, toolResult('toolu_now', 'done'));
	expect(await run).toEqual({ code: 0, stdout: '' });
	expect(result(ask.id)).toMatchObject({ kind: 'terminal', decision: 'allow' });
});

test('two identical calls waiting cannot be told apart: the terminal answer is not claimed', async () => {
	writeFileSync(transcript, toolUse('toolu_a') + toolUse('toolu_b'));
	const run = hook(claudeInput(), { env: { LAT_BOARD_ASK_WAIT_SECONDS: '2.5' } });
	const ask = await waitingAsk();
	appendFileSync(transcript, toolResult('toolu_a', 'done'));
	const output = JSON.parse((await run).stdout);
	expect(output.hookSpecificOutput.decision.interrupt).toBe(true);
	expect(result(ask.id).kind).toBe('timeout');
});

test('an answer and the terminal answer at once: only one takes the ask', async () => {
	for (let round = 0; round < 3; round++) {
		rmSync(transcript, { force: true });
		writeFileSync(transcript, toolUse(`toolu_${round}`));
		const run = hook(claudeInput());
		const ask = await waitingAsk(round + 1);
		await Bun.sleep(900 + round * 60);
		appendFileSync(transcript, toolResult(`toolu_${round}`, 'done'));
		const taken = takePermission(dir, ask.id, 'deny');
		const { stdout } = await run;
		const kind = result(ask.id).kind;
		if (taken) expect([kind, JSON.parse(stdout).hookSpecificOutput.decision.behavior]).toEqual(['answer', 'deny']);
		else expect([kind, stdout]).toEqual(['terminal', '']);
	}
});

test('a board answer Claude took: 已填回 once its transcript shows it', async () => {
	writeFileSync(transcript, toolUse('toolu_1'));
	const run = hook(claudeInput());
	const ask = await waitingAsk();
	takePermission(dir, ask.id, 'allow');
	await run;
	expect(stateOf(ask.id)!.state).toBe('sent');
	// The transcript gets the result late, after the hook has ended.
	await Bun.sleep(1_000);
	appendFileSync(transcript, toolResult('toolu_1', 'done'));
	expect((await until(() => stateOf(ask.id)!, (entry) => entry.state !== 'sent')).state).toBe('filled');
});

test('the terminal refused first and the board sent the opposite: 已在終端機拒絕, the board\'s choice not taken', async () => {
	writeFileSync(transcript, toolUse('toolu_1'));
	const run = hook(claudeInput());
	const ask = await waitingAsk();
	// The user rejected in the terminal; the transcript shows it only after the board's allow went out.
	takePermission(dir, ask.id, 'allow');
	await run;
	appendFileSync(transcript, toolResult('toolu_1', REJECTED, true));
	const ended = await until(() => stateOf(ask.id)!, (entry) => entry.state !== 'sent');
	expect(ended).toMatchObject({ state: 'terminal_denied', actual: 'deny', decision: 'allow', notAdopted: true });
});

test('a board deny Claude took: 已填回 by its own message in the tool result', async () => {
	writeFileSync(transcript, toolUse('toolu_1'));
	const run = hook(claudeInput());
	const ask = await waitingAsk();
	takePermission(dir, ask.id, 'deny', 'no');
	await run;
	appendFileSync(transcript, toolResult('toolu_1', '使用者在看板拒絕了這個操作。理由：no', true));
	expect((await until(() => stateOf(ask.id)!, (entry) => entry.state !== 'sent')).state).toBe('filled');
});

test('no result in the transcript within the watch: 結果不明', async () => {
	writeFileSync(transcript, toolUse('toolu_1'));
	const run = hook(claudeInput(), { env: { LAT_BOARD_ASK_OBSERVE_SECONDS: '1' } });
	const ask = await waitingAsk();
	takePermission(dir, ask.id, 'allow');
	await run;
	const ended = await until(() => stateOf(ask.id)!, (entry) => entry.state !== 'sent');
	expect(ended.state).toBe('result_unknown');
	expect(JSON.parse(readFileSync(join(dir, `${ask.id}.observed.json`), 'utf8')).kind).toBe('unknown');
});

const codexEvent = (event: string, overrides: Record<string, unknown> = {}) => hook(codexInput({ hook_event_name: event, ...overrides }), { client: 'codex' });
const postToolUse = (overrides: Record<string, unknown> = {}) =>
	codexEvent('PostToolUse', { tool_input: { command: 'touch cx-probe1.txt' }, tool_response: '', tool_use_id: 'exec-1', ...overrides });

test('Codex: a Stop while waiting marks the turn ended; allow still comes back; only the matching run counts', async () => {
	const run = hook(codexInput(), { client: 'codex' });
	const ask = await waitingAsk();
	expect(await codexEvent('Stop', { stop_hook_active: false, last_assistant_message: 'Approval requested. Stopping here.' })).toEqual({ code: 0, stdout: '' });
	expect(stateOf(ask.id)).toMatchObject({ state: 'waiting', turnEnded: true });
	expect(existsSync(join(dir, `${ask.id}.stopped.json`))).toBe(true);

	takePermission(dir, ask.id, 'allow');
	expect(JSON.parse((await run).stdout).hookSpecificOutput.decision).toEqual({ behavior: 'allow' });
	expect(stateOf(ask.id)!.state).toBe('allowed_waiting');

	// Another turn, or another command: not this one.
	await postToolUse({ turn_id: 'turn-2' });
	await postToolUse({ tool_input: { command: 'touch other.txt' } });
	expect(stateOf(ask.id)!.state).toBe('allowed_waiting');
	await postToolUse({ tool_response: 'created' });
	expect(stateOf(ask.id)!.state).toBe('executed');
	expect(JSON.parse(readFileSync(join(dir, `${ask.id}.executed.json`), 'utf8'))).toMatchObject({ kind: 'executed', summary: 'created' });
});

test('Codex: a Stop of another session, or after the answer, marks nothing', async () => {
	const run = hook(codexInput(), { client: 'codex' });
	const ask = await waitingAsk();
	await codexEvent('Stop', { session_id: 'another' });
	expect(stateOf(ask.id)!.turnEnded).toBe(false);
	takePermission(dir, ask.id, 'allow');
	await run;
	await codexEvent('Stop');
	expect(stateOf(ask.id)).toMatchObject({ state: 'filled', turnEnded: false });
	// Allowed in its turn: its run is marked, but means nothing for it.
	await postToolUse();
	expect(stateOf(ask.id)!.state).toBe('filled');
});

test('Codex: a run two waiting allows match is marked on neither as theirs', async () => {
	const runs = [hook(codexInput(), { client: 'codex' }), hook(codexInput(), { client: 'codex' })];
	await waitingAsk(2);
	await codexEvent('Stop');
	for (const ask of readAsks(dir)) takePermission(dir, ask.id, 'allow');
	await Promise.all(runs);
	await postToolUse();
	expect(readAsks(dir).map((ask) => ask.state)).toEqual(['allowed_unmatched', 'allowed_unmatched']);
});

test('Codex: a denial after the turn ended is an ordinary one', async () => {
	const run = hook(codexInput(), { client: 'codex' });
	const ask = await waitingAsk();
	await codexEvent('Stop');
	takePermission(dir, ask.id, 'deny');
	expect(JSON.parse((await run).stdout).hookSpecificOutput.decision.behavior).toBe('deny');
	expect(stateOf(ask.id)!.state).toBe('filled');
});

test('Codex: Stop and PostToolUse with no shared folder do nothing', async () => {
	rmSync(dir, { recursive: true });
	expect(await codexEvent('Stop')).toEqual({ code: 0, stdout: '' });
	expect(await postToolUse()).toEqual({ code: 0, stdout: '' });
	expect(existsSync(dir)).toBe(false);
});

for (const [when, payload, client] of [
	['the heartbeat is stale', () => (utimesSync(join(dir, 'heartbeat'), 0, 0), claudeInput()), 'claude'],
	['a Task sub-agent asks', () => claudeInput({ agent_id: 'agent-1' }), 'claude'],
	['the tool input is not an object', () => codexInput({ tool_input: 'touch' }), 'codex']
] as const) {
	test(`no decision and no ask when ${when}`, async () => {
		expect(await hook(payload(), { client })).toEqual({ code: 0, stdout: '' });
		expect(readdirSync(dir).filter((name) => name !== 'heartbeat')).toEqual([]);
	});
}

test('Codex: a run that could be an allow in the turn or the one after it is marked on neither as theirs', async () => {
	// One identical command allowed in its turn, then another that outlived the turn.
	const first = hook(codexInput(), { client: 'codex' });
	const inTurn = await waitingAsk();
	takePermission(dir, inTurn.id, 'allow');
	await first;
	const second = hook(codexInput(), { client: 'codex' });
	const outlived = await waitingAsk(2);
	await codexEvent('Stop');
	takePermission(dir, outlived.id, 'allow');
	await second;
	await postToolUse();
	expect(stateOf(outlived.id)!.state).toBe('allowed_unmatched');
	expect(stateOf(inTurn.id)!.state).toBe('filled');
});

test('Codex: a Stop that saw the request waiting but marked it after the allow was taken still counts', async () => {
	const run = hook(codexInput(), { client: 'codex' });
	const ask = await waitingAsk();
	takePermission(dir, ask.id, 'allow');
	await run;
	expect(stateOf(ask.id)!.state).toBe('filled');
	// The run is seen before the Stop's mark lands, as the Stop's process lost both races.
	await postToolUse();
	expect(stateOf(ask.id)!.state).toBe('filled');
	writeFileSync(join(dir, `${ask.id}.stopped.json`), JSON.stringify({ at: new Date().toISOString() }));
	expect(stateOf(ask.id)!.state).toBe('executed');
});

test('a tool\'s own output that quotes the board\'s deny is not a denial: 已填回 for the allow', async () => {
	writeFileSync(transcript, toolUse('toolu_1'));
	const run = hook(claudeInput());
	const ask = await waitingAsk();
	takePermission(dir, ask.id, 'allow');
	await run;
	appendFileSync(transcript, toolResult('toolu_1', 'grep hit: 使用者在看板拒絕了這個操作。'));
	expect((await until(() => stateOf(ask.id)!, (entry) => entry.state !== 'sent')).state).toBe('filled');
});

/** Claude's tool result for a No in its dialog, as 2.1.310 writes it; Esc writes the same. Both
 *  may add the interrupted line as an entry of its own, a few milliseconds later. */
const rejectedEntry = (id: string) =>
	JSON.stringify({ type: 'user', toolDenialKind: 'user-rejected', toolUseResult: 'User rejected tool use', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: REJECTED, is_error: true }] } }) + '\n';
const interruptedEntry = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }) + '\n';
const hookPid = (id: string): number => JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')).hook_pid;
const watcherPid = (id: string) => JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')).watcher_pid as number | undefined;

for (const [said, entries] of [
	['No', () => rejectedEntry('toolu_no')],
	['Esc', () => rejectedEntry('toolu_no') + interruptedEntry]
] as const) {
	test(`Claude ends the hook for ${said} in its dialog before writing it: 已在終端機拒絕, not interrupted`, async () => {
		writeFileSync(transcript, toolUse('toolu_no'));
		const run = hook(claudeInput());
		const ask = await waitingAsk();
		process.kill(hookPid(ask.id), 'SIGTERM');
		expect(await run).toEqual({ code: 0, stdout: '' });
		// The board looks while the watcher runs: not interrupted.
		const stateDir = mkdtempSync(join(tmpdir(), 'board-ask-perm-state-'));
		const config = { asksDir: dir, stateDir, askExecutionWaitMs: 60_000 };
		await until(() => watcherPid(ask.id), Boolean);
		settleAsks(config, []);
		expect(stateOf(ask.id)!.state).toBe('waiting');
		appendFileSync(transcript, entries());
		const ended = await until(() => stateOf(ask.id)!, (entry) => entry.state !== 'waiting');
		expect(ended).toMatchObject({ state: 'terminal_denied', actual: 'deny', notAdopted: false });
		settleAsks(config, []);
		expect(stateOf(ask.id)!.state).toBe('terminal_denied');
		expect(takePermission(dir, ask.id, 'allow')).toBe(false);
		rmSync(stateDir, { recursive: true, force: true });
	});
}

test('a hook ended with nothing in the transcript (the agent closed) reads interrupted once the watcher is done', async () => {
	writeFileSync(transcript, toolUse('toolu_gone'));
	const run = hook(claudeInput());
	const ask = await waitingAsk();
	process.kill(hookPid(ask.id), 'SIGTERM');
	await run;
	const watcher = await until(() => watcherPid(ask.id), Boolean);
	await until(() => existsSync(`/proc/${watcher}`), (alive) => !alive, 15_000);
	expect(existsSync(join(dir, `${ask.id}.result.json`))).toBe(false);
	const stateDir = mkdtempSync(join(tmpdir(), 'board-ask-perm-state-'));
	settleAsks({ asksDir: dir, stateDir, askExecutionWaitMs: 60_000 }, []);
	expect(stateOf(ask.id)!.state).toBe('interrupted');
	rmSync(stateDir, { recursive: true, force: true });
});
