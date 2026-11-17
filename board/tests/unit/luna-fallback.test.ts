// Haiku standing in for Codex luna in translation and tidy (luna-fallback.ts), with a fake Codex app
// server and a fake Claude CLI: only Codex's usage limit switches; the next 30 minutes go straight
// to Haiku for both, whatever Haiku answers; then luna is tried again. Haiku's failures say so and
// keep the conversation out of the journal. No server, no real Codex or Claude.
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Outcome } from '../../src/lib/server/codex-turn.ts';
import { loadConfig, type BoardConfig } from '../../src/lib/server/config.ts';
import { HAIKU_HOLD_MS } from '../../src/lib/server/luna-fallback.ts';
import { createTranslator } from '../../src/lib/server/translate.ts';
import { tidy } from '../../src/lib/server/voice.ts';
import { NODE } from '../harness.ts';

const TOKEN = 'secret-asr-token-should-stay-out-of-journal';
const SPEECH = '这是一段不该出现在日志里的语音辨识结果请整理';
const ENGLISH = 'Private reply about the deploy that must stay out of the journal.';
const START = Date.parse('2026-11-18T02:00:00Z');
const dir = mkdtempSync(join(tmpdir(), 'lat-board-luna-fallback-'));
const clockFile = join(dir, 'clock');
const setClock = (time: number) => writeFileSync(clockFile, new Date(time).toISOString());

/** A fresh board: what a restart gives. */
const board = (seconds = '2'): BoardConfig =>
	loadConfig({
		LAT_BOARD_STATE_DIR: mkdtempSync(join(dir, 'state-')),
		LAT_BOARD_CLOCK_FILE: clockFile,
		LAT_BOARD_ASR_URL: 'http://127.0.0.1:1',
		LAT_BOARD_ASR_TOKEN: TOKEN,
		LAT_BOARD_TIDY_TIMEOUT_SECONDS: seconds,
		LAT_BOARD_TRANSLATE_TIMEOUT_SECONDS: seconds,
		LAT_BOARD_TIDY_COMMAND: JSON.stringify([NODE, join(import.meta.dir, '../fake-codex.mjs'), dir]),
		LAT_BOARD_TRANSLATE_COMMAND: JSON.stringify([NODE, join(import.meta.dir, '../fake-codex.mjs'), dir]),
		LAT_BOARD_HAIKU_COMMAND: JSON.stringify([NODE, join(import.meta.dir, '../fake-claude.mjs'), dir, '--model', 'claude-haiku-5-5'])
	});
const codexPlan = (plan: object) => writeFileSync(join(dir, 'codex.json'), JSON.stringify(plan));
const claudePlan = (plan: object) => writeFileSync(join(dir, 'claude.json'), JSON.stringify(plan));
const calls = <T>(name: string): T[] => {
	const file = join(dir, name);
	return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
};
const codexCalls = () => calls<{ text: string }>('codex-calls.jsonl');
const claudeCalls = () => calls<{ args: string[]; system: string; input: string }>('claude-calls.jsonl');

/** Each text's outcome from a fresh translator of the board. */
async function translate(config: BoardConfig, texts: string[]): Promise<Outcome<string>[]> {
	const got: Outcome<string>[] = [];
	await createTranslator(config).translate(texts, (index, outcome) => (got[index] = outcome));
	return got;
}

let lines: string[];
let spy: ReturnType<typeof spyOn>;
beforeEach(() => {
	lines = [];
	spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => void lines.push(args.join(' ')));
	setClock(START);
	for (const file of ['codex-calls.jsonl', 'claude-calls.jsonl', 'codex-threads.jsonl']) rmSync(join(dir, file), { force: true });
	codexPlan({ usageLimit: true });
	claudePlan({ prefix: '譯：' });
});
afterEach(() => spy.mockRestore());
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Nothing of the conversation, the speech or the token in any journal line. */
function journalIsClean(): void {
	for (const line of lines) {
		expect(line).not.toContain('\n');
		for (const secret of [SPEECH, '這是一段不該出現在日誌裡', ENGLISH, 'Private reply', TOKEN]) expect(line).not.toContain(secret);
	}
}

