// Translating conversation replies through the board server, with a fake Codex app server: login
// required, one line per text as it is ready, saved translations reused after a restart, expired
// ones translated again, and failures sent as reasons.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DAY, NODE, startFixture, type Fixture } from './harness.ts';

const ROOT = join(import.meta.dir, '..');
const codexDir = mkdtempSync(join(tmpdir(), 'lat-board-codex-'));
const START = Date.parse('2026-10-21T00:00:00Z');

let fixture: Fixture;
let cookie: string;

beforeAll(async () => {
	fixture = await startFixture(67, {
		env: {
			LAT_BOARD_TRANSLATE_TIMEOUT_SECONDS: '2',
			LAT_BOARD_TRANSLATE_COMMAND: JSON.stringify([NODE, join(ROOT, 'tests/fake-codex.mjs'), codexDir])
		}
	});
	fixture.setClock(START);
	cookie = await fixture.login();
});

afterAll(async () => {
	await fixture.cleanup();
	rmSync(codexDir, { recursive: true, force: true });
});

beforeEach(() => {
	codexPlan({ prefix: '譯：' });
	rmSync(join(codexDir, 'codex-calls.jsonl'), { force: true });
});

const codexPlan = (plan: object) => writeFileSync(join(codexDir, 'codex.json'), JSON.stringify(plan));
const codexCalls = (): { text: string; model: string; effort: string }[] => {
	const file = join(codexDir, 'codex-calls.jsonl');
	return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
};

