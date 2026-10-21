// Translating a conversation's English replies: which texts count as English, code and links kept
// as written, translations saved and expired, and the page's requests. No server and no Codex.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isEnglish, Translations, type Translation } from '../src/lib/board/translate.ts';
import { codexTurn, type CodexTurn, type Outcome } from '../src/lib/server/codex-turn.ts';
import { loadConfig } from '../src/lib/server/config.ts';
import { createTranslator, FAILURE_HOLD_MS, protect, restore, translationStream, type Translator } from '../src/lib/server/translate.ts';
import { NODE } from './harness.ts';

const DAY = 24 * 60 * 60_000;
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('a mostly English reply is English; Chinese, Chinese naming English terms, and too little text are not', () => {
	expect(isEnglish('I fixed the failing test and pushed the branch.')).toBe(true);
	expect(isEnglish('Done — see `src/lib/a.ts` for the change. 好')).toBe(true);
	expect(isEnglish('我已經修好了測試，分支也推上去了。')).toBe(false);
	expect(isEnglish('這次 commit 修了 board 的 transcript stream bug')).toBe(false);
	expect(isEnglish('OK')).toBe(false);
	// Code, links and paths say nothing about the language.
	expect(isEnglish('改好了：\n```ts\nconst answer = await fetch(url).then((response) => response.json());\n```')).toBe(false);
	expect(isEnglish('看 https://example.com/some/long/english/path 與 /home/user/project/src/file.ts')).toBe(false);
});

test('English starts at 3 words of two letters or more, with at most half as many Chinese characters as words', () => {
	expect(isEnglish('Fixed it now')).toBe(true);
	expect(isEnglish('Fixed it')).toBe(false);
	// One-letter words do not count.
	expect(isEnglish('Fixed a b c d')).toBe(false);
	// 4 words: 2 Chinese characters are allowed, 3 are not.
	expect(isEnglish('Fixed the board bug 看板')).toBe(true);
	expect(isEnglish('Fixed the board bug 看板頁')).toBe(false);
});

test('code, links and paths go to Codex as markers and come back as written', () => {
	const text = 'Run `bun test` in board/, see https://example.com/x.\n\n```sh\necho "keep me"\n```\n\n- Done';
	const { text: masked, kept } = protect(text);
	expect(masked).not.toContain('bun test');
	expect(masked).not.toContain('example.com');
	expect(masked).not.toContain('keep me');
	expect(masked).not.toContain('board/');
	expect(masked).toContain('- Done');
	const translated = masked.replace('Run', '執行').replace('in', '於').replace('Done', '完成');
	const back = restore(translated, kept)!;
	expect(back).toContain('`bun test`');
	expect(back).toContain('https://example.com/x.');
	expect(back).toContain('```sh\necho "keep me"\n```');
	expect(back).toContain('- 完成');
});

test('code blocks indented in a list or by four spaces count as code: not English, and kept as written', () => {
	const listed = '已完成。\n\n- 步驟：\n\n  ```sh\n  echo this whole line is plain English words for the shell here\n  ```\n';
	const indented = '已完成。\n\n    run every one of these English words through the command line now\n';
	expect(isEnglish(listed)).toBe(false);
	expect(isEnglish(indented)).toBe(false);

	const reply = 'Steps:\n\n    indented code stays\n\n- Build it:\n\n  ```sh\n  bun run build\n  ```\n\n- Then check.\n';
	const { text, kept } = protect(reply);
	expect(text).not.toContain('bun run build');
	expect(text).not.toContain('indented code stays');
	expect(text).toContain('- Then check.');
	expect(restore(text, kept)).toBe(reply);
});

test('a translation that dropped or repeated a marker is refused', () => {
	const { text, kept } = protect('Use `a` and `b` here.');
	expect(restore(text.replace('⟦1⟧', ''), kept)).toBeNull();
	expect(restore(text.replace('⟦0⟧', '⟦0⟧⟦0⟧'), kept)).toBeNull();
	expect(restore(`${text} ⟦7⟧`, kept)).toBeNull();
});

