// The 自動化 tab's server side on the built board: tasks saved one JSON file each after checking
// every field, 立即執行 of a command task with its record, output and fixed checks, refusal while the
// same task runs, pause and resume, every open page told, and what a restart finds on disk.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { sleep, startFixture, until, type Fixture } from '../harness.ts';
import type { AutomationRun, AutomationSnapshot, AutomationTask } from '../../src/lib/board/automation.ts';

let fixture: Fixture;
let cookie: string;
let work: string;

beforeAll(async () => {
	fixture = await startFixture();
	cookie = await fixture.login();
	work = join(fixture.dir, 'work');
	mkdirSync(join(work, 'docs'), { recursive: true });
	writeFileSync(join(work, 'docs/brief.md'), '# 說明\n');
}, 30_000);
afterAll(async () => {
	await fixture?.cleanup();
});

const automationDir = () => join(fixture.dir, 'board-state/automation');
const taskFiles = () => (existsSync(automationDir()) ? readdirSync(automationDir()).filter((name) => name.endsWith('.json')) : []);
const send = (path: string, method: string, body?: unknown) =>
	fixture.fetch(path, { method, cookie, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const snapshot = async (): Promise<AutomationSnapshot> => (await fixture.fetch('/api/automation', { cookie })).json();
const viewOf = async (id: string) => (await snapshot()).tasks.find((view) => view.task.id === id)!;

function commandTask(overrides: Record<string, unknown> = {}, command: Record<string, unknown> = {}) {
	return {
		name: '每月備份資料庫',
		schedule: { type: 'monthly', fromDay: 1, toDay: 3 },
		time: '03:00',
		limitMinutes: 30,
		kind: 'command',
		command: { command: 'echo OK', folder: work, checks: [], ...command },
		review: { enabled: false, checklist: [] },
		...overrides
	};
}

/** Poll an async read until it gives something. */
async function eventually<T>(read: () => Promise<T | undefined | false>, timeoutMs: number, what: string): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
		await sleep(50);
	}
}

async function create(body: unknown): Promise<AutomationTask> {
	const response = await send('/api/automation', 'POST', body);
	expect(response.status).toBe(201);
	return response.json();
}

/** Start a run and wait for it to end; the run as the board then has it. */
async function runToEnd(id: string): Promise<AutomationRun> {
	const response = await send(`/api/automation/${id}/run`, 'POST');
	expect(response.status).toBe(202);
	const started: AutomationRun = await response.json();
	expect(started.trigger).toBe('manual');
	return eventually(async () => {
		const run = (await viewOf(id)).runs.find((entry) => entry.id === started.id);
		return run && run.status !== 'running' ? run : undefined;
	}, 10_000, 'the run to end');
}

test('a valid task is saved as one JSON file, atomically, and listed', async () => {
	const task = await create(commandTask({ name: '  每月備份資料庫  ', time: '3:00' }));
	expect(task.name).toBe('每月備份資料庫');
	expect(task.time).toBe('03:00');
	expect(task.paused).toBe(false);
	const file = join(automationDir(), `${task.id}.json`);
	expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(task);
	expect(statSync(file).mode & 0o777).toBe(0o600);
	expect(readdirSync(automationDir()).filter((name) => name.endsWith('.tmp'))).toEqual([]);
	const view = await viewOf(task.id);
	expect(view.state).toBe('waiting');
	expect(view.runs).toEqual([]);
	expect(typeof view.nextAt).toBe('number');
});

