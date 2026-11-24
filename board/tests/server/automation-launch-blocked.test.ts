// An agent task whose agent never starts (#702), on the built board against the fake hcom and a fake
// push service on this host (LAT_BOARD_PUSH_TEST_ORIGIN): a launch hcom records as `launch_blocked`
// (the folder trust prompt), and one hcom lists with no session past NO_SESSION_MINUTES, each end
// the run as failed with its reason, make one red failure card and send exactly one push to the
// subscribed device with the task's name and the card's sentence, the same as any other failure.
// Nothing here starts a real agent.
import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { jsonLines, sleep, startFixture, type Fixture } from '../harness.ts';
import type { AlertsSnapshot, AutomationAlert } from '../../src/lib/board/alerts.ts';
import type { AutomationRun, AutomationSnapshot, AutomationTask } from '../../src/lib/board/automation.ts';
import { NEVER_STARTED, NO_SESSION_MINUTES, blockedReason } from '../../src/lib/server/automation-agent.ts';

const tpe = (year: number, month: number, day: number, hour = 12, minute = 0) => Date.UTC(year, month - 1, day, hour - 8, minute);
const START = tpe(2026, 11, 24, 0, 9);
const TRUST_SCREEN =
	'launch blocked: screen settled but the hcom plugin never connected; run `hcom term mitoza`\nhere.\nSecurity guide\n❯ No, exit\nYes, I trust this folder\nEnter to confirm · Esc to cancel';

// The fake push service: what the board pushes to the subscribed device.
const pushes: Buffer[] = [];
const pushService = Bun.serve({
	port: 0,
	hostname: '127.0.0.1',
	async fetch(request) {
		pushes.push(Buffer.from(await request.arrayBuffer()));
		return new Response(null, { status: 201 });
	}
});
const PUSH_ORIGIN = `http://127.0.0.1:${pushService.port}`;
const pushKeys = (() => {
	const ecdh = createECDH('prime256v1');
	const publicKey = ecdh.generateKeys();
	const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
	return { ecdh, auth, json: { p256dh: Buffer.from(publicKey).toString('base64url'), auth: auth.toString('base64url') } };
})();
/** A push as the device reads it: RFC 8291 undone with its private key. */
function openPush(body: Buffer): Record<string, string> {
	const salt = body.subarray(0, 16);
	const asPublic = body.subarray(21, 21 + body[20]);
	const sealed = body.subarray(21 + body[20]);
	const ikm = Buffer.from(hkdfSync('sha256', pushKeys.ecdh.computeSecret(asPublic), pushKeys.auth, Buffer.concat([Buffer.from('WebPush: info\0'), pushKeys.ecdh.getPublicKey(), asPublic]), 32));
	const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
	const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
	const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
	decipher.setAuthTag(sealed.subarray(sealed.length - 16));
	const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
	return JSON.parse(plain.subarray(0, -1).toString('utf8'));
}

let fixture: Fixture;
let cookie: string;
let work: string;
let dir: string;

beforeAll(async () => {
	fixture = await startFixture({ env: { TZ: 'UTC', LAT_BOARD_AUTOMATION_TICK_SECONDS: '0.1', LAT_BOARD_AUTOMATION_AGENT_POLL_SECONDS: '0.1', LAT_BOARD_LAUNCH_WAIT_SECONDS: '3', LAT_BOARD_HCOM_TIMEOUT_SECONDS: '3', LAT_BOARD_PUSH_TEST_ORIGIN: PUSH_ORIGIN, LAT_BOARD_URL: 'https://board.example.test' } });
	dir = fixture.dir;
	fixture.setClock(START);
	work = join(dir, 'work');
	mkdirSync(join(work, 'docs'), { recursive: true });
	writeFileSync(join(work, 'docs/brief.md'), '# 任務\n');
	cookie = await fixture.login();
	expect((await send('/api/push/subscription', 'PUT', { endpoint: `${PUSH_ORIGIN}/push/phone`, keys: pushKeys.json })).status).toBeLessThan(300);
});
afterAll(async () => {
	await fixture.cleanup();
	pushService.stop(true);
});
beforeEach(() => {
	fixture.setClock(START);
	for (const name of ['hcom-calls.jsonl', 'hcom.json', 'hcom-added.json', 'hcom-events.jsonl']) rmSync(join(dir, name), { force: true });
	writeFileSync(
		join(dir, 'herdr.json'),
		JSON.stringify({
			workspaces: [
				{ workspace_id: 'wW', number: 1, label: 'Work' },
				{ workspace_id: 'wA', number: 2, label: 'AUTOMATION' }
			],
			tabs: [{ tab_id: 'wW:t0', label: 'shell', workspace_id: 'wW' }],
			panes: [{ pane_id: 'wW:p0', workspace_id: 'wW', cwd: work, tab_id: 'wW:t0' }],
			agents: []
		})
	);
});