/** A translator on a fresh state directory and a clock the test moves; Codex answers as `answer` says. */
function setUp(answer: (turn: CodexTurn) => Promise<Outcome<string>> = async (turn) => ({ ok: true, value: `譯：${turn.input.replace(/<\/?reply>\n?/g, '').trim()}` }), env: Record<string, string> = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'lat-board-translate-'));
	dirs.push(dir);
	let now = Date.parse('2026-10-21T00:00:00Z');
	const config = { ...loadConfig({ LAT_BOARD_STATE_DIR: dir, ...env }), now: () => now };
	const calls: CodexTurn[] = [];
	const turn = (given: CodexTurn) => {
		calls.push(given);
		return answer(given);
	};
	const translator = () => createTranslator(config, turn);
	const ask = async (made: ReturnType<typeof translator>, texts: string[]) => {
		const got: Outcome<string>[] = [];
		await made.translate(texts, (index, outcome) => (got[index] = outcome));
		return got;
	};
	return { dir, config, calls, translator, ask, advance: (ms: number) => (now += ms) };
}

test('Codex is asked with gpt-6-luna at low effort, and the reply comes back in Traditional Chinese', async () => {
	const { calls, translator, ask } = setUp(async () => ({ ok: true, value: '软件已经更新' }));
	expect(await ask(translator(), ['The software was updated.'])).toEqual([{ ok: true, value: '軟體已經更新' }]);
	expect(calls[0].model).toBe('gpt-6-luna');
	expect(calls[0].effort).toBe('low');
	expect(calls[0].input).toBe('<reply>\nThe software was updated.\n</reply>');
});

test('a translated text is saved: asked again, or by another board start on the same directory, Codex is not called', async () => {
	const { dir, calls, translator, ask } = setUp();
	const first = translator();
	expect(await ask(first, ['Hello there friend.'])).toEqual([{ ok: true, value: '譯：Hello there friend.' }]);
	expect(await ask(first, ['Hello there friend.'])).toEqual([{ ok: true, value: '譯：Hello there friend.' }]);
	expect(await ask(translator(), ['Hello there friend.'])).toEqual([{ ok: true, value: '譯：Hello there friend.' }]);
	expect(calls).toHaveLength(1);
	// Saved by a hash of the original: the conversation itself is not in the file.
	const file = readFileSync(join(dir, 'translations.json'), 'utf8');
	expect(file).toContain('譯：Hello');
	expect(file).not.toContain('"Hello there friend."');
});

test('a translation unused for the kept time is dropped; one used meanwhile stays', async () => {
	const { dir, calls, translator, ask, advance } = setUp(undefined, { LAT_BOARD_TRANSLATE_KEEP_DAYS: '30' });
	const made = translator();
	await ask(made, ['Old unused reply here.', 'Reply used every week.']);
	for (let week = 0; week < 4; week++) {
		advance(7 * DAY);
		await ask(made, ['Reply used every week.']);
	}
	advance(3 * DAY);
	// 31 days since the first was last used, 3 since the second.
	await ask(made, ['Something new to translate.']);
	const saved = readFileSync(join(dir, 'translations.json'), 'utf8');
	expect(saved).not.toContain('Old unused');
	expect(saved).toContain('Reply used every week');
	calls.length = 0;
	await ask(translator(), ['Old unused reply here.', 'Reply used every week.']);
	expect(calls.map((call) => call.input)).toEqual(['<reply>\nOld unused reply here.\n</reply>']);
});

test('a translation unused for exactly the kept time stays; a moment more and it is dropped', async () => {
	const { dir, translator, ask, advance } = setUp(undefined, { LAT_BOARD_TRANSLATE_KEEP_DAYS: '30' });
	const made = translator();
	await ask(made, ['Kept to the very day.']);
	advance(30 * DAY);
	await ask(made, ['Another reply to trigger expiry.']);
	expect(readFileSync(join(dir, 'translations.json'), 'utf8')).toContain('Kept to the very day');
	advance(1);
	await ask(made, ['One more reply to trigger expiry.']);
	expect(readFileSync(join(dir, 'translations.json'), 'utf8')).not.toContain('Kept to the very day');
});

test('the same text asked for by two pages at once is translated once', async () => {
	let release = () => {};
	const { calls, translator, ask } = setUp(
		(turn) => new Promise((resolve) => (release = () => resolve({ ok: true, value: `譯：${turn.input}` })))
	);
	const made = translator();
	const one = ask(made, ['Shared reply text here.']);
	const two = ask(made, ['Shared reply text here.']);
	await Bun.sleep(10);
	release();
	expect((await one)[0].ok).toBe(true);
	expect(await two).toEqual(await one);
	expect(calls).toHaveLength(1);
});

