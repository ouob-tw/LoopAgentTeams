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
import { BUILD_DIR, logged, question, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, TEST_MS, type Browser, type Tab } from '../browser.ts';

/** Runs first in every document: counts the tab's page loads. */
const COUNT_LOADS = `sessionStorage.setItem('test-loads', String(Number(sessionStorage.getItem('test-loads') ?? 0) + 1))`;
const LOADS = `Number(sessionStorage.getItem('test-loads'))`;
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
	fixture = await startFixture({ port: 7182 });
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

async function openBoard() {
	browser = await launchChrome({ scripts: [COUNT_LOADS] });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.navigate(`${fixture.url}/`);
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
	// after the next restart, it stays.
	await deploy();
	await tab.until(checked(1), 'the page loaded again asking which build the server serves');
	await Bun.sleep(3_000);
	expect(await tab.eval<number>(LOADS)).toBe(2);
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