test('tidy: Codex out of quota, Haiku tidies the same transcript with the same prompt, in Traditional characters', async () => {
	const config = board();
	const result = await tidy(config, SPEECH);
	expect(result).toEqual({ ok: true, value: '譯：這是一段不該出現在日誌裡的語音辨識結果請整理', by: 'Haiku' });
	expect(codexCalls()).toHaveLength(1);
	const [call] = claudeCalls();
	expect(call.input).toBe(codexCalls()[0].text);
	const [thread] = calls<{ baseInstructions: string; developerInstructions: string }>('codex-threads.jsonl');
	expect(call.system).toBe(`${thread.baseInstructions}\n\n${thread.developerInstructions}`);
	// The switch is logged once, with its time and nothing of the speech.
	const switched = lines.filter((line) => line.startsWith('[luna-fallback]'));
	expect(switched).toEqual(['[luna-fallback] Codex usage limit at 2026-11-18T02:00:00.000Z: translation and tidy use Haiku until 2026-11-18T02:30:00.000Z']);
	journalIsClean();
});

test('translation: Codex out of quota, Haiku translates the same batch with the markers kept and in Taiwan Chinese', async () => {
	const config = board();
	const texts = [`Run \`bun test\` in board/ and see https://example.com/x. ${ENGLISH}`, 'Second reply of the same batch here.'];
	const got = await translate(config, texts);
	expect(got).toEqual([
		{ ok: true, value: `譯：Run \`bun test\` in board/ and see https://example.com/x. ${ENGLISH}` },
		{ ok: true, value: '譯：Second reply of the same batch here.' }
	]);
	expect(codexCalls()).toHaveLength(1);
	const [call] = claudeCalls();
	// The same masked batch and the same rules Codex got: markers, numbered tags, Markdown.
	expect(call.input).toBe(codexCalls()[0].text);
	expect(call.input).toContain('⟦0⟧');
	expect(call.system).toContain('<reply id="1">');
	expect(call.system).toContain('Markers such as ⟦0⟧');
	expect(call.system).toContain('Keep the Markdown structure exactly');
	expect(call.system).toStartWith('You are a translation engine, not a coding agent.');
	// Saved like Codex's: once the batch has written the file, a fresh translator of the same board
	// answers from it.
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(readFileSync(join(config.stateDir, 'translations.json'), 'utf8')).toContain('譯：Second reply of the same batch here.');
	expect(await translate(config, texts.slice(1))).toEqual([{ ok: true, value: '譯：Second reply of the same batch here.' }]);
	expect(claudeCalls()).toHaveLength(1);
	journalIsClean();
});

test("Haiku's translation goes through opencc to Taiwan's Traditional Chinese, and a dropped marker fails as it does for Codex", async () => {
	const config = board();
	claudePlan({ prefix: '软件：', dropMarkers: 2 });
	const got = await translate(config, ['Look at `one` thing please now.', 'Look at `two` thing please now.']);
	expect(got[0]).toEqual({ ok: true, value: '軟體：Look at `one` thing please now.' });
	expect(got[1]).toEqual({ ok: false, reason: '譯文少了原文的程式碼、網址或路徑' });
	expect(lines).toContain('[translate] Haiku translation failed: a reply or marker was dropped or repeated');
});