test('no more Codex translations run at once than the limit; the rest wait their turn', async () => {
	let running = 0;
	let most = 0;
	const { translator, ask } = setUp(
		async (turn) => {
			most = Math.max(most, ++running);
			await Bun.sleep(20);
			running--;
			return { ok: true, value: turn.input };
		},
		{ LAT_BOARD_TRANSLATE_CONCURRENCY: '2' }
	);
	const got = await ask(translator(), ['One two three.', 'Four five six.', 'Seven eight nine.', 'Ten eleven twelve.', 'More words here.']);
	expect(got.every((outcome) => outcome.ok)).toBe(true);
	expect(most).toBe(2);
});

test('a failed translation is not saved; it is answered as it was for a while, then tried again; one that lost its code is a failure', async () => {
	let answer: Outcome<string> = { ok: false, reason: 'Codex 逾時（60 秒）' };
	const { dir, calls, translator, ask, advance } = setUp(async () => answer);
	const made = translator();
	expect(await ask(made, ['Please run `make` now.'])).toEqual([{ ok: false, reason: 'Codex 逾時（60 秒）' }]);
	expect(existsSync(join(dir, 'translations.json'))).toBe(false);
	// Asked again soon, as a reopened page would: the same failure, without Codex.
	advance(FAILURE_HOLD_MS - 1000);
	expect(await ask(made, ['Please run `make` now.'])).toEqual([{ ok: false, reason: 'Codex 逾時（60 秒）' }]);
	expect(calls).toHaveLength(1);

	advance(2000);
	answer = { ok: true, value: '請現在執行。' };
	expect(await ask(made, ['Please run `make` now.'])).toEqual([{ ok: false, reason: '譯文少了原文的程式碼、網址或路徑' }]);
	expect(calls).toHaveLength(2);
	advance(FAILURE_HOLD_MS);
	answer = { ok: true, value: '請現在執行 ⟦0⟧。' };
	expect(await ask(made, ['Please run `make` now.'])).toEqual([{ ok: true, value: '請現在執行 `make`。' }]);
	expect(calls).toHaveLength(3);
});

test('a translation that throws is a failure for every request that wanted it, never a rejection, and its message stays out of the journal', async () => {
	const { translator, ask } = setUp(async (turn) => {
		throw new Error(`child exploded on ${turn.input}`);
	});
	const lines: string[] = [];
	const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => void lines.push(args.join(' ')));
	try {
		const made = translator();
		const [one, two] = await Promise.all([ask(made, ['Private words of the reply.']), ask(made, ['Private words of the reply.'])]);
		expect(one).toEqual([{ ok: false, reason: '翻譯時出錯' }]);
		expect(two).toEqual(one);
	} finally {
		spy.mockRestore();
	}
	expect(lines).toEqual(['[translate] translating failed: Error']);
});

test('a text still waiting for a Codex place is dropped once every request that wanted it is aborted', async () => {
	const releases: (() => void)[] = [];
	const { calls, translator } = setUp(
		(turn) => new Promise((resolve) => releases.push(() => resolve({ ok: true, value: `譯：${turn.input}` }))),
		{ LAT_BOARD_TRANSLATE_CONCURRENCY: '1' }
	);
	const made = translator();
	const told: string[] = [];
	const asking = (texts: string[], signal?: AbortSignal) => made.translate(texts, (index, outcome) => told.push(`${texts[index]}=${outcome.ok}`), signal);
	const first = asking(['Holds the only place.']);
	const gone = new AbortController();
	const left = asking(['Only the gone page wants this.'], gone.signal);
	const oneOfTwo = new AbortController();
	const shared = [asking(['Two pages want this one.'], oneOfTwo.signal), asking(['Two pages want this one.'])];
	await Bun.sleep(5);
	gone.abort();
	oneOfTwo.abort();
	await left;
	releases.shift()!();
	await first;
	await Bun.sleep(5);
	releases.shift()!();
	await Promise.all(shared);
	expect(calls.map((call) => call.input)).toEqual(['<reply>\nHolds the only place.\n</reply>', '<reply>\nTwo pages want this one.\n</reply>']);
	// The aborted requests are told nothing; the one still there gets its translation.
	expect(told).toEqual(['Holds the only place.=true', 'Two pages want this one.=true']);
	// Dropped is not a failure: asked again, it is translated.
	const again = asking(['Only the gone page wants this.']);
	await Bun.sleep(5);
	releases.shift()!();
	await again;
	expect(told.at(-1)).toBe('Only the gone page wants this.=true');
});

