import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SendResponse, SentMessage } from '../src/lib/board/messages.ts';
import { NODE, startFixture, type Fixture } from './harness.ts';

// The fake input command's plan and call log live outside the fixture directory, because the
// command line has to be known before the fixture creates its own.
const injectDir = mkdtempSync(join(tmpdir(), 'lat-board-inject-'));
const callLog = join(injectDir, 'inject-calls.jsonl');
const typedLog = join(injectDir, 'inject-typed.jsonl');

let fixture: Fixture;
let cookie: string;

beforeAll(async () => {
	fixture = await startFixture(9, {
		env: {
			LAT_BOARD_INJECT_COMMAND: JSON.stringify([NODE, join(import.meta.dir, 'fake-inject.mjs'), injectDir]),
			LAT_BOARD_INJECT_TIMEOUT_SECONDS: '1'
		}
	});
	cookie = await fixture.login();
});
afterAll(async () => {
	await fixture.cleanup();
	rmSync(injectDir, { recursive: true, force: true });
});
beforeEach(() => {
	rmSync(callLog, { force: true });
	rmSync(typedLog, { force: true });
	plan({});
});

type Plan = Record<string, { exit?: number; failFrom?: number; stdout?: string; stderr?: string; sleepMs?: number }>;
const plan = (value: Plan) => writeFileSync(join(injectDir, 'inject.json'), JSON.stringify(value));

/** Every call of the input command so far, as its argument list. */
function calls(): string[][] {
	if (!existsSync(callLog)) return [];
	return readFileSync(callLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

/** What the input command put into the client's input box, as the fake reads its arguments:
 *  the text typed in all, and how many times it was submitted. */
function typed(): { text: string; submits: number } {
	if (!existsSync(typedLog)) return { text: '', submits: 0 };
	const lines: { text: string; enter: boolean }[] = readFileSync(typedLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
	return { text: lines.map((line) => line.text).join(''), submits: lines.filter((line) => line.enter).length };
}

async function send(controllerId: unknown, text: unknown, as = cookie): Promise<{ status: number; body: SendResponse }> {
	const response = await fixture.fetch('/api/messages', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ controllerId, text }),
		cookie: as
	});
	return { status: response.status, body: await response.json() };
}

async function sentTo(controllerId: string, as = cookie): Promise<SentMessage[]> {
	const response = await fixture.fetch(`/api/messages?controller=${encodeURIComponent(controllerId)}`, { cookie: as });
	return (await response.json()).entries;
}

test('a two-line message is typed into a Claude and a Codex controller as one message each', async () => {
	const claude = fixture.bound('alpha', 'luna', { client: 'claude' });
	const codex = fixture.bound('beta', 'nova', { client: 'codex' });
	fixture.list([claude, codex]);

	const first = await send(claude.session_id, '第一行\n第二行');
	const second = await send(codex.session_id, 'line one\nline two');

	expect(first).toMatchObject({ status: 200, body: { ok: true, reason: null } });
	expect(second).toMatchObject({ status: 200, body: { ok: true, reason: null } });
	// One call per message: the whole text is a single argument, submitted once at the end.
	expect(calls()).toEqual([
		['luna', '第一行\n第二行', '--enter'],
		['nova', 'line one\nline two', '--enter']
	]);
	expect(await sentTo(claude.session_id)).toMatchObject([
		{ kind: 'message', controllerId: claude.session_id, hcomName: 'luna', text: '第一行\n第二行', ok: true, error: null }
	]);
	expect(await sentTo(codex.session_id)).toMatchObject([{ hcomName: 'nova', text: 'line one\nline two', ok: true }]);
});

test('line endings that would submit early are turned into plain new lines', async () => {
	const luna = fixture.bound('alpha', 'luna');
	fixture.list([luna]);

	await send(luna.session_id, 'a\r\nb\rc\n\n');

	// Nothing else changes, trailing blank lines included.
	expect(calls()).toEqual([['luna', 'a\nb\nc\n\n', '--enter']]);
});

