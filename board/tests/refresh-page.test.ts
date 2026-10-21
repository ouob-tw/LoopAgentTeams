// Refresh acceptance in a real browser with fake hcom/Herdr/helper services only.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { question, sleep, startFixture, type Fixture } from './harness.ts';
import { CHROME, launchChrome, type Browser, type Tab } from './browser.ts';
const COUNT_POPSTATE = `(() => { const add = window.addEventListener; window.popstateListeners = 0; window.addEventListener = function(type, ...rest) { if (type === 'popstate') window.popstateListeners++; return add.call(this, type, ...rest); }; })()`;
const STARTED = `window.popstateListeners >= 2`;
const SCREEN = `document.body.innerText`;
let fixture: Fixture, cookie: string, browser: Browser, tab: Tab;
let controller: ReturnType<Fixture['bound']>;
beforeAll(async () => {
	if (!CHROME)
		return;
	fixture = await startFixture({ env: { LAT_BOARD_LAUNCH_WAIT_SECONDS: '2' } });
	cookie = await fixture.login();
	controller = fixture.bound('alpha', 'tavi', { herdr_workspace: 'wA', herdr_tab: 'wA:t2', questions: [question({ id: 'Q-214' })] });
	fixture.list([controller]);
	writeFileSync(join(fixture.dir, 'herdr.json'), JSON.stringify({ workspaces: [{ workspace_id: 'wA', number: 3, label: 'Alpha' }], tabs: [{ tab_id: 'wA:t1', workspace_id: 'wA', label: 'shell' }, { tab_id: 'wA:t2', workspace_id: 'wA', label: 'controller' }], agents: [] }));
	await fixture.refresh(cookie);
	browser = await launchChrome({ scripts: [COUNT_POPSTATE], screen: SCREEN });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const fetch = window.fetch; window.requests214 = []; window.fetch = (...args) => { window.requests214.push(String(args[0])); return fetch(...args); }; })()` });
}, 30000);
afterAll(async () => {
	await browser?.close();
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
