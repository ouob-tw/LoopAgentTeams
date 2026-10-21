// What each caller of an outside command tells the page when the command fails, runs out of time
// or prints something that is not JSON: word for word what it said before the commands were run
// one way (runCommand).
import { expect, test } from 'bun:test';
import type { BoardConfig } from '../src/lib/server/config.ts';
import { launchAgent, listAgents, listStops, resumeAgent } from '../src/lib/server/hcom.ts';
import {
	listControllers,
	notifyController,
	pruneReports,
	readAnswered,
	readLaunchArgs,
	readQuestions,
	readTranscript
} from '../src/lib/server/helper.ts';
import { chooseWorkspace, closePane } from '../src/lib/server/herdr.ts';
import { readClaudeQuota } from '../src/lib/server/quota.ts';
import { inject } from '../src/lib/server/send.ts';
import { NODE } from './harness.ts';

const node = (script: string) => [NODE, '-e', script];
/** Says something on both streams and fails. */
const FAILS = node(`process.stdout.write('out one\\nout two\\n'); process.stderr.write('notice\\nboom\\n'); process.exit(1)`);
const HANGS = node('setTimeout(() => {}, 60000)');
const NOT_JSON = node(`process.stdout.write('not json\\n')`);
const SILENT = node('process.exit(3)');

const config = (overrides: Partial<BoardConfig>) =>
	({
		helperTimeoutMs: 300,
		hcomTimeoutMs: 300,
		hcomListTimeoutMs: 300,
		herdrTimeoutMs: 300,
		injectTimeoutMs: 300,
		reportsDir: '/nonexistent/reports',
		...overrides
	}) as BoardConfig;

test('the panel helper', async () => {
	const helper = (helperCommand: string[]) => config({ helperCommand });
	for (const read of [
		(c: BoardConfig) => listControllers(c),
		(c: BoardConfig) => readAnswered(c, { paths: ['/nonexistent/q.md'], controllers: [] }),
		(c: BoardConfig) => readTranscript(c, 'claude', 'session-1')
	]) {
		expect(await read(helper(FAILS))).toMatchObject({ ok: false, reason: 'boom' });
		expect(await read(helper(HANGS))).toMatchObject({ ok: false, reason: '輔助工具逾時（0.3 秒）' });
		expect(await read(helper(NOT_JSON))).toMatchObject({ ok: false, reason: '輔助工具的輸出不是 JSON' });
		expect(await read(helper(SILENT))).toMatchObject({ ok: false, reason: '輔助工具結束碼 3' });
	}
	for (const read of [(c: BoardConfig) => readLaunchArgs(c, 'session-1'), (c: BoardConfig) => pruneReports(c, 0, ['session-1'])]) {
		expect(await read(helper(FAILS))).toMatchObject({ reason: 'boom' });
		expect(await read(helper(HANGS))).toMatchObject({ reason: '輔助工具逾時（0.3 秒）' });
		expect(await read(helper(NOT_JSON))).toMatchObject({ reason: '輔助工具的輸出不是預期的格式' });
	}
	const notify = (helperCommand: string[]) => notifyController(helper(helperCommand), '/nonexistent/q.md');
	expect(await notify(FAILS)).toEqual({ status: 'error', reason: 'boom', notified: null });
	expect(await notify(HANGS)).toEqual({ status: 'error', reason: '輔助工具逾時（0.3 秒）', notified: null });
	expect(await notify(NOT_JSON)).toEqual({ status: 'error', reason: '輔助工具的輸出不是預期的格式', notified: null });
	for (const command of [FAILS, HANGS, NOT_JSON]) expect(await readQuestions(helper(command), '/nonexistent/q.md')).toBeNull();
});

