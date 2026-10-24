// The board-ask hook as Claude runs it: an AskUserQuestion input on standard input, a temporary
// shared folder with a heartbeat the test writes, and the answer the board would write. What it
// prints, how it ends and what it leaves in the folder are all that is checked.
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readAsks, takeAsk } from '../../src/lib/server/board-asks.ts';

const HOOK = join(import.meta.dir, '../../hooks/board-ask.py');

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'board-ask-hook-'));
	beat();
});
afterEach(() => {
	chmodSync(dir, 0o700);
	rmSync(dir, { recursive: true, force: true });
});

/** The board's heartbeat, `ageSeconds` old. */
function beat(ageSeconds = 0) {
	const file = join(dir, 'heartbeat');
	writeFileSync(file, 'beat\n');
	const at = Date.now() / 1000 - ageSeconds;
	utimesSync(file, at, at);
}

const QUESTIONS = [
	{ question: 'Pick a color?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'Choose red.' }, { label: 'Blue', description: 'Choose blue.' }] },
	{ question: 'Pick fruits?', header: 'Fruit', multiSelect: true, options: [{ label: 'Apple', description: 'a' }, { label: 'Cherry', description: 'c' }] }
];

function input(overrides: Record<string, unknown> = {}) {
	return {
		session_id: 'session-ask',
		transcript_path: '/nonexistent/transcript.jsonl',
		cwd: '/work/project',
		hook_event_name: 'PreToolUse',
		tool_name: 'AskUserQuestion',
		tool_input: { questions: QUESTIONS },
		tool_use_id: 'toolu_1',
		...overrides
	};
}

function hook(payload: unknown, env: Record<string, string> = {}) {
	const process = Bun.spawn(['uv', 'run', '--no-project', 'python', HOOK, 'hook'], {
		stdin: new TextEncoder().encode(typeof payload === 'string' ? payload : JSON.stringify(payload)),
		stdout: 'pipe',
		stderr: 'pipe',
		env: { PATH: Bun.env.PATH ?? '', HOME: Bun.env.HOME ?? '', LAT_BOARD_ASKS_DIR: dir, HERDR_PANE_ID: 'wA:p1', LAT_BOARD_ASK_WAIT_SECONDS: '20', ...env }
	});
	return {
		done: Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]).then(([code, stdout, stderr]) => ({ code, stdout, stderr }))
	};
}

async function waitingAsk() {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const [ask] = readAsks(dir);
		if (ask) return ask;
		if (Date.now() > deadline) throw new Error('the hook wrote no ask');
		await Bun.sleep(25);
	}
}

const askFiles = () => readdirSync(dir).filter((name) => name !== 'heartbeat');

test('an answer from the board comes back as allow with the questions and their answers', async () => {
	const run = hook(input(), { HCOM_INSTANCE_NAME: 'bure' });
	const ask = await waitingAsk();
	expect(ask).toMatchObject({ sessionId: 'session-ask', client: 'claude', questions: QUESTIONS, state: 'waiting' });
	const file = JSON.parse(readFileSync(join(dir, `${ask.id}.json`), 'utf8'));
	expect(file).toMatchObject({ hcom_name: 'bure', herdr_pane: 'wA:p1', cwd: '/work/project', kind: 'question', tool_use_id: 'toolu_1', outcome: null });
	for (const name of askFiles()) expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);

	// A single choice, two labels of a multi-select one joined with commas.
	expect(takeAsk(dir, ask.id, { 'Pick a color?': 'Blue', 'Pick fruits?': 'Apple, Cherry' })).toBe(true);
	const { code, stdout } = await run.done;
	expect(code).toBe(0);
	expect(JSON.parse(stdout)).toEqual({
		hookSpecificOutput: {
			hookEventName: 'PreToolUse',
			permissionDecision: 'allow',
			updatedInput: { questions: QUESTIONS, answers: { 'Pick a color?': 'Blue', 'Pick fruits?': 'Apple, Cherry' } }
		}
	});
	expect(readAsks(dir)[0].state).toBe('filled');
});

test('text of the user\'s own is handed back as typed', async () => {
	const run = hook(input({ tool_input: { questions: [QUESTIONS[0]] } }));
	const ask = await waitingAsk();
	takeAsk(dir, ask.id, { 'Pick a color?': 'A small turtle named Bo' });
	const { stdout } = await run.done;
	expect(JSON.parse(stdout).hookSpecificOutput.updatedInput.answers).toEqual({ 'Pick a color?': 'A small turtle named Bo' });
});