async function authed(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
	const response = await fixture.fetch(path, { ...init, cookie });
	if (response.status !== 401) return response;
	cookie = await fixture.login();
	return fixture.fetch(path, { ...init, cookie });
}
const send = (path: string, method: string, body?: unknown) =>
	authed(path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const runsOf = async (id: string): Promise<AutomationRun[]> => ((await (await authed('/api/automation')).json()) as AutomationSnapshot).tasks.find((view) => view.task.id === id)!.runs;
const alerts = async (): Promise<AutomationAlert[]> => ((await (await authed('/api/alerts')).json()) as AlertsSnapshot).alerts;

async function eventually<T>(read: () => Promise<T | undefined | false>, what: string, timeoutMs = 8_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(100);
	}
}

/** One launch whose agent hcom lists with no session and nothing running in Herdr, as a launch stuck on a prompt is. */
function stuckLaunch(name: string) {
	writeFileSync(join(dir, 'hcom.json'), JSON.stringify({ names: [name], agents: [], launched: [{ name, session_id: null, status: 'blocked', tool: 'claude' }], launchedHerdr: [null] }));
}

async function startTask(name: string): Promise<{ task: AutomationTask; run: AutomationRun }> {
	const created = await send('/api/automation', 'POST', {
		name,
		schedule: { type: 'monthly', fromDay: 1, toDay: 2 },
		time: '02:00',
		limitMinutes: 180,
		kind: 'agent',
		agent: { client: 'claude', model: 'claude-haiku-5-5', effort: 'low', folder: work, brief: 'docs/brief.md' },
		review: { enabled: false, checklist: [] }
	});
	expect(created.status).toBe(201);
	const task: AutomationTask = await created.json();
	const response = await send(`/api/automation/${task.id}/run`, 'POST');
	expect(response.status).toBe(202);
	return { task, run: await response.json() };
}

/** Whether the stuck agent was ended with `hcom kill`. */
const killed = (agent: string) => (jsonLines(join(dir, 'hcom-calls.jsonl')) as { args: string[] }[]).some((call) => call.args[0] === 'kill' && call.args[1] === agent);

/** The run once it ended, its card, and the pushes the device got for that card (after a short wait for strays). */
async function failure(task: AutomationTask, runId: string, from: number) {
	const run = await eventually(async () => (await runsOf(task.id)).find((each) => each.id === runId && each.status !== 'running'), 'the run to end');
	const card = await eventually(async () => (await alerts()).find((alert) => alert.runId === runId && alert.pushed), 'the red card pushed');
	await sleep(500);
	const cards = (await alerts()).filter((alert) => alert.runId === runId);
	const ours = pushes.slice(from).map(openPush).filter((push) => push.alert === card.id);
	return { run, card, cards, ours, all: pushes.slice(from).map(openPush) };
}

test('a launch hcom records as blocked on the trust prompt: failed with the prompt named, one red card, one push', async () => {
	const from = pushes.length;
	stuckLaunch('mitoza');
	writeFileSync(join(dir, 'hcom-events.jsonl'), JSON.stringify({ id: 603615, type: 'life', instance: 'mitoza', ts: new Date(START).toISOString().replace(/\.\d+Z$/, ''), data: { action: 'launch_blocked', context: 'launch_blocked', detail: TRUST_SCREEN, reason: 'screen_settled_not_ready', status: 'blocked' } }) + '\n');
	const { task, run: started } = await startTask('主機安全檢查');
	const { run, card, cards, ours, all } = await failure(task, started.id, from);
	expect(run).toMatchObject({ status: 'failed', reason: blockedReason(TRUST_SCREEN) });
	expect(run.reason).toContain('Yes, I trust this folder');
	expect(killed(run.agentName!)).toBe(true);
	expect(cards).toHaveLength(1);
	expect(card).toMatchObject({ kind: 'failed', taskName: '主機安全檢查', summary: '這次執行失敗' });
	expect(ours).toEqual([{ title: '主機安全檢查', body: '這次執行失敗', alert: card.id }]);
	expect(all).toHaveLength(1);
});

test('an agent with no session NO_SESSION_MINUTES after its launch: failed as never started, one red card, one push', async () => {
	const from = pushes.length;
	stuckLaunch('nosesa');
	const { task, run: started } = await startTask('沒有啟動的任務');
	const launched = await eventually(async () => (await runsOf(task.id)).find((each) => each.id === started.id && each.agentName), 'the launch');
	expect(launched.launchedAt).toBe(START);
	// Still waiting short of the limit.
	fixture.setClock(START + (NO_SESSION_MINUTES - 1) * 60_000);
	await sleep(600);
	expect((await runsOf(task.id)).find((each) => each.id === started.id)!.status).toBe('running');
	expect(pushes.length).toBe(from);
	fixture.setClock(START + NO_SESSION_MINUTES * 60_000);
	const { run, card, cards, ours, all } = await failure(task, started.id, from);
	expect(run).toMatchObject({ status: 'failed', reason: NEVER_STARTED });
	expect(killed(run.agentName!)).toBe(true);
	expect(cards).toHaveLength(1);
	expect(card).toMatchObject({ kind: 'failed', taskName: '沒有啟動的任務', summary: '這次執行失敗' });
	expect(ours).toEqual([{ title: '沒有啟動的任務', body: '這次執行失敗', alert: card.id }]);
	expect(all).toHaveLength(1);
});