test('a closed pane: the reason comes back, the failure is logged, nobody else gets the text and nothing is retried', async () => {
	const luna = fixture.bound('alpha', 'luna');
	const nova = fixture.bound('beta', 'nova');
	fixture.list([luna, nova]);
	plan({ luna: { exit: 1, stdout: "No agent named 'luna'\n  Active: hcom list  |  Stopped: hcom list --stopped\n", stderr: 'update available\n' } });

	const { status, body } = await send(luna.session_id, '還在嗎');

	expect(status).toBe(502);
	expect(body.ok).toBe(false);
	expect(body.reason).toContain("No agent named 'luna'");
	expect(body.reason).not.toContain('update available');
	expect(calls()).toEqual([['luna', '還在嗎', '--enter']]);
	expect(await sentTo(luna.session_id)).toMatchObject([{ text: '還在嗎', ok: false, error: body.reason }]);
	expect(await sentTo(nova.session_id)).toEqual([]);
});

test('an input command that hangs is cut off and reported as a failure', async () => {
	const luna = fixture.bound('alpha', 'luna');
	fixture.list([luna]);
	plan({ luna: { sleepMs: 10_000 } });

	const started = Date.now();
	const { status, body } = await send(luna.session_id, '你好');

	expect(Date.now() - started).toBeLessThan(5_000);
	expect(status).toBe(502);
	expect(body.reason).toContain('逾時');
	expect(calls()).toHaveLength(1);
});

test('an ended controller is refused without running the input command', async () => {
	const workspace = `${fixture.dir}/workspaces/gamma`;
	fixture.report('session-ended', { tag: 'DONE', summary: '交付', hcom_name: 'orin', workspace, final: true });
	fixture.list([]);

	const { status, body } = await send('session-ended', '再改一下');

	expect(status).toBe(409);
	expect(body).toMatchObject({ ok: false, reason: '這個主控已停用 LAT，無法傳話。' });
	expect(calls()).toEqual([]);
	expect(await sentTo('session-ended')).toMatchObject([{ hcomName: 'orin', text: '再改一下', ok: false }]);
});

test('a controller that was unbound after the page last heard of it is refused', async () => {
	const luna = fixture.bound('alpha', 'luna');
	fixture.report(luna.session_id, { tag: 'DONE', summary: '交付', hcom_name: 'luna', workspace: luna.workspace });
	fixture.list([luna]);
	await fixture.refresh(cookie);
	// Changing the helper's answer alone is not a watched change: the board's data still says active.
	fixture.list([]);

	const { status, body } = await send(luna.session_id, '你好');

	expect(status).toBe(409);
	expect(body.reason).toBe('這個主控已停用 LAT，無法傳話。');
	expect(calls()).toEqual([]);
});

test('while the binding registry cannot be read, nothing is sent, not even to a controller last seen running', async () => {
	const luna = fixture.bound('alpha', 'luna');
	fixture.list([luna]);
	await fixture.refresh(cookie);
	fixture.setHelper({ output: { status: 'error', reason: 'invalid bindings file' }, exit: 1 });

	const { status, body } = await send(luna.session_id, '你好');

	expect(status).toBe(409);
	expect(body.reason).toContain('無法確認主控是否仍啟用');
	expect(body.reason).toContain('invalid bindings file');
	expect(calls()).toEqual([]);
	expect(await sentTo(luna.session_id)).toMatchObject([{ hcomName: '', text: '你好', ok: false }]);
});

test('text that cannot be passed to the input command is a logged failure, not a server error', async () => {
	const luna = fixture.bound('alpha', 'luna');
	fixture.list([luna]);

	const { status, body } = await send(luna.session_id, 'a\u0000b');

	expect(status).toBe(502);
	expect(body.ok).toBe(false);
	expect(await sentTo(luna.session_id)).toMatchObject([{ ok: false, error: body.reason }]);
});

test('a controller the board does not know is refused and logged', async () => {
	fixture.list([]);

	const { status, body } = await send('no-such-session', '你好');

	expect(status).toBe(409);
	expect(body.ok).toBe(false);
	expect(calls()).toEqual([]);
	expect(await sentTo('no-such-session')).toMatchObject([{ ok: false, text: '你好' }]);
});

