// A question the controller revises while the user is answering it: the draft follows the version on
// screen at once, so answering again as the notice says goes through the first time. In a real
// browser: headless Chrome driven over its DevTools protocol, on the built board with fake data.
// Skipped when the host has no Chrome.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { HelperController, HelperQuestion } from '../src/lib/board/types.ts';
import { PORT_BASE, question, sleep, startFixture, type Fixture } from './harness.ts';

const CHROME = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(
	(path) => path && existsSync(path)
);

// Offsets 38 and 39 are used by no other file: this board's port and its Chrome's.
let fixture: Fixture;
let cookie: string;
let chrome: ChildProcess;
let profile: string;
let socket: WebSocket;
let next = 0;
const waiting = new Map<number, (message: { result?: any; error?: { message: string } }) => void>();

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
async function until(expression: string) {
	const deadline = Date.now() + 10_000;
	while (!(await evaluate(expression).catch(() => false))) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${expression}`);
		await sleep(50);
	}
}

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture(41);
	cookie = await fixture.login('answer-revised');
	profile = mkdtempSync(join(tmpdir(), 'lat-board-test-chrome-'));
	const port = PORT_BASE + 42;
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

const options = (labels: string[]) => labels.map((label, index) => ({ letter: 'ABC'[index]!, label, impact: '', recommended: false }));
const single = (overrides: Partial<HelperQuestion> = {}) =>
	question({ id: 'S-1', title: '單選題', kind: 'single', options: options(['維持現狀', '全部重寫', '只改一半']), ...overrides });

const NOTICE = '主控改了這一題，畫面上是新版本';
const REFUSED = '題目已變更';
const sha = (letter: string) => letter.repeat(64);
const row = (controller: HelperController, id: string) => `q:${controller.session_id}:${id}`;

/** Open the question in the page, then wait for its form. A click before hydration does nothing. */
async function open(controller: HelperController, id: string) {
	await send('Page.navigate', { url: fixture.url });
	const selector = `.row[data-item="${row(controller, id)}"] .main`;
	for (let tries = 0; tries < 40 && !(await evaluate(`!!document.querySelector('article.content form.answer')`)); tries++) {
		await evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`);
		await sleep(250);
	}
	await until(`!!document.querySelector('article.content form.answer')`);
}
const header = () => evaluate<string>(`document.querySelector('article.content header .id').textContent`);
const checked = () => evaluate<number[]>(`[...document.querySelectorAll('article.content ul.options input')].flatMap((input, index) => (input.checked ? [index + 1] : []))`);
const toasts = () => evaluate<string>(`document.body.innerText`);
const choose = (position: number) => evaluate(`document.querySelectorAll('article.content ul.options input')[${position - 1}].click()`);
async function fill(selector: string, value: string) {
	await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
}
const submit = () => evaluate(`document.querySelector('article.content form.answer button.primary').click()`);
const NOTE = 'article.content form.answer label.field:last-of-type textarea';
const typed = () => evaluate<{ note: string }>(`({ note: document.querySelector(${JSON.stringify(NOTE)}).value })`);
const answerCalls = () => fixture.helperArgs('answer');

async function revise(controller: HelperController, revised: HelperQuestion) {
	fixture.list([{ ...controller, questions: [revised] }]);
	await fixture.refresh(cookie);
}

test.skipIf(!CHROME)('without a revision, choosing and sending behave as before', async () => {
	const shown = single({ id: 'S-0', title: '沒改版的題' });
	const luna = fixture.bound('alpha', 'luna', { questions: [shown] });
	fixture.list([luna]);
	await fixture.refresh(cookie);
	await open(luna, 'S-0');
	await choose(2);
	await fill(NOTE, '照舊');
	expect(await checked()).toEqual([2]);
	expect(await toasts()).not.toContain(NOTICE);
	await submit();
	await until(`document.body.innerText.includes('已送出') || !document.querySelector('article.content form.answer')`);
	expect(answerCalls().at(-1)).toContain('--select=2');
	expect(answerCalls().at(-1)).toContain('--revision=1');
}, 30_000);