test('within 30 minutes of the switch translation and tidy go straight to Haiku; at 30 minutes luna is tried first again', async () => {
	const config = board();
	// The switch happens in tidy...
	await tidy(config, SPEECH);
	expect(codexCalls()).toHaveLength(1);
	// ...and translation, just before 30 minutes, does not start Codex.
	setClock(START + HAIKU_HOLD_MS - 1);
	expect(await translate(config, ['Translate this one please now.'])).toEqual([{ ok: true, value: '譯：Translate this one please now.' }]);
	expect(codexCalls()).toHaveLength(1);
	expect(claudeCalls()).toHaveLength(2);
	// At 30 minutes luna answers again, and Haiku is not asked.
	setClock(START + HAIKU_HOLD_MS);
	codexPlan({ reply: '整理好了。' });
	expect(await tidy(config, SPEECH)).toEqual({ ok: true, value: '整理好了。', by: 'Codex' });
	expect(codexCalls()).toHaveLength(2);
	expect(claudeCalls()).toHaveLength(2);
});

test('a switch in translation holds for tidy too; luna still out of quota after 30 minutes switches again', async () => {
	const config = board();
	await translate(config, ['First batch to translate here.']);
	setClock(START + 10 * 60_000);
	expect((await tidy(config, SPEECH)).by).toBe('Haiku');
	expect(codexCalls()).toHaveLength(1);
	setClock(START + HAIKU_HOLD_MS + 5);
	expect((await tidy(config, SPEECH)).by).toBe('Haiku');
	expect(codexCalls()).toHaveLength(2);
	expect(lines.filter((line) => line.startsWith('[luna-fallback]'))).toHaveLength(2);
});

test('a restarted board starts on luna', async () => {
	await tidy(board(), SPEECH);
	codexPlan({ reply: '整理好了。' });
	expect((await tidy(board(), SPEECH)).by).toBe('Codex');
	expect(codexCalls()).toHaveLength(2);
});

test("Codex's usage limit is known by its error code or by its words alone, in a failed turn or a refused one", async () => {
	for (const only of ['code', 'message']) {
		codexPlan({ usageLimit: only });
		expect((await tidy(board(), SPEECH)).by).toBe('Haiku');
	}
	// Refused at turn/start with Codex's words, rather than a failed turn.
	codexPlan({ usageLimitOnStart: true });
	expect((await tidy(board(), SPEECH)).by).toBe('Haiku');
	expect(claudeCalls()).toHaveLength(3);
});

test("Haiku's own answer never reaches the journal when the CLI exits non-zero after it", async () => {
	const config = board();
	claudePlan({ reply: '這是海酷整理出來的私人語音內容', exitCode: 1 });
	const result = await tidy(config, SPEECH);
	expect(result).toEqual({ ok: false, reason: 'Haiku 沒有完成：這是海酷整理出來的私人語音內容', by: 'Haiku' });
	const failed = lines.filter((line) => line.startsWith('[voice] Haiku tidy failed: '));
	expect(failed).toEqual(['[voice] Haiku tidy failed: Haiku 沒有完成：結束碼不是 0 (exit 1)']);
	// A long error is cut for the page and the 5-minute failure memo.
	claudePlan({ error: `API Error: ${'x'.repeat(1_000)}` });
	const long = await tidy(config, SPEECH);
	if (!long.ok) expect(long.reason).toBe(`Haiku 沒有完成：API Error: ${'x'.repeat(189)}…`);
});

test('a Codex timeout, early exit, garbled answer or other failure fails as before: no Haiku and no hold', async () => {
	const config = board('1');
	for (const [plan, reason] of [
		[{ fail: true }, 'Codex 沒有完成：usage limit reached'],
		[{ hang: true }, 'Codex 逾時（1 秒）'],
		[{ exit: true }, 'Codex 提前結束'],
		[{ garbled: true }, 'Codex 回應看不懂'],
		[{ junk: 'not json' }, 'Codex 回應看不懂']
	] as const) {
		codexPlan(plan);
		const result = await tidy(config, SPEECH);
		expect(result.ok).toBe(false);
		expect(result.by).toBe('Codex');
		if (!result.ok) expect(result.reason).toStartWith(reason);
	}
	// Each one asked Codex: none opened a hold.
	expect(codexCalls()).toHaveLength(5);
	expect(claudeCalls()).toEqual([]);
	codexPlan({ fail: true });
	expect(await translate(config, ['Some reply to translate now.'])).toEqual([{ ok: false, reason: 'Codex 沒有完成：usage limit reached' }]);
	expect(claudeCalls()).toEqual([]);
	expect(lines.some((line) => line.startsWith('[luna-fallback]'))).toBe(false);
});

