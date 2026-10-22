// Files the user attached from the board, in a real browser: in the conversation, the attachment
// block of the user's message shows as the files themselves, after the text it came with.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';
import { launchChrome, type Browser } from '../browser.ts';

/** A 1×1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;

beforeAll(async () => {
	fixture = await startFixture();
	cookie = await fixture.login('transcript-attachments');
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

test("the user's attached image shows in the conversation, and a file no longer there says so", async () => {
	const started = await fixture.fetch('/api/uploads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'A1.png', size: PNG.length }), cookie });
	const { id, path } = await started.json();
	await fixture.fetch(`/api/uploads/${id}?offset=0`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: PNG, cookie });
	const missing = join(fixture.dir, 'uploads', 'gone', '0000000000000000-notes.txt');

	const luna = fixture.bound('alpha', 'luna');
	fixture.list([luna]);
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	const lines = [
		{ kind: 'user', time: null, text: `看一下這張圖\n\n附件：\n${path}\n${missing}` },
		{ kind: 'assistant', time: null, text: `附件：\n${path}` }
	];
	writeFileSync(join(fixture.dir, 'transcripts', `${luna.session_id}.jsonl`), lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
	await fixture.refresh(cookie);

	browser = await launchChrome({ screen: `document.querySelector('#panel-transcript')?.innerText ?? ''` });
	const tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.navigate(`${fixture.url}/?controller=${luna.session_id}`);
	const said = `document.querySelector('#panel-transcript li.said[data-kind="user"]')`;
	await tab.until(`${said}?.querySelector('.attached img')?.naturalWidth === 1`, 'the attached image, loaded');
	expect(await tab.eval<string>(`${said}.querySelector('.text').innerText.trim()`)).toBe('看一下這張圖');
	await tab.until(`${said}.innerText.includes('檔案已不在：${missing}')`, 'the missing file noted');
	// Only the user's own messages: a reply that looks the same stays text.
	expect(await tab.eval<string>(`document.querySelector('#panel-transcript li.said[data-kind="assistant"] .text').innerText`)).toContain(path);
	expect(await tab.eval<number>(`document.querySelectorAll('#panel-transcript li.said[data-kind="assistant"] .attached').length`)).toBe(0);
}, 60_000);