test.skipIf(!CHROME)('a revision under the draft clears the choice at once, keeps the typed note, and the next send goes through', async () => {
	const shown = single();
	const luna = fixture.bound('alpha', 'luna', { questions: [shown] });
	fixture.list([luna]);
	await fixture.refresh(cookie);
	await open(luna, 'S-1');
	await choose(2);
	await fill(NOTE, '我的備註');
	expect(await checked()).toEqual([2]);
	const before = answerCalls().length;

	// The controller revises it; the options now read differently.
	await revise(luna, single({ revision: 2, section_sha256: sha('b'), options: options(['先觀察', '直接動手', '都不要']) }));
	await until(`document.querySelector('article.content header .id')?.textContent.includes('r2')`);
	await until(`document.body.innerText.includes(${JSON.stringify(NOTICE)})`);
	expect(await checked()).toEqual([]);
	expect(await typed()).toEqual({ note: '我的備註' });

	// Choosing again as the notice says, then sending, is accepted the first time.
	await choose(1);
	await submit();
	await until(`!document.querySelector('article.content form.answer')`);
	expect(await toasts()).not.toContain(REFUSED);
	const calls = answerCalls().slice(before);
	expect(calls).toHaveLength(1);
	expect(calls[0]).toEqual(expect.arrayContaining(['--id=S-1', '--revision=2', `--expected-section-sha256=${sha('b')}`, '--select=1', '--note=我的備註']));
	expect(fixture.listed()[0]!.questions[0]).toMatchObject({ status: 'submitted', answer: 'A. 先觀察' });
}, 30_000);

test.skipIf(!CHROME)('a question re-asked with the same version number but other content counts as revised', async () => {
	const shown = question({ id: 'T-1', title: '文字題', kind: 'text' });
	const luna = fixture.bound('alpha', 'luna', { questions: [shown] });
	fixture.list([luna]);
	await fixture.refresh(cookie);
	await open(luna, 'T-1');
	await fill('article.content form.answer label.field:first-of-type textarea', '打到一半');
	await revise(luna, { ...shown, context: '補了一段背景', section_sha256: sha('c') });
	await until(`document.body.innerText.includes(${JSON.stringify(NOTICE)})`);
	expect(await evaluate(`document.querySelector('article.content form.answer label.field:first-of-type textarea').value`)).toBe('打到一半');
	const before = answerCalls().length;
	await submit();
	await until(`!document.querySelector('article.content form.answer')`);
	const calls = answerCalls().slice(before);
	expect(calls).toHaveLength(1);
	expect(calls[0]).toEqual(expect.arrayContaining(['--revision=1', `--expected-section-sha256=${sha('c')}`, '--text=打到一半']));
}, 30_000);

test.skipIf(!CHROME)('a revision at the moment of sending is still refused with a notice, and choosing again then goes through', async () => {
	const shown = single({ id: 'S-2', title: '送出瞬間改版的題' });
	const luna = fixture.bound('alpha', 'luna', { questions: [shown] });
	fixture.list([luna]);
	await fixture.refresh(cookie);
	await open(luna, 'S-2');
	await choose(1);
	// The board has not heard of the revision, so the page still shows the old version.
	const revised = single({ id: 'S-2', title: '送出瞬間改版的題', revision: 2, section_sha256: sha('d') });
	fixture.list([{ ...luna, questions: [revised] }]);
	await submit();
	await until(`document.body.innerText.includes(${JSON.stringify(REFUSED)})`);
	expect(fixture.listed()[0]!.questions[0]).toMatchObject({ status: 'pending' });

	await fixture.refresh(cookie);
	await until(`document.querySelector('article.content header .id')?.textContent.includes('r2')`);
	expect(await checked()).toEqual([]);
	const before = answerCalls().length;
	await choose(3);
	await submit();
	await until(`!document.querySelector('article.content form.answer')`);
	expect(answerCalls().slice(before)).toHaveLength(1);
	expect(answerCalls().at(-1)).toEqual(expect.arrayContaining(['--revision=2', '--select=3']));
}, 30_000);