/** Every line of a stream, parsed. */
async function streamed(stream: ReadableStream<Uint8Array>): Promise<object[]> {
	return (await new Response(stream).text()).trim().split('\n').map((line) => JSON.parse(line));
}

test('a request gone before the translator runs, or already gone when it comes, starts no Codex', async () => {
	const releases: (() => void)[] = [];
	const { calls, translator } = setUp(
		(turn) => new Promise((resolve) => releases.push(() => resolve({ ok: true, value: `譯：${turn.input}` }))),
		{ LAT_BOARD_TRANSLATE_CONCURRENCY: '1' }
	);
	const made = translator();
	const first = made.translate(['Holds the only place.'], () => {});
	// Cancelled at once, before the translator is called.
	const cancelled = translationStream(made, ['Cancelled before it starts.'], new AbortController().signal);
	await cancelled.cancel();
	// A request that had already gone when it came.
	const gone = new AbortController();
	gone.abort();
	const late = translationStream(made, ['Already gone when it came.'], gone.signal);
	await Bun.sleep(5);
	releases.shift()!();
	await first;
	await new Response(late).text();
	await Bun.sleep(5);
	expect(calls.map((call) => call.input)).toEqual(['<reply>\nHolds the only place.\n</reply>']);
});

test('the answer fails every text the translator did not answer when it breaks, then ends', async () => {
	const rejecting: Translator = {
		translate: async (_texts, each) => {
			each(1, { ok: true, value: '好' });
			throw new Error('broken');
		}
	};
	const throwing: Translator = {
		translate: () => {
			throw new Error('broken at once');
		}
	};
	const spy = spyOn(console, 'error').mockImplementation(() => {});
	try {
		expect(await streamed(translationStream(rejecting, ['A one.', 'B two.', 'x'.repeat(20_001)], new AbortController().signal))).toEqual([
			{ index: 2, error: '太長，不翻譯（超過 20000 字）' },
			{ index: 1, text: '好' },
			{ index: 0, error: '看板伺服器翻譯時出錯' }
		]);
		expect(await streamed(translationStream(throwing, ['A one.'], new AbortController().signal))).toEqual([{ index: 0, error: '看板伺服器翻譯時出錯' }]);
		// Not an Error at all.
		for (const thrown of [null, undefined]) {
			const odd: Translator = { translate: () => Promise.reject(thrown) };
			const oddAtOnce: Translator = {
				translate: () => {
					throw thrown;
				}
			};
			for (const translator of [odd, oddAtOnce]) {
				expect(await streamed(translationStream(translator, ['A one.'], new AbortController().signal))).toEqual([{ index: 0, error: '看板伺服器翻譯時出錯' }]);
			}
		}
	} finally {
		spy.mockRestore();
	}
});

test("a long reply Codex repeats on stderr before failing stays out of the journal, whole or in part", async () => {
	const dir = mkdtempSync(join(tmpdir(), 'lat-board-codex-'));
	dirs.push(dir);
	const reply = Array.from({ length: 2000 }, (_, index) => `segment-${index}`).join(' ');
	expect(reply.length).toBeGreaterThan(20_000);
	writeFileSync(join(dir, 'codex.json'), JSON.stringify({ stderr: `echo: ${reply}\nfatal: quit`, exit: true }));
	const lines: string[] = [];
	const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => void lines.push(args.join(' ')));
	try {
		const done = await codexTurn({
			command: [NODE, join(import.meta.dir, 'fake-codex.mjs'), dir],
			timeoutMs: 5000,
			model: 'gpt-6-luna',
			effort: 'low',
			instructions: '',
			input: reply,
			secrets: [reply],
			journal: '[translate] Codex translation'
		});
		expect(done.ok).toBe(false);
	} finally {
		spy.mockRestore();
	}
	expect(lines).toHaveLength(1);
	expect(lines[0]).toContain('fatal: quit');
	expect(lines[0]).not.toContain('segment-');
});

