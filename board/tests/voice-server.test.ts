// Voice input through the board server: a stand-in speech recognition service and a fake Codex
// app server. The token goes to the service and never comes back to the page.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NODE, startFixture, type Fixture } from './harness.ts';

const TOKEN = 'secret-asr-token-should-stay-on-server';
const ROOT = join(import.meta.dir, '..');
/** Where the fake Codex app server reads its plan and logs its turns. */
const codexDir = mkdtempSync(join(tmpdir(), 'lat-board-codex-'));

interface Heard {
	authorization: string | null;
	modelId: unknown;
	dialectId: unknown;
	fileName: string;
	bytes: number;
}
let heard: Heard[] = [];
/** What the stand-in service answers next. */
let answer: () => Response = () => Response.json({ text: '' });
const asr = Bun.serve({
	port: 0,
	async fetch(request) {
		const form = await request.formData();
		const audio = form.get('audio') as File;
		heard.push({
			authorization: request.headers.get('authorization'),
			modelId: form.get('model_id'),
			dialectId: form.get('dialect_id'),
			fileName: audio.name,
			bytes: audio.size
		});
		return answer();
	}
});
const transcript = (text: string) => () => Response.json({ object: 'transcription', text, model_id: 'whisper-large-v3-turbo', dialect_id: 'zh' });

let fixture: Fixture;
let cookie: string;

beforeAll(async () => {
	fixture = await startFixture(38, {
		env: {
			LAT_BOARD_ASR_URL: `http://127.0.0.1:${asr.port}/`,
			LAT_BOARD_ASR_TOKEN: TOKEN,
			LAT_BOARD_TIDY_TIMEOUT_SECONDS: '2',
			LAT_BOARD_TIDY_COMMAND: JSON.stringify([NODE, join(ROOT, 'tests/fake-codex.mjs'), codexDir])
		}
	});
	cookie = await fixture.login();
});

afterAll(async () => {
	await fixture.cleanup();
	asr.stop(true);
	rmSync(codexDir, { recursive: true, force: true });
});

beforeEach(() => {
	heard = [];
	for (const name of ['codex.json', 'codex-calls.jsonl']) rmSync(join(codexDir, name), { force: true });
});

const codexPlan = (plan: object) => writeFileSync(join(codexDir, 'codex.json'), JSON.stringify(plan));
const codexCalls = (): { text: string; effort: string }[] => {
	const file = join(codexDir, 'codex-calls.jsonl');
	return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
};

async function speak(audio = new Blob([new Uint8Array(400)], { type: 'audio/webm;codecs=opus' }), useCookie = cookie) {
	const response = await fixture.fetch('/api/voice', { method: 'POST', headers: { 'content-type': audio.type }, body: audio, cookie: useCookie });
	const text = await response.text();
	// Whatever the outcome, the page never sees the token.
	expect(text).not.toContain(TOKEN);
	expect(JSON.stringify([...response.headers])).not.toContain(TOKEN);
	return { status: response.status, body: JSON.parse(text) };
}

test('short speech goes straight back in Traditional Chinese, without Codex', async () => {
	answer = transcript('打开设置页面');
	expect(await speak()).toEqual({ status: 200, body: { text: '開啟設定頁面', notice: null } });
	expect(heard).toEqual([
		{ authorization: `Bearer ${TOKEN}`, modelId: 'whisper-large-v3-turbo', dialectId: 'zh', fileName: 'speech.webm', bytes: 400 }
	]);
	expect(codexCalls()).toEqual([]);
});

test('long speech is tidied by Codex and comes back in Traditional Chinese', async () => {
	answer = transcript('嗯,那个,我想要请你帮我看一下,这个这个登录页面的问题');
	codexPlan({ reply: '我想请你帮我看一下这个登录页面的问题。' });
	expect(await speak()).toEqual({ status: 200, body: { text: '我想請你幫我看一下這個登入頁面的問題。', notice: null } });
	const calls = codexCalls();
	expect(calls).toHaveLength(1);
	// Codex gets the converted transcript, marked off as text to tidy, at low effort.
	expect(calls[0].text).toBe('<transcript>\n嗯,那個,我想要請你幫我看一下,這個這個登入頁面的問題\n</transcript>');
	expect(calls[0].effort).toBe('low');
});

test('a reply sent only as a completed item is read too', async () => {
	answer = transcript('这是一段超过十个字的语音辨识结果');
	codexPlan({ reply: '这是语音辨识结果。', itemOnly: true });
	expect(await speak()).toEqual({ status: 200, body: { text: '這是語音辨識結果。', notice: null } });
});

test('when Codex fails, quits or runs out of time, the converted text comes back with a notice', async () => {
	answer = transcript('这是一段超过十个字的语音辨识结果');
	const raw = '這是一段超過十個字的語音辨識結果';
	for (const [plan, reason] of [
		[{ fail: true }, 'usage limit reached'],
		[{ exit: true }, 'Codex 提前結束'],
		[{ hang: true }, 'Codex 逾時（2 秒）'],
		[{ garbled: true }, 'Codex 回應看不懂']
	] as const) {
		codexPlan(plan);
		const started = Date.now();
		const { status, body } = await speak();
		expect(status).toBe(200);
		expect(body.text).toBe(raw);
		expect(body.notice).toContain('Codex 整理失敗');
		expect(body.notice).toContain(reason);
		// Only a hang waits out the time limit.
		if (!('hang' in plan)) expect(Date.now() - started).toBeLessThan(1_500);
	}
});

test('a service that refuses or fails is reported without the token', async () => {
	answer = () => Response.json({ detail: `Invalid token ${TOKEN}` }, { status: 401 });
	expect(await speak()).toEqual({ status: 502, body: { error: '語音辨識服務不接受看板的憑證' } });
	answer = () => Response.json({ error: 'local_unavailable', message: '本地主機暫時不可用' }, { status: 503 });
	expect(await speak()).toEqual({ status: 502, body: { error: '語音辨識失敗（503）：本地主機暫時不可用' } });
	// Should the service ever repeat the token, it is taken out.
	answer = () => Response.json({ error: 'worker_error', message: `bad header Bearer ${TOKEN}` }, { status: 503 });
	expect(await speak()).toEqual({ status: 502, body: { error: '語音辨識失敗（503）：bad header Bearer …' } });
	answer = transcript('   ');
	expect(await speak()).toEqual({ status: 422, body: { error: '沒有聽出任何字' } });
	expect((await speak(new Blob([], { type: 'audio/webm' }))).status).toBe(400);
});

test('a device that is not logged in gets nothing from it', async () => {
	answer = transcript('打开');
	expect(await speak(undefined, '')).toEqual({ status: 401, body: { error: 'unpaired' } });
	expect(heard).toEqual([]);
});

test('without a configured service, voice input says so', async () => {
	const bare = await startFixture(39);
	try {
		const login = await bare.login();
		const response = await bare.fetch('/api/voice', { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: new Blob([new Uint8Array(10)]), cookie: login });
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: '看板沒有設定語音辨識服務' });
	} finally {
		await bare.cleanup();
	}
});