test('an answer that leaves a question out is not handed back', async () => {
	const run = hook(input());
	const ask = await waitingAsk();
	takeAsk(dir, ask.id, { 'Pick a color?': 'Blue' });
	const { code, stdout } = await run.done;
	expect([code, stdout]).toEqual([0, '']);
});

test('the deadline with no answer takes the ask as timed out and leaves the client its menu', async () => {
	const run = hook(input(), { LAT_BOARD_ASK_WAIT_SECONDS: '0.5' });
	const ask = await waitingAsk();
	const { code, stdout } = await run.done;
	expect([code, stdout]).toEqual([0, '']);
	expect(readAsks(dir)[0]).toMatchObject({ id: ask.id, state: 'timed_out' });
	// The board's answer comes too late: the result is taken.
	expect(takeAsk(dir, ask.id, { 'Pick a color?': 'Red', 'Pick fruits?': 'Apple' })).toBe(false);
});

const passes: [string, () => { payload: unknown; env?: Record<string, string> }][] = [
	['the heartbeat is stale', () => (beat(91), { payload: input() })],
	['there is no heartbeat', () => (rmSync(join(dir, 'heartbeat')), { payload: input() })],
	['the shared folder cannot be written', () => (chmodSync(dir, 0o500), { payload: input() })],
	['the input is not JSON', () => ({ payload: '{"tool_name": "AskUser' })],
	['the questions are not ones', () => ({ payload: input({ tool_input: { questions: [{ header: 'no question' }] } }) })],
	['the agent is not in a Herdr pane', () => ({ payload: input(), env: { HERDR_PANE_ID: '' } })],
	['a Task sub-agent asks', () => ({ payload: input({ agent_id: 'agent-1', agent_type: 'general-purpose' }) })],
	// Claude asks for permission for AskUserQuestion once its PreToolUse hook gave no decision.
	['it is the permission request for AskUserQuestion', () => ({ payload: input({ hook_event_name: 'PermissionRequest' }) })]
];
for (const [when, setup] of passes) {
	test(`no decision, exit 0 and no ask when ${when}`, async () => {
		const { payload, env } = setup();
		const started = Date.now();
		const { code, stdout } = await hook(payload, env).done;
		expect([code, stdout]).toEqual([0, '']);
		expect(askFiles()).toEqual([]);
		// Left to the client at once, not after a wait.
		expect(Date.now() - started).toBeLessThan(10_000);
	});
}

test('of two answers written at once only one takes the ask', async () => {
	// Two processes race for the same result file, again and again.
	const racer = join(dir, 'race.ts');
	writeFileSync(racer, `import { takeAsk } from ${JSON.stringify(join(import.meta.dir, '../../src/lib/server/board-asks.ts'))};\nconst [folder, id, answer] = process.argv.slice(2);\nconsole.log(takeAsk(folder, id, { q: answer }));\n`);
	for (let round = 0; round < 5; round++) {
		const id = `race-${round}`;
		const results = await Promise.all(
			['A', 'B'].map(async (answer) => {
				const child = Bun.spawn([process.execPath, racer, dir, id, answer], { stdout: 'pipe' });
				return (await new Response(child.stdout).text()).trim();
			})
		);
		expect(results.toSorted()).toEqual(['false', 'true']);
		const won = JSON.parse(readFileSync(join(dir, `${id}.result.json`), 'utf8'));
		expect(results[['A', 'B'].indexOf(won.answers.q)]).toBe('true');
	}
	expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
});

test('an answer and the deadline at the same moment: either handed back or timed out, never both', async () => {
	for (let round = 0; round < 3; round++) {
		const run = hook(input(), { LAT_BOARD_ASK_WAIT_SECONDS: '0.6' });
		const ask = await waitingAsk();
		await Bun.sleep(550);
		const taken = takeAsk(dir, ask.id, { 'Pick a color?': 'Red', 'Pick fruits?': 'Apple' });
		const { stdout } = await run.done;
		const state = readAsks(dir).find((entry) => entry.id === ask.id)!.state;
		if (taken) expect([state, JSON.parse(stdout).hookSpecificOutput.permissionDecision]).toEqual(['filled', 'allow']);
		else expect([state, stdout]).toEqual(['timed_out', '']);
		rmSync(join(dir, `${ask.id}.json`));
		rmSync(join(dir, `${ask.id}.result.json`));
	}
});
