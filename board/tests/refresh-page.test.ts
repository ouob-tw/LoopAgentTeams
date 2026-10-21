// Refresh acceptance in a real browser with fake hcom/Herdr/helper services only.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PORT_BASE, question, sleep, startFixture, type Fixture } from './harness.ts';
const CHROME = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium'].find(path => path && existsSync(path));
const DEBUG_PORT = PORT_BASE + 89;
const COUNT_POPSTATE = `(() => { const add = window.addEventListener; window.popstateListeners = 0; window.addEventListener = function(type, ...rest) { if (type === 'popstate') window.popstateListeners++; return add.call(this, type, ...rest); }; })()`;
const STARTED = `window.popstateListeners >= 2`;
const SCREEN = `document.body.innerText`;
/** One Chrome tab, spoken to over the DevTools protocol. */
class Tab {
	#socket: WebSocket;
	#next = 0;
	#waiting = new Map<number, (message: {
		result?: unknown;
		error?: {
			message: string;
		};
	}) => void>();
	/** The documents that have loaded, by the loader that loaded them. */
	#loaded = new Set<string>();
	constructor(socket: WebSocket) {
		this.#socket = socket;
		socket.addEventListener('message', (event) => {
			const message = JSON.parse(String(event.data));
			if (message.method === 'Page.lifecycleEvent' && message.params.name === 'load')
				this.#loaded.add(message.params.loaderId);
			this.#waiting.get(message.id)?.(message);
			this.#waiting.delete(message.id);
		});
	}
	static async open(): Promise<Tab> {
		const deadline = Date.now() + 10000;
		let target: {
			webSocketDebuggerUrl: string;
		} | undefined;
		while (!target) {
			if (Date.now() > deadline)
				throw new Error('timed out waiting for Chrome to listen');
			target = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' }).then((response) => response.json(), () => undefined);
			if (!target)
				await sleep(100);
		}
		const socket = new WebSocket(target.webSocketDebuggerUrl);
		await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
		const tab = new Tab(socket);
		await tab.send('Page.enable');
		await tab.send('Page.setLifecycleEventsEnabled', { enabled: true });
		await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: COUNT_POPSTATE });
		return tab;
	}
	send(method: string, params: object = {}): Promise<any> {
		const id = ++this.#next;
		this.#socket.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => this.#waiting.set(id, (message) => (message.error ? reject(new Error(message.error.message)) : resolve(message.result))));
	}
	async eval<T = unknown>(expression: string): Promise<T> {
		const { result, exceptionDetails } = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
		if (exceptionDetails)
			throw new Error(`${expression}: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
		return result.value;
	}
	/** Load a new document and wait until it has loaded. */
	async navigate(url: string) {
		const { loaderId, errorText } = await this.send('Page.navigate', { url });
		if (errorText)
			throw new Error(`${url}: ${errorText}`);
		const deadline = Date.now() + 10000;
		while (!this.#loaded.has(loaderId)) {
			if (Date.now() > deadline)
				throw new Error(`timed out loading ${url}`);
			await sleep(20);
		}
	}
	async until(expression: string, what = expression) {
		const deadline = Date.now() + 10000;
		while (!(await this.eval(expression).catch(() => false))) {
			if (Date.now() > deadline)
				throw new Error(`timed out waiting for ${what}; the page shows ${JSON.stringify(await this.eval(SCREEN))}`);
			await sleep(50);
		}
	}
	close() {
		this.#socket.close();
	}
}
let fixture: Fixture, cookie: string, chrome: ChildProcess, profile: string, tab: Tab;
let controller: ReturnType<Fixture['bound']>;
beforeAll(async () => {
	if (!CHROME)
		return;
	fixture = await startFixture(88, { env: { LAT_BOARD_LAUNCH_WAIT_SECONDS: '2' } });
	cookie = await fixture.login();
	controller = fixture.bound('alpha', 'tavi', { herdr_workspace: 'wA', herdr_tab: 'wA:t2', questions: [question({ id: 'Q-214' })] });
	fixture.list([controller]);
	writeFileSync(join(fixture.dir, 'herdr.json'), JSON.stringify({ workspaces: [{ workspace_id: 'wA', number: 3, label: 'Alpha' }], tabs: [{ tab_id: 'wA:t1', workspace_id: 'wA', label: 'shell' }, { tab_id: 'wA:t2', workspace_id: 'wA', label: 'controller' }], agents: [] }));
	await fixture.refresh(cookie);
	profile = mkdtempSync(join(tmpdir(), 'lat-214-chrome-'));
	chrome = spawn(CHROME!, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`, `--remote-debugging-port=${DEBUG_PORT}`, 'about:blank'], { stdio: 'ignore' });
	tab = await Tab.open();
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const fetch = window.fetch; window.requests214 = []; window.fetch = (...args) => { window.requests214.push(String(args[0])); return fetch(...args); }; })()` });
}, 30000);
afterAll(async () => {
	if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
		tab.close();
		const exited = new Promise(resolve => chrome.once('exit', resolve));
		chrome.kill('SIGKILL');
		await exited;
	}
	if (profile)
		rmSync(profile, { recursive: true, force: true });
	await fixture?.cleanup();
});
const count = (path: string) => tab.eval<number>(`window.requests214.filter(url => url.split('?')[0] === ${JSON.stringify(path)}).length`);
async function navigate(path: string) { await tab.navigate(fixture.url + path); await tab.until(STARTED); }
test.skipIf(!CHROME)('five snapshot pushes reuse location/history; a recorded answer reloads history once; moving a tab updates its next snapshot', async () => {
	await navigate('/?controller=' + controller.session_id);
	await tab.until(`document.querySelector('.profile h2')?.innerText === 'alpha'`);
	await tab.until(`window.requests214.some(url => url.startsWith('/api/answered'))`);
	const answered = await count('/api/answered');
	const more = `[...document.querySelectorAll('.profile button')].find(b => b.innerText.includes('詳細資料'))`;
	await tab.eval(`${more}.click()`);
	await tab.until(`document.querySelector('.profile dl')?.innerText.includes('controller')`);
	expect(await tab.eval<string>(`document.querySelector('.profile dl').innerText`)).toContain('2');
	for (let index = 0; index < 5; index++) {
		fixture.report(controller.session_id, { tag: '', summary: 'push-' + index, hcom_name: 'tavi', workspace: controller.workspace });
		await fixture.refresh(cookie);
		await tab.until(`document.querySelector('.profile .phase')?.innerText === 'push-${index}'`);
	}
	expect(await count('/api/answered')).toBe(answered);
	expect(await count('/api/herdr-place')).toBe(0);
	const listFile = join(fixture.dir, 'herdr-list-calls.jsonl');
	expect(existsSync(listFile) ? readFileSync(listFile, 'utf8') : '').toBe('');
	const response = await fixture.fetch('/api/agents/tab/move', { method: 'POST', cookie, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: null, workspace: 'wA', tab: 'wA:t2', onto: 'wA:t1' }) });
	expect(response.status).toBe(200);
	await tab.until(`document.querySelector('.profile dl')?.innerText.includes('分頁#1')`);
	controller.questions[0] = { ...controller.questions[0], status: 'recorded', answer: 'A', recorded_at: new Date().toISOString() };
	fixture.list([controller]);
	await fixture.refresh(cookie);
	await tab.until(`window.requests214.filter(url=>url.startsWith('/api/answered')).length === ${answered + 1}`);
	await sleep(200);
	expect(await count('/api/answered')).toBe(answered + 1);
}, 30000);
test.skipIf(!CHROME)('an idle new-controller page stays open for forty seconds with no timer reload; a waiting launch reloads once at expiry', async () => {
	await navigate('/?launch');
	await tab.until(`window.requests214.includes('/api/launches')`);
	await sleep(300);
	const before = await count('/api/launches');
	const defaultsBefore = await count('/api/launches/defaults');
	await sleep(40000);
	expect(await count('/api/launches')).toBe(before);
	expect(await count('/api/launches/defaults')).toBe(defaultsBefore);
	const time = new Date().toISOString();
	const launch = { kind: 'launch', id: 'pending-214', time, client: 'claude', folder: controller.workspace, scope: controller.workspace, text: '', gitInit: false, herdrWorkspace: 'wA', herdrWorkspaceLabel: 'Alpha', workspaceCreated: false, hcomName: 'waiting214', earlierSessions: [], outcome: 'started', error: null };
	writeFileSync(join(fixture.dir, 'board-state', 'sent-log.jsonl'), JSON.stringify(launch) + '\n');
	await navigate('/?launch');
	await tab.until(`document.body.innerText.includes('啟動中，等主控啟用')`);
	// The opening SSE snapshot can replace the SSR stamp, causing the retained stamp reload.
	await sleep(300);
	const starting = await count('/api/launches');
	await tab.until(`document.body.innerText.includes('已開分頁，但主控尚未啟用')`);
	expect(await count('/api/launches')).toBe(starting + 1);
	await sleep(2500);
	expect(await count('/api/launches')).toBe(starting + 1);
}, 60000);
