// 「我說過的話」: the user's own messages of a whole controller conversation, read through the fake
// helper that pages <dir>/transcripts/<session>.jsonl fifty texts at a time.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MyMessagesUpdate } from '../../src/lib/board/my-messages.ts';
import { sleep, startFixture, type Fixture } from '../harness.ts';

let fixture: Fixture;
let cookie: string;

beforeAll(async () => {
	fixture = await startFixture();
	cookie = await fixture.login();
});
afterAll(() => fixture.cleanup());

const line = (kind: string, text: string, time = '2026-11-13T09:00:00.000Z') => JSON.stringify({ kind, time, text }) + '\n';
const recordPath = (session: string) => join(fixture.dir, 'transcripts', `${session}.jsonl`);
function record(session: string, lines: string[]): void {
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(recordPath(session), lines.join(''));
}
async function bind(project: string, name: string) {
	const controller = fixture.bound(project, name, { client: 'codex' });
	fixture.list([...fixture.listed(), controller]);
	await fixture.refresh(cookie);
	return controller;
}
async function once(session: string): Promise<MyMessagesUpdate> {
	const response = await fixture.fetch(`/api/transcript/mine?controller=${encodeURIComponent(session)}`, { cookie });
	expect(response.status).toBe(200);
	return response.json();
}
/** Asked again, as the page does, until the whole conversation is read. */
async function mine(session: string): Promise<MyMessagesUpdate> {
	for (;;) {
		const update = await once(session);
		if (!update.ok || update.complete) return update;
		await sleep(50);
	}
}
function messagesOf(update: MyMessagesUpdate) {
	if (!update.ok) throw new Error(update.reason);
	return update.messages;
}
const alternating = (count: number) => Array.from({ length: count }, (_, index) => line(index % 2 ? 'assistant' : 'user', `第 ${index} 段`));

test('only the user’s own texts are listed, newest first, each as time and first line', async () => {
	const luna = await bind('alpha', 'luna');
	record(luna.session_id, [
		line('user', '修好匯出\n第二行不列', '2026-11-13T01:00:00.000Z'),
		line('assistant', '改好了。'),
		JSON.stringify({ kind: 'tool', time: null, name: 'hcom', label: '收到 HCOM', detail: '通知', error: false }) + '\n',
		line('user', '\n\n  前面有空行  \n後面', '2026-11-13T02:00:00.000Z'),
		line('user', `附件：\n/tmp/a.png`, '2026-11-13T03:00:00.000Z')
	]);

	const messages = messagesOf(await mine(luna.session_id));

	expect(messages.map((message) => message.line)).toEqual(['（附件）', '前面有空行', '修好匯出']);
	expect(messages.map((message) => message.seq)).toEqual([4, 3, 0]);
	expect(messages[2].time).toBe('2026-11-13T01:00:00.000Z');
});

test('a long first line is cut', async () => {
	const luna = await bind('alpha', 'luna-long');
	record(luna.session_id, [line('user', '長'.repeat(500))]);
	const [message] = messagesOf(await mine(luna.session_id));
	expect(Array.from(message.line)).toHaveLength(200);
});

test('the whole conversation is listed, not only the latest 50 texts', async () => {
	const luna = await bind('alpha', 'luna-whole');
	record(luna.session_id, alternating(240));

	const messages = messagesOf(await mine(luna.session_id));

	expect(messages).toHaveLength(120);
	expect(messages[0].line).toBe('第 238 段');
	expect(messages.at(-1)!.line).toBe('第 0 段');
});

test('a message said later shows at the top of the next read, and only the new end is read again', async () => {
	const luna = await bind('alpha', 'luna-live');
	record(luna.session_id, alternating(240));
	await mine(luna.session_id);
	const before = fixture.helperArgs('transcript').length;

	appendFileSync(recordPath(luna.session_id), line('user', '新說的一句'));
	const messages = messagesOf(await mine(luna.session_id));

	expect(messages[0].line).toBe('新說的一句');
	expect(messages).toHaveLength(121);
	expect(fixture.helperArgs('transcript').length - before).toBe(1);
});

test('in a conversation of a thousand and more texts the newest are listed within a second, the rest follow', async () => {
	const luna = await bind('alpha', 'luna-big');
	record(luna.session_id, Array.from({ length: 2400 }, (_, index) => (index % 3 ? line('assistant', `回覆 ${index}`) : line('user', `提問 ${index}`))));

	const started = performance.now();
	const first = await once(luna.session_id);
	const shownAfter = performance.now() - started;
	if (!first.ok) throw new Error(first.reason);

	expect(shownAfter).toBeLessThan(1_000);
	expect(first.complete).toBe(false);
	expect(first.messages[0].line).toBe('提問 2397');
	const messages = messagesOf(await mine(luna.session_id));
	expect(messages).toHaveLength(800);
	expect(messages.at(-1)!.line).toBe('提問 0');
});

test('a record that cannot be read answers with its reason', async () => {
	const luna = await bind('alpha', 'luna-fail');
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', `${luna.session_id}.fail`), '紀錄壞了');
	const update = await mine(luna.session_id);
	rmSync(join(fixture.dir, 'transcripts', `${luna.session_id}.fail`));
	expect(update).toEqual({ ok: false, reason: '紀錄壞了' });
});

test('a controller the board does not know and a missing ID are refused', async () => {
	expect((await fixture.fetch('/api/transcript/mine?controller=nobody', { cookie })).status).toBe(404);
	expect((await fixture.fetch('/api/transcript/mine', { cookie })).status).toBe(400);
	expect((await fixture.fetch('/api/agents/transcript/mine?session=nobody', { cookie })).status).toBe(404);
	expect((await fixture.fetch('/api/transcript/mine?controller=nobody')).status).toBe(401);
});