test('hcom', async () => {
	const hcom = (hcomCommand: string[]) => config({ hcomCommand });
	expect(await listAgents(hcom(FAILS))).toEqual({ ok: false, reason: 'hcom 的 Agent 清單讀不到：boom' });
	expect(await listAgents(hcom(HANGS))).toEqual({ ok: false, reason: 'hcom 的 Agent 清單讀不到：逾時（0.3 秒）' });
	expect(await listAgents(hcom(NOT_JSON))).toEqual({ ok: false, reason: 'hcom 的 Agent 清單不是預期的 JSON' });
	expect(await listStops(hcom(FAILS), 0)).toEqual({ ok: false, reason: 'hcom 的停止紀錄讀不到：boom' });
	expect(await listStops(hcom(HANGS), 0)).toEqual({ ok: false, reason: 'hcom 的停止紀錄讀不到：逾時（0.3 秒）' });
	expect(await listStops(hcom(NOT_JSON), 0)).toEqual({ ok: false, reason: 'hcom 的停止紀錄不是預期的 JSON' });
	const launch = (hcomCommand: string[]) =>
		launchAgent(hcom(hcomCommand), { client: 'claude', folder: '/nonexistent', herdrWorkspace: 'w1', prompt: '', extraArgs: [] });
	expect(await launch(FAILS)).toEqual({ outcome: 'failed', hcomName: null, reason: 'hcom 啟動失敗：boom' });
	expect(await launch(HANGS)).toEqual({ outcome: 'pending', hcomName: null, reason: 'hcom 啟動指令逾時（0.3 秒），分頁可能已經開了' });
	const resume = (hcomCommand: string[]) => resumeAgent(hcom(hcomCommand), { sessionId: 'session-1', herdrWorkspace: 'w1', prompt: '', extraArgs: [] });
	expect(await resume(FAILS)).toEqual({ outcome: 'failed', hcomName: null, reason: 'hcom 接回失敗：boom' });
	expect(await resume(HANGS)).toEqual({ outcome: 'pending', hcomName: null, reason: 'hcom 接回指令逾時（0.3 秒），分頁可能已經開了' });
});

test('Herdr', async () => {
	const herdr = (herdrCommand: string[]) => config({ herdrCommand });
	expect(await chooseWorkspace(herdr(FAILS), '/nonexistent')).toEqual({ ok: false, reason: '讀不到 Herdr 的窗格清單：boom' });
	expect(await chooseWorkspace(herdr(HANGS), '/nonexistent')).toEqual({ ok: false, reason: '讀不到 Herdr 的窗格清單：逾時（0.3 秒）' });
	expect(await chooseWorkspace(herdr(NOT_JSON), '/nonexistent')).toEqual({ ok: false, reason: '讀不到 Herdr 的窗格清單：輸出不是預期的 JSON' });
	expect(await closePane(herdr(FAILS), 'p1')).toEqual({ ok: false, timedOut: false, code: null, reason: 'boom' });
	expect(await closePane(herdr(HANGS), 'p1')).toEqual({ ok: false, timedOut: true, code: null, reason: '逾時（0.3 秒）' });
	const refused = node(`process.stderr.write(JSON.stringify({ error: { code: 'pane_not_found', message: 'no such pane' } })); process.exit(1)`);
	expect(await closePane(herdr(refused), 'p1')).toEqual({ ok: false, timedOut: false, code: 'pane_not_found', reason: 'no such pane' });
});

test('claude-swap', async () => {
	expect(await readClaudeQuota(FAILS, 300)).toEqual({ ok: false, reason: 'claude-swap 沒有回答（結束碼 1）' });
	expect(await readClaudeQuota(HANGS, 300)).toEqual({ ok: false, reason: 'claude-swap 沒有回答（逾時）' });
	expect(await readClaudeQuota(NOT_JSON, 300)).toEqual({ ok: false, reason: 'claude-swap 沒有回答（結束碼 0）' });
	expect(await readClaudeQuota(['/nonexistent/cswap'], 300)).toEqual({ ok: false, reason: '找不到或無法啟動 cswap 指令' });
});

test('the input command', async () => {
	const typing = (injectCommand: string[]) => inject(config({ injectCommand }), 'rufe', 'hello');
	expect(await typing(FAILS)).toBe('輸入到 @rufe 的分頁失敗：out one');
	expect(await typing(node(`process.stderr.write('notice\\nboom\\n'); process.exit(1)`))).toBe('輸入到 @rufe 的分頁失敗：boom');
	expect(await typing(HANGS)).toBe('輸入指令逾時（0.3 秒），文字可能已經打進輸入框但沒有送出。');
});