const ask = (texts: unknown, useCookie = cookie) =>
	fixture.fetch('/api/translate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ texts }), cookie: useCookie });

async function lines(texts: string[]): Promise<Record<number, { text?: string; error?: string }>> {
	const response = await ask(texts);
	expect(response.status).toBe(200);
	expect(response.headers.get('content-type')).toStartWith('application/x-ndjson');
	const result: Record<number, { text?: string; error?: string }> = {};
	for (const line of (await response.text()).trim().split('\n')) {
		const { index, ...rest } = JSON.parse(line);
		result[index] = rest;
	}
	return result;
}

test('a device that is not logged in cannot translate', async () => {
	expect((await ask(['Hello there friend.'], '')).status).toBe(401);
	expect(codexCalls()).toEqual([]);
});

test('a request that is not a list of texts is refused', async () => {
	for (const texts of [[], 'text', [1], [''], Array(51).fill('x')]) expect((await ask(texts)).status).toBe(400);
	expect(codexCalls()).toEqual([]);
});

test('a reply too long to translate fails alone; the others in its request are translated', async () => {
	const long = 'word '.repeat(4001);
	expect(await lines(['First short reply.', long, 'Last short reply.'])).toEqual({
		0: { text: '譯：First short reply.' },
		1: { error: '太長，不翻譯（超過 20000 字）' },
		2: { text: '譯：Last short reply.' }
	});
	expect(codexCalls()).toHaveLength(2);
});

test('each text is translated by gpt-6-luna at low effort, its code, links, paths and Markdown kept', async () => {
	const reply = '## Summary\n\n- Ran `bun test` in /home/u/board\n- See https://example.com/a\n\n```sh\ngit status\n```';
	const got = await lines([reply, 'A second plain reply.']);
	expect(got[0].text).toBe(`譯：${reply}`);
	expect(got[1].text).toBe('譯：A second plain reply.');
	const calls = codexCalls();
	expect(calls).toHaveLength(2);
	expect(calls.every((call) => call.model === 'gpt-6-luna' && call.effort === 'low')).toBe(true);
	// Codex saw the code, the link and the path as markers only.
	const seen = calls.find((call) => call.text.includes('Summary'))!.text;
	for (const kept of ['bun test', 'example.com', '/home/u/board', 'git status']) expect(seen).not.toContain(kept);
	expect(seen).toContain('## Summary');
});

test('a saved translation comes at once, before one still being translated, and survives a restart without calling Codex', async () => {
	await lines(['Saved reply number one.']);
	expect(codexCalls()).toHaveLength(1);
	codexPlan({ prefix: '譯：', delayMs: 800 });
	const response = await ask(['A slow new reply.', 'Saved reply number one.']);
	const reader = response.body!.getReader();
	const started = Date.now();
	const first = JSON.parse(new TextDecoder().decode((await reader.read()).value).trim().split('\n')[0]);
	expect(first).toEqual({ index: 1, text: '譯：Saved reply number one.' });
	expect(Date.now() - started).toBeLessThan(600);
	while (!(await reader.read()).done);

	await fixture.stop();
	await fixture.start();
	rmSync(join(codexDir, 'codex-calls.jsonl'), { force: true });
	const again = await lines(['Saved reply number one.', 'A slow new reply.']);
	expect(again[0].text).toBe('譯：Saved reply number one.');
	expect(again[1].text).toBe('譯：A slow new reply.');
	expect(codexCalls()).toEqual([]);
});

test('a translation unused for 30 days is dropped and translated again when asked', async () => {
	await lines(['Reply to be forgotten.']);
	fixture.setClock(START + 31 * DAY);
	await lines(['Another reply to trigger expiry.']);
	const saved = readFileSync(join(fixture.dir, 'board-state', 'translations.json'), 'utf8');
	expect(saved).not.toContain('Reply to be forgotten');
	rmSync(join(codexDir, 'codex-calls.jsonl'), { force: true });
	expect((await lines(['Reply to be forgotten.']))[0].text).toBe('譯：Reply to be forgotten.');
	expect(codexCalls()).toHaveLength(1);
});

test('a page that leaves drops what it alone wanted and Codex has not started; what is running finishes', async () => {
	codexPlan({ prefix: '譯：', delayMs: 1200 });
	// The three Codex places are taken by these.
	const busy = lines(['Busy one is running.', 'Busy two is running.', 'Busy three is running.']);
	await Bun.sleep(300);
	const leaving = new AbortController();
	const left = fixture
		.fetch('/api/translate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ texts: ['Waiting four never runs.', 'Waiting five never runs.'] }), cookie, signal: leaving.signal })
		.catch(() => null);
	await Bun.sleep(300);
	leaving.abort();
	await left;
	expect(Object.values(await busy).every((line) => line.text?.startsWith('譯：'))).toBe(true);
	await Bun.sleep(1500);
	expect(codexCalls().map((call) => call.text)).toEqual(['Busy one is running.', 'Busy two is running.', 'Busy three is running.'].map((text) => `<reply>\n${text}\n</reply>`));
});

test('Codex failing or timing out gives a reason for that text, and nothing is saved for it; the failure is answered as it was for 5 minutes', async () => {
	codexPlan({ fail: true });
	expect(await lines(['This one fails.'])).toEqual({ 0: { error: 'Codex 沒有完成：usage limit reached' } });
	codexPlan({ hang: true });
	expect(await lines(['This one hangs.'])).toEqual({ 0: { error: 'Codex 逾時（2 秒）' } });
	codexPlan({ reply: '丟掉了程式碼' });
	expect(await lines(['Run `make` please.'])).toEqual({ 0: { error: '譯文少了原文的程式碼、網址或路徑' } });
	codexPlan({ prefix: '譯：' });
	expect(await lines(['This one fails.'])).toEqual({ 0: { error: 'Codex 沒有完成：usage limit reached' } });
	expect(codexCalls()).toHaveLength(3);
	fixture.setClock(START + 31 * DAY + 5 * 60_000 + 1000);
	expect((await lines(['This one fails.']))[0].text).toBe('譯：This one fails.');
	// The conversation stays out of the journal.
	expect(fixture.serverOutput()).toContain('[translate] Codex translation failed');
	expect(fixture.serverOutput()).not.toContain('This one hangs');
});
