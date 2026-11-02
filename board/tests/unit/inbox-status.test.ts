// `board inbox` against a throwaway state folder: the real data's inbox, with nothing written.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
let dir: string;

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

function writeAsk(id: string, text: string, createdAt: string, deadlineAt: string) {
	writeFileSync(
		join(dir, 'asks', `${id}.json`),
		JSON.stringify({ id, session_id: 's-1', client: 'claude', tool_input: { questions: [{ question: text, options: [] }] }, cwd: '/work/alpha', created_at: createdAt, deadline_at: deadlineAt })
	);
}

function plan(controllers: unknown[]) {
	writeFileSync(join(dir, 'helper.json'), JSON.stringify({ output: { controllers } }));
}

function inbox() {
	return spawnSync(process.execPath, [join(ROOT, 'src/cli.ts'), 'inbox'], {
		env: {
			PATH: process.env.PATH!,
			HOME: dir,
			LAT_BOARD_STATE_DIR: join(dir, 'state'),
			LAT_REPORTS_DIR: join(dir, 'reports'),
			LAT_BOARD_ASKS_DIR: join(dir, 'asks'),
			LAT_HCOM_PAUSED_DIR: join(dir, 'paused'),
			LAT_BOARD_HELPER_COMMAND: JSON.stringify(['node', join(ROOT, 'tests/fake-helper.mjs'), dir]),
			LAT_BOARD_HCOM_COMMAND: JSON.stringify(['node', '-e', 'console.log("[]")'])
		},
		encoding: 'utf8'
	});
}

/** Every file under the folder a read must leave alone, with its time and content. */
function files(folder: string): string[] {
	return readdirSync(folder, { recursive: true, encoding: 'utf8' })
		.filter((name) => statSync(join(folder, name)).isFile())
		.map((name) => `${name} ${statSync(join(folder, name)).mtimeMs} ${readFileSync(join(folder, name), 'utf8')}`);
}

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'lat-board-inbox-status-'));
	for (const name of ['state', 'reports', 'asks', 'paused']) mkdirSync(join(dir, name));
	writeAsk('aaa', 'Still waiting?', hoursAgo(0), new Date(Date.now() + 300_000).toISOString());
	writeAsk('bbb', 'Timed out?', hoursAgo(2), hoursAgo(1));
	writeFileSync(join(dir, 'asks', 'bbb.result.json'), JSON.stringify({ kind: 'timeout', at: hoursAgo(1) }));
	// An unread report past the archive age: the running board would archive it and save that.
	const report = { time: hoursAgo(24 * 8), session_id: 's-2', tag: 'DONE', hcom_name: 'nova', client: 'claude', workspace: '/work/alpha', round: 1, summary: 'Old result', message: '', final: true };
	writeFileSync(join(dir, 'reports', 's-2.jsonl'), JSON.stringify(report) + '\n');
	plan([]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('a waiting ask is in 待辦; a timed-out one and a report due for the archive are processed', () => {
	const result = inbox();
	expect(result.stderr).toBe('');
	expect(result.status).toBe(0);
	const [waiting, ...rest] = result.stdout.trim().split('\n');
	expect(waiting).toBe('待辦 1');
	expect(rest[0]).toContain('提問\talpha\tStill waiting?');
	expect(rest[1]).toBe('已處理 2');
	expect(rest[2]).toContain('已逾時');
});

test('reading changes no file, not even the archive record of a due report', () => {
	const before = [...files(join(dir, 'state')), ...files(join(dir, 'asks')), ...files(join(dir, 'reports'))];
	expect(inbox().status).toBe(0);
	expect([...files(join(dir, 'state')), ...files(join(dir, 'asks')), ...files(join(dir, 'reports'))]).toEqual(before);
	expect(readdirSync(join(dir, 'state'))).toEqual([]);
});

test('data that cannot be read is named and fails the command', () => {
	writeFileSync(join(dir, 'helper.json'), '{}');
	const result = inbox();
	expect(result.status).toBe(1);
	expect(result.stdout).toContain('讀不到：');
	plan([]);
});
