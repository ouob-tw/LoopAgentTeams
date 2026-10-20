// The launch forms name the model and effort a client would use by default, and the command line's
// label shows a new controller's model once its first turn starts, without a reload. In a real
// browser: headless Chrome driven over its DevTools protocol, on the built board with fake data and
// client settings in the fixture's temporary home. Skipped when the host has no Chrome.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DEFAULT_UNREADABLE_TEXT } from '../src/lib/board/models.ts';
import type { HelperController } from '../src/lib/board/types.ts';
import { PORT_BASE, sleep, startFixture, type Fixture } from './harness.ts';

const CHROME = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(
	(path) => path && existsSync(path)
);

// Offsets 44 and 45 are used by no other file: this board's port and its Chrome's.
let fixture: Fixture;
let cookie: string;
let chrome: ChildProcess;
let profile: string;
let socket: WebSocket;
let next = 0;
const waiting = new Map<number, (message: { result?: any; error?: { message: string } }) => void>();
let luna: HelperController;
let own: string;
let plain: string;

const send = (method: string, params: object = {}) =>
	new Promise<any>((resolve, reject) => {
		const id = ++next;
		waiting.set(id, (message) => (message.error ? reject(new Error(message.error.message)) : resolve(message.result)));
		socket.send(JSON.stringify({ id, method, params }));
	});
async function evaluate<T>(expression: string): Promise<T> {
	const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
	if (exceptionDetails) throw new Error(`${expression}: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
	return result.value;
}
async function until(expression: string, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (!(await evaluate(expression).catch(() => false))) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${expression}: ${await evaluate(SHOWN).catch(() => '')}`);
		await sleep(50);
	}
}

/** The first option of the form's model and effort fields, as the page shows them. */
const SHOWN = `JSON.stringify([...document.querySelectorAll('.settings select')].map((select) => select.options[0].text))`;
const shows = (model: string, effort: string) => until(`${SHOWN} === ${JSON.stringify(JSON.stringify([`預設：${model}`, `預設：${effort}`]))}`);
/** Click the radio button of the form with this value. */
async function choose(value: string) {
	const radio = `document.querySelector(${JSON.stringify(`input[type=radio][value="${value}"]`)})`;
	await until(`!!${radio}`);
	await evaluate(`${radio}.click()`);
}
/** Wait until the page has hydrated: the form has filled in the most recent folder. */
const filledIn = () => until(`!!document.querySelector('#folder-box')?.value`);
/** Type a folder into the form's folder box. */
async function pickFolder(path: string) {
	await evaluate(`(() => {
		const box = document.querySelector('#folder-box');
		box.value = ${JSON.stringify(path)};
		box.dispatchEvent(new Event('input', { bubbles: true }));
	})()`);
}
/** Pick an option of the model field. */
const pickModel = (value: string) =>
	evaluate(`(() => {
		const select = document.querySelectorAll('.settings select')[0];
		select.value = ${JSON.stringify(value)};
		select.dispatchEvent(new Event('change', { bubbles: true }));
	})()`);

function write(path: string, content: string | object) {
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
}
const home = () => join(fixture.dir, 'home');

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture(44);
	cookie = await fixture.login('model-defaults');
	write(join(home(), '.claude/settings.json'), { model: 'opus', effortLevel: 'medium', modelSettings: { 'claude-sonnet-5-5': { effortLevel: 'low' } } });
	write(join(home(), '.codex/config.toml'), 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "medium"\n');
	// Two projects controllers have reported from: one with its own Claude settings.
	luna = fixture.bound('own', 'luna');
	own = luna.workspace;
	write(join(own, '.claude/settings.local.json'), { model: 'haiku', effortLevel: 'high' });
	const sol = fixture.bound('plain', 'sol');
	plain = sol.workspace;
	fixture.report(luna.session_id, { tag: 'DONE', summary: '好了', hcom_name: 'luna', workspace: own });
	fixture.report(sol.session_id, { tag: 'DONE', summary: '好了', hcom_name: 'sol', workspace: plain });
	fixture.list([luna, sol]);
	writeFileSync(join(fixture.dir, 'herdr.json'), JSON.stringify({ workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }] }));
	await fixture.refresh(cookie);
	profile = mkdtempSync(join(tmpdir(), 'lat-board-test-chrome-'));
	const port = PORT_BASE + 45;
	chrome = spawn(
		CHROME!,
		['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-extensions', '--disable-component-extensions-with-background-pages', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank'],
		{ stdio: 'ignore' }
	);
	let target: { webSocketDebuggerUrl: string } | undefined;
	for (let tries = 0; !target; tries++) {
		if (tries > 100) throw new Error('timed out waiting for Chrome to listen');
		target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(
			(response) => response.json(),
			() => undefined
		);
		if (!target) await sleep(100);
	}
	socket = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
	socket.addEventListener('message', (event) => {
		const message = JSON.parse(String(event.data));
		waiting.get(message.id)?.(message);
		waiting.delete(message.id);
	});
	const [name, value] = cookie.split('=');
	await send('Network.setCookie', { name, value, url: fixture.url });
	await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
}, 30_000);

