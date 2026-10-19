// What a failed Codex tidy leaves in the service journal: one line with the reason, how Codex
// ended and the tail of its own stderr, and never the speech or the service's token.
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/lib/server/config.ts';
import { tidy } from '../src/lib/server/voice.ts';
import { NODE } from './harness.ts';

const TOKEN = 'secret-asr-token-should-stay-out-of-journal';
const SPEECH = '這是一段不該出現在日誌裡的語音辨識結果';
const codexDir = mkdtempSync(join(tmpdir(), 'lat-board-voice-log-'));
const config = (tidyCommand: string[], seconds = '2') =>
	loadConfig({
		LAT_BOARD_ASR_URL: 'http://127.0.0.1:1',
		LAT_BOARD_ASR_TOKEN: TOKEN,
		LAT_BOARD_TIDY_TIMEOUT_SECONDS: seconds,
		LAT_BOARD_TIDY_COMMAND: JSON.stringify(tidyCommand)
	});
const fakeCodex = [NODE, join(import.meta.dir, 'fake-codex.mjs'), codexDir];
const plan = (value: object) => writeFileSync(join(codexDir, 'codex.json'), JSON.stringify(value));

let lines: string[];
let spy: ReturnType<typeof spyOn>;
beforeEach(() => {
	lines = [];
	spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => void lines.push(args.join(' ')));
});
afterEach(() => spy.mockRestore());
afterAll(() => rmSync(codexDir, { recursive: true, force: true }));

/** The one line a failure wrote, with the check that nothing private is in it. */
function onlyLine(): string {
	expect(lines).toHaveLength(1);
	expect(lines[0]).not.toContain('\n');
	expect(lines[0]).not.toContain(SPEECH);
	expect(lines[0]).not.toContain(TOKEN);
	return lines[0];
}

test('Codex quitting early logs the reason, the exit code and its stderr', async () => {
	plan({ exit: true, stderr: 'fatal: not logged in' });
	const result = await tidy(config(fakeCodex), SPEECH);
	expect(result).toEqual({ ok: false, reason: 'Codex 提前結束' });
	expect(onlyLine()).toBe('[voice] Codex tidy failed: Codex 提前結束 (exit 1) stderr: fatal: not logged in');
});

test('a failed turn, a timeout and a garbled reply each log one line', async () => {
	plan({ fail: true });
	await tidy(config(fakeCodex), SPEECH);
	expect(onlyLine()).toContain('Codex 沒有完成：usage limit reached');
	lines.length = 0;
	plan({ garbled: true, stderr: 'warn: odd' });
	await tidy(config(fakeCodex), SPEECH);
	expect(onlyLine()).toContain('stderr: warn: odd');
	lines.length = 0;
	plan({ hang: true });
	await tidy(config(fakeCodex, '1'), SPEECH);
	expect(onlyLine()).toContain('Codex 逾時（1 秒）');
});

test('a reply that is not JSON logs a fixed phrase, not the parser\'s quote of it', async () => {
	plan({ junk: `${SPEECH.slice(0, 6)} is not json` });
	const result = await tidy(config(fakeCodex), SPEECH);
	expect(result.ok).toBe(false);
	expect(onlyLine()).toBe('[voice] Codex tidy failed: Codex 回應看不懂');
	expect(lines[0]).not.toContain(SPEECH.slice(0, 6));
});

test('a Codex that cannot be started logs the reason', async () => {
	await tidy(config(['/nonexistent/codex-for-test']), SPEECH);
	expect(onlyLine()).toStartWith('[voice] Codex tidy failed: ');
});

test('stderr is cut to its tail, flattened to one line, and the speech and token are taken out of it', async () => {
	plan({ exit: true, stderr: `${'x'.repeat(2_000)}\nprompt was ${SPEECH} with Bearer ${TOKEN}\nlast words` });
	await tidy(config(fakeCodex), SPEECH);
	const line = onlyLine();
	expect(line).toContain('prompt was … with Bearer …');
	expect(line).toEndWith('last words');
	expect(line.length).toBeLessThan(450);
});

test('a tidy that works logs nothing', async () => {
	plan({ reply: '整理好的文字。', stderr: 'noise' });
	expect(await tidy(config(fakeCodex), SPEECH)).toEqual({ ok: true, value: '整理好的文字。' });
	expect(lines).toEqual([]);
});
