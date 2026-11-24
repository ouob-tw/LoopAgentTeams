// A page left open across a deploy loads the new build by itself, once, at a moment nothing is
// lost; a page whose code fails against the new server's data loads it at once instead of staying
// on the error page. In a real browser: headless Chrome driven over its DevTools protocol, on the
// built board with fake data. The deploy is the server restarted on a copy of the build that names
// another version: the page open before it runs the "old" build. The page loaded again runs the
// same scripts, so it still differs from the server, which is what shows it reloads only once.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { BUILD_DIR, jsonLines, logged, NODE, question, startFixture, type Fixture } from '../harness.ts';
import { CHROME, fakeMic, launchChrome, TEST_MS, type Browser, type Tab } from '../browser.ts';

/** Runs first in every document: counts the tab's page loads. */
const COUNT_LOADS = `sessionStorage.setItem('test-loads', String(Number(sessionStorage.getItem('test-loads') ?? 0) + 1))`;
const LOADS = `Number(sessionStorage.getItem('test-loads'))`;
/** The page makes more requests than Chrome keeps timings of by default (250): the checks come late. */
const KEEP_TIMINGS = `performance.setResourceTimingBufferSize(100000)`;
const BOX = '.cmd textarea';

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;
/** The copy of the tested build that names another version: the "new" build. */
let copy: string;
let next: string;