test('every wrong field is answered by name and nothing is written', async () => {
	const before = taskFiles();
	const errorsOf = async (body: unknown) => {
		const response = await send('/api/automation', 'POST', body);
		expect(response.status).toBe(400);
		return Object.keys((await response.json()).errors).sort();
	};
	expect(await errorsOf(commandTask({ name: ' ' }))).toEqual(['name']);
	expect(await errorsOf(commandTask({ schedule: { type: 'monthly', fromDay: 0, toDay: 5 } }))).toEqual(['days']);
	expect(await errorsOf(commandTask({ schedule: { type: 'monthly', fromDay: 1, toDay: 32 } }))).toEqual(['days']);
	expect(await errorsOf(commandTask({ schedule: { type: 'monthly', fromDay: 6, toDay: 5 } }))).toEqual(['days']);
	expect(await errorsOf(commandTask({ schedule: { type: 'weekly', fromWeekday: 5, toWeekday: 2 } }))).toEqual(['weekdays']);
	expect(await errorsOf(commandTask({ schedule: { type: 'weekly', fromWeekday: 1, toWeekday: 8 } }))).toEqual(['weekdays']);
	expect(await errorsOf(commandTask({ schedule: { type: 'hourly' } }))).toEqual(['schedule']);
	expect(await errorsOf(commandTask({ time: '24:00' }))).toEqual(['time']);
	expect(await errorsOf(commandTask({ time: 'noon' }))).toEqual(['time']);
	expect(await errorsOf(commandTask({ limitMinutes: 0 }))).toEqual(['limitMinutes']);
	expect(await errorsOf(commandTask({ limitMinutes: '1.5' }))).toEqual(['limitMinutes']);
	expect(await errorsOf(commandTask({}, { command: '' }))).toEqual(['command']);
	expect(await errorsOf(commandTask({}, { folder: join(work, 'nowhere') }))).toEqual(['folder']);
	expect(await errorsOf(commandTask({}, { folder: 'relative/path' }))).toEqual(['folder']);
	expect(await errorsOf(commandTask({}, { checks: [{ type: 'file', path: '' }] }))).toEqual(['checks']);
	expect(await errorsOf(commandTask({ kind: undefined }))).toEqual(['kind']);
	expect(await errorsOf(commandTask({ review: { enabled: true, checklist: ['', ' '] } }))).toEqual(['checklist']);
	const agent = { client: 'codex', model: 'gpt-6.1-sol', effort: 'medium', folder: work, brief: 'docs/brief.md' };
	expect(await errorsOf({ ...commandTask(), kind: 'agent', agent: { ...agent, brief: 'docs/none.md' } })).toEqual(['brief']);
	expect(await errorsOf({ ...commandTask(), kind: 'agent', agent: { ...agent, client: 'gemini', model: '', effort: 'max' } })).toEqual(['client', 'effort', 'model']);
	// Several at once, each by its own name.
	expect(await errorsOf({ ...commandTask({ name: '', time: '9', limitMinutes: -1 }) })).toEqual(['limitMinutes', 'name', 'time']);
	expect(taskFiles()).toEqual(before);
});

test('an agent task keeps its fields, and 立即執行 says it cannot run yet', async () => {
	const task = await create({
		...commandTask({ name: '客發展覽維護報告', schedule: { type: 'weekly', fromWeekday: 1, toWeekday: 3 }, time: '09:00' }),
		kind: 'agent',
		command: undefined,
		agent: { client: 'codex', model: 'gpt-6.1-sol', effort: 'medium', folder: work, brief: 'docs/brief.md' },
		review: { enabled: true, checklist: ['PDF 中文與圖片正常', '', '發票已開立'] }
	});
	expect(task.agent).toEqual({ client: 'codex', model: 'gpt-6.1-sol', effort: 'medium', folder: work, brief: 'docs/brief.md' });
	expect(task.command).toBeUndefined();
	// The checking agent defaults to the other client than the task's own.
	expect(task.review).toEqual({ enabled: true, checklist: ['PDF 中文與圖片正常', '發票已開立'], client: 'claude', model: 'claude-opus-5-5', effort: 'medium' });
	const refused = await send(`/api/automation/${task.id}/run`, 'POST');
	expect(refused.status).toBe(409);
	expect((await refused.json()).message).toContain('Agent 任務');
	expect((await viewOf(task.id)).runs).toEqual([]);
});

test('the checking agent\'s client, model and effort are saved as chosen, and checked', async () => {
	const task = await create(commandTask({ name: '檢查設定', review: { enabled: true, checklist: ['備份檔存在'], client: 'claude', model: 'claude-sonnet-5-5', effort: 'high' } }));
	expect(task.review).toEqual({ enabled: true, checklist: ['備份檔存在'], client: 'claude', model: 'claude-sonnet-5-5', effort: 'high' });
	expect((await viewOf(task.id)).task.review.model).toBe('claude-sonnet-5-5');
	// A command task's checker is Codex unless chosen.
	expect((await create(commandTask({ name: '檢查預設' }))).review).toMatchObject({ client: 'codex', model: 'gpt-6.1-sol', effort: 'medium' });
	const wrong = await send('/api/automation', 'POST', commandTask({ review: { enabled: true, checklist: ['x'], client: 'gemini', model: ' ', effort: 'max' } }));
	expect(Object.keys((await wrong.json()).errors).sort()).toEqual(['reviewClient', 'reviewEffort', 'reviewModel']);
	// With the check off, a blank or unusable checker setting is not an error: it falls back to the default.
	const off = await create(commandTask({ name: '檢查關閉', review: { enabled: false, checklist: [], client: 'gemini', model: ' ', effort: 'max' } }));
	expect(off.review).toEqual({ enabled: false, checklist: [], client: 'codex', model: 'gpt-6.1-sol', effort: 'medium' });
});