// The messages are free text, so text that looks like a command option goes through unchanged.
// Checked with the board's own request path against a fake that reads arguments like the real command.
const optionLike = ['--help', '--enter', '-x', '-h', '--go', '--name', '--', '--foo', '-', '--enter x', '--help\nsecond line', '--a\n--b\n--c'];
for (const text of optionLike) {
	test(`option-like text ${JSON.stringify(text)} reaches the input box unchanged and is submitted once`, async () => {
		const luna = fixture.bound('alpha', 'luna');
		fixture.list([luna]);

		const { status, body } = await send(luna.session_id, text);

		expect(status).toBe(200);
		expect(body).toMatchObject({ ok: true, reason: null });
		expect(typed()).toEqual({ text, submits: 1 });
		expect(await sentTo(luna.session_id)).toMatchObject([{ text, ok: true, error: null }]);
	});
}

test('ordinary and two-line text still go out as one call with the text as one argument', async () => {
	const luna = fixture.bound('alpha', 'luna');
	fixture.list([luna]);

	await send(luna.session_id, 'hello');
	await send(luna.session_id, 'a\nb');

	expect(calls()).toEqual([
		['luna', 'hello', '--enter'],
		['luna', 'a\nb', '--enter']
	]);
});

test('a failure while delivering option-like text in pieces is reported and logged, with the text kept', async () => {
	const luna = fixture.bound('alpha', 'luna');
	fixture.list([luna]);
	plan({ luna: { exit: 1, stdout: "No agent named 'luna'\n" } });

	const { status, body } = await send(luna.session_id, '--help');

	expect(status).toBe(502);
	expect(body.ok).toBe(false);
	expect(body.reason).toContain("No agent named 'luna'");
	// The first piece failed, so nothing more is tried.
	expect(calls()).toHaveLength(1);
	expect(await sentTo(luna.session_id)).toMatchObject([{ text: '--help', ok: false }]);
});

test('a failure of the second piece is reported and logged, and nothing is retried', async () => {
	const luna = fixture.bound('alpha', 'luna');
	fixture.list([luna]);
	plan({ luna: { exit: 1, failFrom: 2, stdout: "No agent named 'luna'\n" } });

	const { status, body } = await send(luna.session_id, '--help');

	expect(status).toBe(502);
	expect(body.ok).toBe(false);
	expect(body.reason).toContain("No agent named 'luna'");
	expect(calls()).toEqual([['luna', '-'], ['luna', '-help', '--enter']]);
	expect(await sentTo(luna.session_id)).toMatchObject([{ text: '--help', ok: false }]);
});

test('an empty message or a malformed request is rejected and not logged', async () => {
	const luna = fixture.bound('alpha', 'luna');
	fixture.list([luna]);

	expect((await send(luna.session_id, '  \n ')).status).toBe(400);
	expect((await send(luna.session_id, 42)).status).toBe(400);
	expect((await send(undefined, '你好')).status).toBe(400);
	const notJson = await fixture.fetch('/api/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{', cookie });
	expect(notJson.status).toBe(400);
	expect((await fixture.fetch('/api/messages', { cookie })).status).toBe(400);

	expect(calls()).toEqual([]);
	expect(await sentTo(luna.session_id)).toEqual([]);
});

test('the sent log is the same on every paired device, newest first, one controller at a time', async () => {
	const luna = fixture.bound('alpha', 'vela');
	const nova = fixture.bound('beta', 'mira');
	fixture.list([luna, nova]);
	const phone = await fixture.login('phone');

	await send(luna.session_id, '第一則');
	await send(nova.session_id, '給另一個主控');
	await send(luna.session_id, '第二則', phone);

	const onPhone = await sentTo(luna.session_id, phone);
	expect(onPhone.map((entry) => entry.text)).toEqual(['第二則', '第一則']);
	expect(await sentTo(luna.session_id)).toEqual(onPhone);
	expect(new Set(onPhone.map((entry) => entry.id)).size).toBe(2);
});

test('an unpaired browser can neither send nor read the sent log', async () => {
	const luna = fixture.bound('alpha', 'luna');
	fixture.list([luna]);

	const post = await send(luna.session_id, '你好', '');
	const get = await fixture.fetch(`/api/messages?controller=${luna.session_id}`);

	expect(post.status).toBe(401);
	expect(get.status).toBe(401);
	expect(calls()).toEqual([]);
});