test('Haiku failing after the switch fails as before with the reason naming Haiku, nothing of the conversation logged, and the hold kept', async () => {
	const config = board('1');
	for (const [plan, reason] of [
		[{ error: `API Error: 500 while reading ${SPEECH}` }, 'Haiku 沒有完成：API Error: 500'],
		[{ limit: true }, "Haiku 沒有完成：You've hit your limit"],
		[{ limitAsReply: true }, "Haiku 沒有完成：You've hit your limit"],
		[{ exit: true, stderr: `crashed on ${SPEECH} with Bearer ${TOKEN}` }, 'Haiku 提前結束'],
		[{ junk: `${SPEECH} is not json` }, 'Haiku 回應看不懂'],
		[{ reply: '' }, 'Haiku 沒有完成：沒有回覆'],
		[{ hang: true }, 'Haiku 逾時（1 秒）']
	] as const) {
		claudePlan(plan);
		lines.length = 0;
		const result = await tidy(config, SPEECH);
		expect(result.ok).toBe(false);
		expect(result.by).toBe('Haiku');
		if (!result.ok) expect(result.reason).toStartWith(reason);
		const failed = lines.filter((line) => line.startsWith('[voice] Haiku tidy failed: '));
		expect(failed).toHaveLength(1);
		journalIsClean();
	}
	// Only the first one asked Codex: Haiku's failures do not end the 30 minutes. One failing 20
	// minutes in does not extend them either: at 30 minutes from the switch luna is tried first.
	expect(codexCalls()).toHaveLength(1);
	setClock(START + 20 * 60_000);
	claudePlan({ error: 'overloaded' });
	expect(await translate(config, [ENGLISH])).toEqual([{ ok: false, reason: 'Haiku 沒有完成：overloaded' }]);
	expect(lines.filter((line) => line.startsWith('[translate] Haiku translation failed: '))).toHaveLength(1);
	journalIsClean();
	expect(codexCalls()).toHaveLength(1);
	setClock(START + HAIKU_HOLD_MS);
	codexPlan({ reply: '整理好了。' });
	expect((await tidy(config, SPEECH)).by).toBe('Codex');
	expect(codexCalls()).toHaveLength(2);
});

test('the Haiku turn runs the configured command with only the system prompt added, the text on standard input', async () => {
	await tidy(board(), SPEECH);
	const [call] = claudeCalls();
	expect(call.args.slice(0, 3)).toEqual(['--model', 'claude-haiku-5-5', '--system-prompt']);
	expect(call.args).toHaveLength(4);
	expect(call.input).toBe(`<transcript>\n${SPEECH}\n</transcript>`);
});

test('the default Haiku command is one text-only Claude CLI turn: no tools, MCP, hooks, skills or kept session', () => {
	const command = loadConfig({}).haikuCommand;
	expect(command).toEqual([
		'claude',
		'-p',
		'--model',
		'claude-haiku-5-5',
		'--safe-mode',
		'--tools',
		'',
		'--strict-mcp-config',
		'--disable-slash-commands',
		'--no-session-persistence',
		'--output-format',
		'json'
	]);
	expect(loadConfig({ LAT_BOARD_HAIKU_COMMAND: '["my-claude","-p"]' }).haikuCommand).toEqual(['my-claude', '-p']);
	expect(() => loadConfig({ LAT_BOARD_HAIKU_COMMAND: '"claude"' })).toThrow('LAT_BOARD_HAIKU_COMMAND must be a JSON array of strings');
});