test('立即執行 records how a command ended: start and end, exit code, output, each check', async () => {
	const task = await create(commandTask({ name: '成功的指令' }, { command: 'echo start; echo 備份 OK; touch made.txt', checks: [{ type: 'file', path: 'made.txt' }, { type: 'output', text: '備份 OK' }] }));
	const run = await runToEnd(task.id);
	expect(run.status).toBe('success');
	expect(run.exitCode).toBe(0);
	expect(run.trigger).toBe('manual');
	expect(run.endedAt!).toBeGreaterThanOrEqual(run.startedAt);
	expect(run.checks).toEqual([
		{ label: '檔案存在：made.txt', ok: true },
		{ label: '輸出含「備份 OK」', ok: true }
	]);
	expect(run.output).toBe(`output/${task.id}/${run.id}.txt`);
	expect(run.outputTruncated).toBe(false);
	const output = await fixture.fetch(`/api/automation/${task.id}/runs/${run.id}/output`, { cookie });
	expect(await output.text()).toBe('start\n備份 OK\n');
	expect(readFileSync(join(automationDir(), run.output!), 'utf8')).toBe('start\n備份 OK\n');
	expect((await viewOf(task.id)).state).toBe('done');
	// The record file grows: a line when the run started and one when it ended.
	const lines = readFileSync(join(automationDir(), 'runs', `${task.id}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
	expect(lines[0]).toMatchObject({ id: run.id, status: 'running', trigger: 'manual', startedAt: run.startedAt });
	expect(lines.at(-1)).toMatchObject({ id: run.id, status: 'success', exitCode: 0 });
});

test('a non-zero exit fails, and so does a check that does not pass after exit 0', async () => {
	const exits = await create(commandTask({ name: '回傳錯誤' }, { command: 'echo broke >&2; exit 3' }));
	const exited = await runToEnd(exits.id);
	expect(exited.status).toBe('failed');
	expect(exited.exitCode).toBe(3);
	expect(await (await fixture.fetch(`/api/automation/${exits.id}/runs/${exited.id}/output`, { cookie })).text()).toBe('broke\n');
	expect((await viewOf(exits.id)).state).toBe('failed');

	const misses = await create(commandTask({ name: '檢查沒過' }, { command: 'echo done', checks: [{ type: 'file', path: 'never.txt' }, { type: 'output', text: 'done' }] }));
	const missed = await runToEnd(misses.id);
	expect(missed.status).toBe('failed');
	expect(missed.exitCode).toBe(0);
	expect(missed.checks).toEqual([
		{ label: '檔案存在：never.txt', ok: false, detail: '找不到這個檔案' },
		{ label: '輸出含「done」', ok: true }
	]);
});

test('a long output keeps its end only, and says so', async () => {
	const task = await create(commandTask({ name: '很長的輸出' }, { command: `head -c 100000 /dev/zero | tr '\\0' 'a'; echo; echo THE-END`, checks: [{ type: 'output', text: 'THE-END' }] }));
	const run = await runToEnd(task.id);
	expect(run.status).toBe('success');
	expect(run.outputTruncated).toBe(true);
	const kept = await (await fixture.fetch(`/api/automation/${task.id}/runs/${run.id}/output`, { cookie })).text();
	expect(kept.length).toBeLessThan(33_000);
	expect(kept.startsWith('（前面省略 ')).toBe(true);
	expect(kept.endsWith('THE-END\n')).toBe(true);
});

test('an output check finds text printed long before the kept end, and a character split between writes', async () => {
	const task = await create(
		commandTask({ name: '早印的字' }, {
			command: `printf 'BACKUP_OK\\n'; head -c 4200000 /dev/zero | tr '\\0' 'x'; echo; printf '\\345\\256'; sleep 0.3; printf '\\214\\346\\210\\220\\n'`,
			checks: [{ type: 'output', text: 'BACKUP_OK' }, { type: 'output', text: '完成' }]
		})
	);
	const run = await runToEnd(task.id);
	expect(run.checks).toEqual([
		{ label: '輸出含「BACKUP_OK」', ok: true },
		{ label: '輸出含「完成」', ok: true }
	]);
	expect(run.status).toBe('success');
	const kept = await (await fixture.fetch(`/api/automation/${task.id}/runs/${run.id}/output`, { cookie })).text();
	expect(kept).not.toContain('BACKUP_OK');
	expect(kept.endsWith('完成\n')).toBe(true);
	expect(kept).not.toContain('\uFFFD');
});

test('what a command leaves running in the background ends with the run', async () => {
	const task = await create(commandTask({ name: '背景程序' }, { command: 'sleep 600 >/dev/null 2>&1 & echo $! > bg.pid' }));
	const run = await runToEnd(task.id);
	expect(run.status).toBe('success');
	const pid = Number(readFileSync(join(work, 'bg.pid'), 'utf8'));
	await eventually(async () => !existsSync(`/proc/${pid}`), 10_000, 'the background sleep to end');

	// One that ignores the polite stop is killed before the run counts as over, so a next run cannot overlap it.
	const stubborn = await create(commandTask({ name: '不肯停的背景程序' }, { command: `(trap '' TERM; sleep 600) >/dev/null 2>&1 & echo $! > stubborn.pid` }));
	const ended = await runToEnd(stubborn.id);
	expect(ended.status).toBe('success');
	expect(existsSync(`/proc/${Number(readFileSync(join(work, 'stubborn.pid'), 'utf8'))}`)).toBe(false);
}, 30_000);

test('立即執行 is refused, with the reason, while the same task runs', async () => {
	const task = await create(commandTask({ name: '跑很久' }, { command: 'sleep 2; echo done' }));
	expect((await send(`/api/automation/${task.id}/run`, 'POST')).status).toBe(202);
	expect((await viewOf(task.id)).state).toBe('running');
	const refused = await send(`/api/automation/${task.id}/run`, 'POST');
	expect(refused.status).toBe(409);
	expect((await refused.json()).message).toMatch(/正在跑.*等這次結束再執行/);
	await eventually(async () => (await viewOf(task.id)).state === 'done', 10_000, 'the run to end');
	expect((await viewOf(task.id)).runs).toHaveLength(1);
});

test('a folder gone since saving makes the run a settings error, not a crash', async () => {
	const folder = join(work, 'soon-gone');
	mkdirSync(folder);
	const task = await create(commandTask({ name: '資料夾被刪' }, { folder }));
	(await import('node:fs')).rmSync(folder, { recursive: true });
	const response = await send(`/api/automation/${task.id}/run`, 'POST');
	expect(response.status).toBe(202);
	const run = (await viewOf(task.id)).runs[0];
	expect(run.status).toBe('config-error');
	expect(run.reason).toContain('找不到工作資料夾');
});

test('pause shows paused with no next run; resume brings back the state it had', async () => {
	const task = await create(commandTask({ name: '暫停測試' }));
	await runToEnd(task.id);
	expect((await viewOf(task.id)).state).toBe('done');
	const paused = await send(`/api/automation/${task.id}/pause`, 'POST', { paused: true });
	expect(paused.status).toBe(200);
	expect((await viewOf(task.id)).state).toBe('paused');
	expect((await viewOf(task.id)).nextAt).toBeNull();
	expect(JSON.parse(readFileSync(join(automationDir(), `${task.id}.json`), 'utf8')).paused).toBe(true);
	// Editing keeps it paused.
	expect((await send(`/api/automation/${task.id}`, 'PUT', commandTask({ name: '暫停測試（改名）' }))).status).toBe(200);
	expect((await viewOf(task.id)).state).toBe('paused');
	await send(`/api/automation/${task.id}/pause`, 'POST', { paused: false });
	const back = await viewOf(task.id);
	expect(back.state).toBe('done');
	expect(back.task.name).toBe('暫停測試（改名）');
	expect((await send(`/api/automation/${task.id}/pause`, 'POST', { paused: 'yes' })).status).toBe(400);
	expect((await send('/api/automation/nope/pause', 'POST', { paused: true })).status).toBe(404);
});

test('an edit with a wrong field leaves the saved file as it was', async () => {
	const task = await create(commandTask({ name: '不能改壞' }));
	const file = join(automationDir(), `${task.id}.json`);
	const before = readFileSync(file, 'utf8');
	const response = await send(`/api/automation/${task.id}`, 'PUT', commandTask({ schedule: { type: 'monthly', fromDay: 9, toDay: 2 } }));
	expect(response.status).toBe(400);
	expect((await response.json()).errors.days).toBe('開始日不能晚於結束日');
	expect(readFileSync(file, 'utf8')).toBe(before);
});

test('a change on one device and a run’s progress reach every open page within 5 seconds', async () => {
	const other = await fixture.login('second-device');
	const mine = fixture.watch(cookie);
	const theirs = fixture.watch(other);
	await until(() => mine.automations.length && theirs.automations.length, 5_000, 'both pages to connect');
	const task = await create(commandTask({ name: '推播測試' }, { command: 'sleep 1; echo hi' }));
	const has = (page: typeof mine, check: (snapshot: AutomationSnapshot) => boolean) => () => page.automations.some(check);
	await until(has(theirs, (s) => s.tasks.some((view) => view.task.name === '推播測試')), 5_000, 'the other page to hear of the new task');
	await send(`/api/automation/${task.id}/run`, 'POST');
	await until(has(theirs, (s) => s.tasks.some((view) => view.task.id === task.id && view.state === 'running')), 5_000, 'the other page to hear it runs');
	await until(has(theirs, (s) => s.tasks.some((view) => view.task.id === task.id && view.state === 'done')), 5_000, 'the other page to hear it ended');
	await until(has(mine, (s) => s.tasks.some((view) => view.task.id === task.id && view.state === 'done')), 5_000, 'this page too');
	mine.close();
	theirs.close();
});

test('only a logged-in device reads or changes tasks', async () => {
	expect((await fixture.fetch('/api/automation')).status).toBe(401);
	expect((await fixture.fetch('/api/automation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(commandTask()) })).status).toBe(401);
});

test('after a restart: a broken file is an error, a half-written temporary is ignored, a run cut off is failed', async () => {
	const task = await create(commandTask({ name: '重啟前' }));
	await fixture.stop();
	writeFileSync(join(automationDir(), 'broken1234.json'), '{"id": "broken1234", "name": "壞');
	writeFileSync(join(automationDir(), 'abcdef0123.json.4242.ab12cd.tmp'), '{"id": "abcdef0123", "na');
	writeFileSync(join(automationDir(), 'nested0001.json'), JSON.stringify({ ...commandTask({ name: '少欄位' }, { folder: undefined }), id: 'nested0001', paused: false, createdAt: 'x', updatedAt: 'x' }));
	appendFileSync(join(automationDir(), 'runs', `${task.id}.jsonl`), JSON.stringify({ id: 'cut-1', taskId: task.id, trigger: 'manual', period: '2026-11', startedAt: Date.now(), status: 'running', pid: 999999 }) + '\n' + '{"id":"torn');
	await fixture.start();
	const after = await snapshot();
	expect(after.broken).toEqual([
		{ file: 'broken1234.json', error: expect.stringContaining('不是完整的 JSON') },
		{ file: 'nested0001.json', error: '欄位不對：folder' }
	]);
	expect(after.tasks.some((view) => view.task.id === 'abcdef0123')).toBe(false);
	const view = after.tasks.find((entry) => entry.task.id === task.id)!;
	expect(view.task.name).toBe('重啟前');
	expect(view.runs[0]).toMatchObject({ id: 'cut-1', status: 'failed', reason: '看板重啟中斷' });
	expect(view.state).toBe('failed');

	// The line cut off by the crash did not swallow the one written after it: the record file has it
	// on a line of its own, a second restart still reads it, and a new run is recorded whole.
	const lines = readFileSync(join(automationDir(), 'runs', `${task.id}.jsonl`), 'utf8').split('\n');
	expect(lines.some((line) => line.startsWith('{') && line.includes('"cut-1"') && line.includes('看板重啟中斷') && !line.includes('torn'))).toBe(true);
	await fixture.stop();
	await fixture.start();
	const again = (await snapshot()).tasks.find((entry) => entry.task.id === task.id)!;
	expect(again.runs[0]).toMatchObject({ id: 'cut-1', status: 'failed', reason: '看板重啟中斷' });
	const next = await runToEnd(task.id);
	expect(next.status).toBe('success');
	await fixture.stop();
	await fixture.start();
	expect((await viewOf(task.id)).runs.map((entry) => [entry.id, entry.status])).toEqual([
		[next.id, 'success'],
		['cut-1', 'failed']
	]);
});
