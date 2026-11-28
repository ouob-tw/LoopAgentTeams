// The agent's 任務提案 command without a board (#759): submit and withdraw say 看板沒在執行 and
// write nothing; status and wait read the result files alone; wait stops at its limit with
// 仍在等待. Everything is in a temporary folder; the socket named there never exists.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, uvPython } from '../harness.ts';

const CLI = join(import.meta.dir, '../../../skills/local/task-proposal/scripts/task-proposal.py');
const ID = '0123456789ab';
let dir = '';
let proposals = '';

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'lat-proposal-cli-'));
	proposals = join(dir, 'task-proposals');
	mkdirSync(proposals);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (args: string[], input = '') =>
	runCli(uvPython(), [CLI, ...args], {
		env: { PATH: process.env.PATH ?? '', HOME: join(dir, 'home'), LAT_BOARD_PROPOSALS_DIR: proposals, LAT_BOARD_PROPOSAL_SOCKET: join(dir, 'no-board.sock') },
		input
	});
const put = (name: string, value: unknown) => writeFileSync(join(proposals, name), JSON.stringify(value));
const task = { name: '每天備份', kind: 'command', command: { command: 'echo hi', folder: '/tmp' } };

test('submit and withdraw with no board say 看板沒在執行, exit 3 and write nothing', async () => {
	const sent = await run(['submit'], JSON.stringify(task));
	expect([sent.code, sent.stdout.trim()]).toEqual([3, '看板沒在執行']);
	const taken = await run(['--json', 'withdraw', ID]);
	expect(taken.code).toBe(3);
	expect(JSON.parse(taken.stdout)).toEqual({ ok: false, error: 'offline', reason: '看板沒在執行' });
	expect(readdirSync(proposals)).toEqual([]);
	expect(existsSync(join(dir, 'no-board.sock'))).toBe(false);
});

test('submit checks the basic shape before sending: exit 2 with what is wrong', async () => {
	const notJson = await run(['submit'], '{');
	expect(notJson.code).toBe(2);
	expect(notJson.stdout).toStartWith('提案不是 JSON');
	const missing = await run(['submit'], JSON.stringify({ kind: 'agent' }));
	expect([missing.code, missing.stdout.trim()]).toEqual([2, '提案格式不對：\n- name：請填名稱\n- agent：要是一個物件']);
	const badId = await run(['status', 'XYZ']);
	expect(badId.code).toBe(2);
});

test('status reads the folder: waiting, each result, and an unknown proposal', async () => {
	expect((await run(['status', ID])).stdout.trim()).toBe(`找不到這個提案：${ID}`);
	put(`${ID}.json`, { id: ID });
	expect((await run(['status', ID])).stdout.trim()).toBe(`等待中：${ID}`);
	put(`${ID}.result.json`, { version: 1, id: ID, status: 'invalid', at: '2026-11-28T00:00:00.000Z', errors: { time: '時間請寫成 00:00 到 23:59，例如 09:30' } });
	const invalid = await run(['status', ID]);
	expect([invalid.code, invalid.stdout.trim()]).toEqual([0, `無效：${ID}\n- time：時間請寫成 00:00 到 23:59，例如 09:30`]);
	put(`${ID}.result.json`, { version: 1, id: ID, status: 'rejected', at: '2026-11-28T00:00:00.000Z', reason: '時間改到晚上' });
	expect((await run(['status', ID])).stdout.trim()).toBe(`已拒絕：${ID}\n原因：時間改到晚上`);
	put(`${ID}.result.json`, { version: 1, id: ID, status: 'approved', at: '2026-11-28T00:00:00.000Z', taskId: 'abcdef0123' });
	expect(JSON.parse((await run(['--json', 'status', ID])).stdout)).toMatchObject({ ok: true, id: ID, status: 'approved', taskId: 'abcdef0123' });
});

test('wait returns 仍在等待 at its limit, keeps waiting through 核准中, and returns the result once there', async () => {
	put(`${ID}.json`, { id: ID });
	const started = Date.now();
	const still = await run(['wait', ID, '--timeout', '1']);
	expect([still.code, still.stdout.trim()]).toEqual([4, `仍在等待：${ID}（等了 1 秒）`]);
	expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);

	put(`${ID}.result.json`, { version: 1, id: ID, status: 'approving', at: '2026-11-28T00:00:00.000Z' });
	const waiting = run(['wait', ID, '--timeout', '20']);
	await Bun.sleep(1_200);
	put(`${ID}.result.json`, { version: 1, id: ID, status: 'approved', at: '2026-11-28T00:00:01.000Z', taskId: 'abcdef0123' });
	const done = await waiting;
	expect([done.code, done.stdout.trim()]).toEqual([0, `已核准：${ID}\n任務編號：abcdef0123`]);
});