/** The page's side, with the server's answer as `lines` written in `chunks` pieces. */
function pageSide(respond: (texts: string[]) => Response | Promise<Response>) {
	const states = new Map<string, Translation | undefined>();
	const sent: string[][] = [];
	let unpaired = 0;
	const translations = new Translations((text, translation) => states.set(text, translation), {
		request: async (_url, init) => {
			const texts = JSON.parse(String(init.body)).texts as string[];
			sent.push(texts);
			return respond(texts);
		},
		unpaired: () => unpaired++
	});
	return { states, sent, translations, unpaired: () => unpaired };
}
const ndjson = (lines: object[], split = 7) => {
	const body = lines.map((line) => JSON.stringify(line) + '\n').join('');
	const bytes = new TextEncoder().encode(body);
	return new Response(
		new ReadableStream({
			start(controller) {
				// Cut anywhere, inside characters too.
				for (let start = 0; start < bytes.length; start += split) controller.enqueue(bytes.slice(start, start + split));
				controller.close();
			}
		})
	);
};
const settle = () => Bun.sleep(5);

test('the page sends what it wants together, once, and each text turns from pending to its translation', async () => {
	const { states, sent, translations } = pageSide((texts) => ndjson([{ index: 1, text: '第二段譯文' }, { index: 0, text: '第一段譯文' }]));
	translations.want(['First reply.', 'Second reply.']);
	translations.want(['First reply.', 'Second reply.']);
	expect(states.get('First reply.')).toEqual({ status: 'pending' });
	await settle();
	expect(sent).toEqual([['First reply.', 'Second reply.']]);
	expect(states.get('First reply.')).toEqual({ status: 'done', text: '第一段譯文' });
	expect(states.get('Second reply.')).toEqual({ status: 'done', text: '第二段譯文' });
	// Asked for again, as a later page or a pushed reply would: nothing new goes out.
	translations.want(['Second reply.', 'Third reply.']);
	await settle();
	expect(sent).toEqual([['First reply.', 'Second reply.'], ['Third reply.']]);
});

test("a text the server failed, one it never answered and a request that broke are failed; retry asks for them again", async () => {
	let respond = (_texts: string[]): Response => ndjson([{ index: 0, error: 'Codex 逾時（60 秒）' }]);
	const { states, sent, translations } = pageSide((texts) => respond(texts));
	translations.want(['A reply.', 'B reply.']);
	await settle();
	expect(states.get('A reply.')).toEqual({ status: 'failed', reason: 'Codex 逾時（60 秒）' });
	expect(states.get('B reply.')).toEqual({ status: 'failed', reason: '看板伺服器沒有回完' });

	respond = () => Response.json({ error: 'texts 要是…' }, { status: 400 });
	translations.want(['C reply.']);
	await settle();
	expect(states.get('C reply.')).toEqual({ status: 'failed', reason: 'texts 要是…' });

	// Failed ones are not asked for again until retried.
	translations.want(['A reply.']);
	await settle();
	expect(sent).toHaveLength(2);
	respond = (texts) => ndjson(texts.map((_, index) => ({ index, text: `譯${index}` })));
	translations.retry();
	expect(states.get('A reply.')).toBeUndefined();
	translations.want(['A reply.', 'B reply.', 'C reply.']);
	await settle();
	expect(states.get('C reply.')).toEqual({ status: 'done', text: '譯2' });
});

test('stopping ends the requests on their way and forgets them; translations already in stay', async () => {
	let finish = () => {};
	const { states, translations } = pageSide(
		(texts) => (texts[0] === 'Done one.' ? ndjson([{ index: 0, text: '好了' }]) : new Promise<Response>((resolve) => (finish = () => resolve(ndjson([{ index: 0, text: '太晚' }])))))
	);
	translations.want(['Done one.']);
	await settle();
	translations.want(['Slow one.']);
	await settle();
	translations.stop();
	expect(states.get('Slow one.')).toBeUndefined();
	expect(states.get('Done one.')).toEqual({ status: 'done', text: '好了' });
	finish();
	await settle();
	expect(states.get('Slow one.')).toBeUndefined();
});

test('more texts than one request holds go in several; a logged-out device reloads', async () => {
	const { sent, translations, unpaired } = pageSide(() => new Response(null, { status: 401 }));
	translations.want(Array.from({ length: 120 }, (_, index) => `Reply number ${index}.`));
	await settle();
	expect(sent.map((texts) => texts.length)).toEqual([50, 50, 20]);
	expect(unpaired()).toBe(3);
});