afterAll(async () => {
	if (chrome) {
		socket.close();
		const exited = new Promise((resolve) => chrome.once('exit', resolve));
		chrome.kill('SIGKILL');
		await exited;
		rmSync(profile, { recursive: true, force: true });
	}
	await fixture?.cleanup();
});

test.skipIf(!CHROME)("the new-controller form names each client's defaults, the folder's own, and the effort for a chosen model", async () => {
	await send('Page.navigate', { url: `${fixture.url}/?launch` });
	await filledIn();
	// No folder: the user's settings alone.
	await pickFolder('');
	await shows('Opus 5.5（claude-opus-5-5）', 'medium');
	await pickFolder(own);
	await shows('Haiku 5.5（claude-haiku-5-5）', 'high');
	await pickFolder(plain);
	await shows('Opus 5.5（claude-opus-5-5）', 'medium');
	// Only the model chosen: the effort it gets is what modelSettings gives that model.
	await pickModel('claude-sonnet-5-5');
	await shows('Opus 5.5（claude-opus-5-5）', 'low');
	await pickModel('claude-fable-5-1');
	await shows('Opus 5.5（claude-opus-5-5）', 'medium');
	await choose('codex');
	await shows('GPT-6.1 Sol（gpt-6.1-sol）', 'medium');

	// Settings that cannot be read say the client's own default is used.
	write(join(home(), '.codex/config.toml'), 'model = "gpt-6.1-sol\n');
	await pickFolder(own);
	await shows(DEFAULT_UNREADABLE_TEXT, DEFAULT_UNREADABLE_TEXT);
	write(join(home(), '.codex/config.toml'), 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "medium"\n');
	await pickFolder(plain);
	await shows('GPT-6.1 Sol（gpt-6.1-sol）', 'medium');

	// A read again for the same folder that fails does not keep showing what may be out of date.
	await evaluate(`(() => {
		const fetch = window.fetch;
		window.fetch = (input, init) => (String(input).includes('/api/launches/defaults') ? Promise.reject(new TypeError('offline')) : fetch(input, init));
		window.restoreFetch = () => (window.fetch = fetch);
	})()`);
	fixture.report(luna.session_id, { tag: 'DONE', summary: '又好了', hcom_name: 'luna', workspace: own });
	await fixture.refresh(cookie);
	await shows('看板讀取 client 設定失敗', '看板讀取 client 設定失敗');
	await evaluate('window.restoreFetch()');
	await choose('claude');
}, 30_000);

test.skipIf(!CHROME)("the new-agent form names the defaults the same way", async () => {
	await send('Page.navigate', { url: `${fixture.url}/?new-agent=wA` });
	await until(`document.querySelector('h2')?.textContent.includes('Alpha')`);
	await pickFolder(own);
	await shows('Haiku 5.5（claude-haiku-5-5）', 'high');
	await choose('codex');
	await shows('GPT-6.1 Sol（gpt-6.1-sol）', 'medium');
	await choose('claude');
}, 30_000);

test.skipIf(!CHROME)("the command line's label shows a new controller's settings once its first turn starts, without a reload", async () => {
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', `${luna.session_id}.jsonl`), JSON.stringify({ kind: 'user', time: null, text: '開始' }) + '\n');
	await send('Page.navigate', { url: `${fixture.url}/?launch` });
	// Addressed from the command line: its conversation is not open, so nothing feeds the label.
	// Hydrated: the form has read the defaults.
	await filledIn();
	await pickFolder(plain);
	await shows('Opus 5.5（claude-opus-5-5）', 'medium');
	await evaluate(`document.querySelector('textarea[aria-label^="指令列"]').focus()`);
	await send('Input.insertText', { text: '@luna 你好' });
	const parts = `JSON.stringify([...document.querySelectorAll('.picker .part')].map((part) => part.textContent.trim()))`;
	await until(`${parts} === '["模型","強度"]'`);
	// The first read found no turn; the next board data reads again.
	const deadline = Date.now() + 10_000;
	while (!fixture.helperArgs('transcript').some((args) => args.includes(`--session-id=${luna.session_id}`))) {
		if (Date.now() > deadline) throw new Error(`the label never read the conversation: ${await evaluate(`document.querySelector('.to')?.textContent + '|' + document.querySelector('textarea[aria-label^="指令列"]').value + '|' + document.querySelector('textarea[aria-label^="指令列"]').getAttribute('aria-label')`)} ${JSON.stringify(fixture.helperArgs('transcript'))}`);
		await sleep(50);
	}
	await sleep(300);
	expect(await evaluate<string>(parts)).toBe('["模型","強度"]');

	writeFileSync(
		join(fixture.dir, 'transcripts', `${luna.session_id}.current.json`),
		JSON.stringify({ model: 'claude-opus-5-5', effort: 'high', time: '2026-10-20T01:00:00.000Z' })
	);
	fixture.report(luna.session_id, { tag: 'HELP', summary: '第一回合開始了', hcom_name: 'luna', workspace: own });
	await fixture.refresh(cookie);
	await until(`${parts} === '["Opus 5.5","H"]'`);
}, 30_000);