beforeAll(async () => {
	if (!CHROME) return;
	const board = join(import.meta.dir, '../..');
	copy = mkdtempSync(join(tmpdir(), 'lat-board-next-build-'));
	cpSync(join(board, BUILD_DIR), join(copy, 'build'), { recursive: true });
	// Its server's own packages, found from the copy as from the tested build.
	symlinkSync(join(board, 'node_modules'), join(copy, 'node_modules'));
	cpSync(join(board, 'package.json'), join(copy, 'package.json'));
	const versionFile = join(copy, 'build/client/_app/version.json');
	next = `${JSON.parse(readFileSync(versionFile, 'utf8')).version}-next`;
	const body = JSON.stringify({ version: next });
	const br = brotliCompressSync(body);
	const gz = gzipSync(body);
	writeFileSync(versionFile, body);
	writeFileSync(versionFile + '.br', br);
	writeFileSync(versionFile + '.gz', gz);
	// The server knows each file's sizes from the build, and sends that many bytes.
	const adapter = join(copy, 'build/adapter-node.js');
	const entry = /(\\"\/_app\/version\.json\\",\{\\"file\\":\\"_app\/version\.json\\",\\"size\\":)\d+(,\\"etag\\":\\"[^\\]*\\",\\"gz\\":)\d+(,\\"br\\":)\d+/;
	const served = readFileSync(adapter, 'utf8');
	if (!entry.test(served)) throw new Error("the build's file list no longer has version.json as this test expects");
	writeFileSync(adapter, served.replace(entry, `$1${Buffer.byteLength(body)}$2${gz.length}$3${br.length}`));
	// Messages the board puts into a controller's terminal are written here instead.
	fixture = await startFixture({ port: 7182, env: { LAT_BOARD_INJECT_COMMAND: JSON.stringify([NODE, join(import.meta.dir, '../fake-inject.mjs'), copy]) } });
	cookie = await fixture.login('build-update');
}, 60_000);

beforeEach(async () => {
	if (!CHROME) return;
	fixture.list([fixture.bound('alpha', 'luna', { questions: [question({ id: 'D-1', title: '問一' })] })]);
	await fixture.refresh(cookie);
});

afterEach(async () => {
	await browser?.close();
	browser = undefined;
	// Each test starts on the tested build.
	if (fixture) {
		await fixture.stop();
		await fixture.start();
	}
});

afterAll(async () => {
	await fixture?.cleanup();
	if (copy) rmSync(copy, { recursive: true, force: true });
});

async function openBoard({ path = '/', scripts = [] as string[] } = {}) {
	browser = await launchChrome({ scripts: [COUNT_LOADS, KEEP_TIMINGS, ...scripts] });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.navigate(`${fixture.url}${path}`);
	await tab.boardStarted();
	expect(await tab.eval<number>(LOADS)).toBe(1);
}

/** The server restarted, as a deploy does: on the "new" build, or on the same one. */
async function restart(build?: string) {
	await fixture.stop('SIGTERM');
	await fixture.start(build ? { build } : {});
}
const deploy = () => restart(join(copy, 'build/index.js'));

/** The page asked which build the server serves at least `count` times. */
const checked = (count: number) => `performance.getEntriesByType('resource').filter((entry) => entry.name.endsWith('/_app/version.json')).length >= ${count}`;

const type = (text: string) =>
	tab.eval(`(() => { const box = document.querySelector(${JSON.stringify(BOX)}); box.focus(); box.value = ${JSON.stringify(text)}; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);

const failingData = async () => {
	// Two questions with one id: the rail's keyed list cannot hold both, and the page fails.
	fixture.list([fixture.bound('alpha', 'luna', { questions: [question({ id: 'D-1', title: '重複一' }), question({ id: 'D-1', title: '重複二' })] })]);
	await fixture.refresh(cookie);
};

test.skipIf(!CHROME)('a restart on the same build: the page asks once the feed is back, and does not reload', async () => {
	await openBoard();
	await restart();
	await tab.until(checked(1), 'the page asking which build the server serves');
	await Bun.sleep(2_000);
	expect(await tab.eval<number>(LOADS)).toBe(1);
}, TEST_MS);

test.skipIf(!CHROME)('a deploy under an open page: it loads the new build by itself, and only once', async () => {
	await openBoard();
	await deploy();
	await tab.until(`${LOADS} === 2`, 'the page loaded again');
	await tab.boardStarted();
	expect(await tab.eval<string>('document.body.innerText')).not.toContain('Internal Error');
	// The page loaded again still differs from the server (the same scripts): when it asks again,
	// it stays.
	// Shown again, as a tab brought back is; repeated, as a page just loaded may miss the first.
	await tab.until(`(document.dispatchEvent(new Event('visibilitychange')), ${checked(1)})`, 'the page loaded again asking which build the server serves');
	await Bun.sleep(3_000);
	expect(await tab.eval<number>(LOADS)).toBe(2);
	// A restart may be the one that serves it at last: one more reload.
	await deploy();
	await tab.until(`${LOADS} === 3`, 'the page loaded again after the next restart');
}, TEST_MS);

test.skipIf(!CHROME)('an answer begun on a question holds the reload until it is sent', async () => {
	const options = [
		{ letter: 'A', label: '照做', impact: '', recommended: true },
		{ letter: 'B', label: '先不要', impact: '', recommended: false }
	];
	fixture.list([fixture.bound('alpha', 'luna', { questions: [question({ id: 'D-2', title: '選一個', kind: 'single', options })] })]);
	await fixture.refresh(cookie);
	await openBoard();
	await tab.eval(`[...document.querySelectorAll('button')].find((button) => button.textContent.includes('選一個'))?.click()`);
	await tab.until(`!!document.querySelector('input[type=radio]')`, 'the question card');
	await tab.eval(`document.querySelector('input[type=radio]').click()`);
	await deploy();
	await tab.until(checked(1), 'the page asking which build the server serves');
	await Bun.sleep(3_000);
	expect(await tab.eval<number>(LOADS)).toBe(1);

	await tab.eval(`[...document.querySelectorAll('button')].find((button) => button.textContent.includes('送出答覆')).click()`);
	await tab.until(`${LOADS} === 2`, 'the page loaded again once the answer was sent');
}, TEST_MS);

test.skipIf(!CHROME)('unsent text holds the reload until the box is cleared', async () => {
	await openBoard();
	await tab.until(`!!document.querySelector(${JSON.stringify(BOX)})`, 'the command line');
	await type('還沒送出的話');
	await deploy();
	await tab.until(checked(1), 'the page asking which build the server serves');
	await Bun.sleep(3_000);
	expect(await tab.eval<number>(LOADS)).toBe(1);
	expect(await tab.eval<string>(`document.querySelector(${JSON.stringify(BOX)}).value`)).toBe('還沒送出的話');

	await type('');
	await tab.until(`${LOADS} === 2`, 'the page loaded again once the box was empty');
}, TEST_MS);

test.skipIf(!CHROME)("an old page whose code fails on the new server's data loads the new build at once, not the error page", async () => {
	await openBoard();
	await tab.until(`!!document.querySelector(${JSON.stringify(BOX)})`, 'the command line');
	// Text in the box keeps the watch from reloading first: only the failure does.
	await type('還沒送出的話');
	await deploy();
	await tab.until(checked(1), 'the page asking which build the server serves');
	// The page loaded again waits until the data is right again, as the new build's code reads it.
	await tab.send('Fetch.enable', { patterns: [{ urlPattern: `${fixture.url}/*`, resourceType: 'Document' }] });
	const from = fixture.serverOutput().length;
	await failingData();
	const deadline = Date.now() + 15_000;
	while (!tab.paused.length && Date.now() < deadline) await Bun.sleep(50);
	expect(tab.paused.length).toBeGreaterThan(0);
	fixture.list([fixture.bound('alpha', 'luna', { questions: [question({ id: 'D-1', title: '問一' })] })]);
	await fixture.refresh(cookie);
	for (const id of tab.paused.splice(0)) await tab.send('Fetch.continueRequest', { requestId: id });
	await tab.send('Fetch.disable');

	await tab.until(`${LOADS} === 2`, 'the page loaded again');
	await tab.boardStarted();
	expect(await tab.eval<string>('document.body.innerText')).not.toContain('Internal Error');
	// The report says it came from a page on another build.
	const failure = logged(fixture.serverOutput().slice(from), 'client_error').find((line) => line.kind === 'handleError');
	expect(failure).toMatchObject({ exc_message: 'svelte:each_key_duplicate', build: 'other' });
}, TEST_MS);

test.skipIf(!CHROME)('an old page that keeps failing after loading the new build once stays on the error page, no reload loop', async () => {
	await openBoard();
	await tab.until(`!!document.querySelector(${JSON.stringify(BOX)})`, 'the command line');
	await type('還沒送出的話');
	await deploy();
	await tab.until(checked(1), 'the page asking which build the server serves');
	await failingData();
	await tab.until(`${LOADS} === 2`, 'the page loaded again');
	await tab.until(`document.body.innerText.includes('Internal Error')`, 'the error page of the page loaded again');
	await Bun.sleep(3_000);
	expect(await tab.eval<number>(LOADS)).toBe(2);
}, TEST_MS);

/** Deployed under the page while something holds the reload: the page asks, and stays. */
async function deployHeld() {
	await deploy();
	await tab.until(checked(1), 'the page asking which build the server serves');
	await Bun.sleep(3_000);
	expect(await tab.eval<number>(LOADS)).toBe(1);
}

/** The board on the controller's own page: its message box sends to it. */
const openController = async (scripts: string[] = []) => {
	fixture.list([fixture.bound('alpha', 'luna', { session_id: 's-luna' })]);
	// Running in a Herdr pane, so a message reaches its terminal.
	fixture.setHcom({ agents: [{ name: 'luna', session_id: 's-luna', status: 'listening', launch_context: { pane_id: 'wA:p-s-luna' } }] });
	const agent = { agent: 'claude', agent_session: { kind: 'id', value: 's-luna' }, agent_status: 'idle', cwd: '/work/luna', pane_id: 'wA:p-s-luna', tab_id: 'wA:t-s-luna', workspace_id: 'wA' };
	writeFileSync(join(fixture.dir, 'herdr.json'), JSON.stringify({ agents: [agent], workspaces: [{ workspace_id: 'wA', number: 1, label: 'A' }], tabs: [{ tab_id: 'wA:t-s-luna', workspace_id: 'wA', label: 's-luna' }] }));
	await fixture.refresh(cookie);
	await openBoard({ path: '/?controller=s-luna', scripts });
	await tab.until(`!!document.querySelector(${JSON.stringify(BOX)})`, 'the message box');
};
const SEND = '.cmd .send-slot button[aria-label="送出"]';

test.skipIf(!CHROME)('a message typed in the message box holds the reload until it is sent', async () => {
	await openController();
	await type('部署時還沒送出');
	await deployHeld();
	await tab.until(`!document.querySelector(${JSON.stringify(SEND)}).disabled`, 'the send button');
	await tab.eval(`document.querySelector(${JSON.stringify(SEND)}).click()`);
	await tab.until(`${LOADS} === 2`, 'the page loaded again once the message was sent');
	await tab.boardStarted();
	// Sent, not dropped: it reached the terminal, and the box loaded again has nothing left to send.
	expect(JSON.stringify(jsonLines(join(copy, 'inject-calls.jsonl')))).toContain('部署時還沒送出');
	await tab.until(`!!document.querySelector(${JSON.stringify(BOX)})`, 'the message box loaded again');
	expect(await tab.eval<string>(`document.querySelector(${JSON.stringify(BOX)}).value`)).toBe('');
}, TEST_MS);

test.skipIf(!CHROME)('a file attached in the message box holds the reload until it is removed', async () => {
	const file = join(copy, 'note.txt');
	writeFileSync(file, '附件內容');
	await openController();
	const { root } = await tab.send('DOM.getDocument');
	const { nodeId } = await tab.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.cmd input[type=file]' });
	await tab.send('DOM.setFileInputFiles', { nodeId, files: [file] });
	await tab.until(`document.querySelectorAll('.cmd .tray li').length === 1`, 'the attached file');
	await deployHeld();
	await tab.eval(`document.querySelector('.cmd .tray button.remove').click()`);
	await tab.until(`${LOADS} === 2`, 'the page loaded again once the file was removed');
}, TEST_MS);

test.skipIf(!CHROME)('a recording in progress holds the reload until it ends', async () => {
	await openController([`localStorage.setItem('lat-board-voice', '1')`, fakeMic('錄到的話')]);
	const mic = '.cmd .voice-slot button.mic';
	await tab.until(`document.querySelector(${JSON.stringify(mic)})?.dataset.voice === 'idle'`, 'the mic');
	await tab.pointerClick(mic);
	await tab.until(`document.querySelector(${JSON.stringify(mic)}).dataset.voice === 'recording'`, 'recording');
	await deployHeld();
	expect(await tab.eval<string>(`document.querySelector(${JSON.stringify(mic)}).dataset.voice`)).toBe('recording');
	await tab.pointerClick(mic);
	// What was said goes into the box, which then holds the reload itself until it is cleared.
	await tab.until(`document.querySelector(${JSON.stringify(BOX)}).value.includes('錄到的話')`, 'the speech in the box');
	await Bun.sleep(1_500);
	expect(await tab.eval<number>(LOADS)).toBe(1);
	await type('');
	await tab.until(`${LOADS} === 2`, 'the page loaded again once the recording ended and the box was cleared');
}, TEST_MS);

test.skipIf(!CHROME)('a press held down (a drag) holds the reload until it is let go', async () => {
	await openBoard();
	await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 600, y: 400 });
	await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 600, y: 400, button: 'left', clickCount: 1 });
	await deployHeld();
	await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 640, y: 420, button: 'left' });
	await Bun.sleep(1_000);
	expect(await tab.eval<number>(LOADS)).toBe(1);
	await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 640, y: 420, button: 'left', clickCount: 1 });
	await tab.until(`${LOADS} === 2`, 'the page loaded again once the press was let go');
}, TEST_MS);
