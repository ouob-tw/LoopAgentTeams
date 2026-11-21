// Refresh acceptance in a real browser with fake hcom/Herdr/helper services only.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { question, sleep, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, TEST_MS, type Browser, type Tab } from '../browser.ts';
const COUNT_POPSTATE = `(() => { const add = window.addEventListener; window.popstateListeners = 0; window.addEventListener = function(type, ...rest) { if (type === 'popstate') window.popstateListeners++; return add.call(this, type, ...rest); }; })()`;
const STARTED = `window.popstateListeners >= 2`;
const SCREEN = `document.body.innerText`;
let fixture: Fixture, cookie: string, browser: Browser, tab: Tab;
let controller: ReturnType<Fixture['bound']>;
beforeAll(async () => {
	if (!CHROME)
		return;
	// A launch stays pending eight seconds: room for the page to open and handle its opening reads
	// before the expiry read, even on a busy host.
	fixture = await startFixture({ env: { LAT_BOARD_LAUNCH_WAIT_SECONDS: '8' } });
	cookie = await fixture.login();
	controller = fixture.bound('alpha', 'tavi', { herdr_workspace: 'wA', herdr_tab: 'wA:t2', questions: [question({ id: 'Q-214' })] });
	fixture.list([controller]);
	writeFileSync(join(fixture.dir, 'herdr.json'), JSON.stringify({ workspaces: [{ workspace_id: 'wA', number: 3, label: 'Alpha' }], tabs: [{ tab_id: 'wA:t1', workspace_id: 'wA', label: 'shell' }, { tab_id: 'wA:t2', workspace_id: 'wA', label: 'controller' }], agents: [] }));
	await fixture.refresh(cookie);
	browser = await launchChrome({ scripts: [COUNT_POPSTATE], screen: SCREEN });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${trackRequests})()` });
}, 30000);
afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});
const count = (path: string) => tab.eval<number>(`window.requests214.filter(url => url.split('?')[0] === ${JSON.stringify(path)}).length`);
/**
 * Runs in the page before its own scripts. Records each request the page makes (`requests214`),
 * the snapshots the event stream brings (`boardEvents214`), and how many snapshots and answers the
 * page has not finished handling yet (`pending214`). One is handled a task after it came in, or after
 * its body was read: the stream's reader and the page's own get the same chunk in the same task, and
 * what the page does with it (set the snapshot, rerun its effects, start the reads they make) runs
 * in microtasks before that.
 */
function trackRequests() {
	const send = window.fetch;
	const page = window as unknown as { requests214: string[]; boardEvents214: number; pending214: number };
	page.requests214 = [];
	page.boardEvents214 = 0;
	page.pending214 = 0;
	const handled = () => setTimeout(() => page.pending214--);
	window.fetch = ((...args: Parameters<typeof fetch>) => {
		const url = String(args[0]);
		page.requests214.push(url);
		const answer = send(...args);
		if (url === '/api/events') {
			answer.then(async (response) => {
				const reader = response.clone().body!.pipeThrough(new TextDecoderStream()).getReader();
				for (let text = ''; ; ) {
					const { done, value } = await reader.read();
					if (done) return;
					text += value;
					for (let end; (end = text.indexOf('\n\n')) >= 0; text = text.slice(end + 2)) {
						if (!text.slice(0, end).split('\n').includes('event: board')) continue;
						page.boardEvents214++;
						page.pending214++;
						handled();
					}
				}
			}).catch(() => {}); // The stream ends with an error when the page leaves.
			return answer;
		}
		// The reads whose answers can start a launch-list read: the list, its defaults, and the
		// snapshot a page asks for when it opens.
		if (!url.startsWith('/api/launches') && url !== '/api/refresh') return answer;
		page.pending214++;
		return answer.then((response) => {
			const json = response.json.bind(response);
			response.json = () => json().finally(handled);
			return response;
		}, (error) => {
			handled();
			throw error;
		});
	}) as typeof fetch;
}
/**
 * The new-controller form reads the launch list when it opens and again for each new snapshot; the
 * defaults also each time the list comes in. A page that has just opened gets its snapshots from
 * the stream's first event and from the refresh it asks for; once both and every read they started
 * are handled, nothing but a timer can make another read. Returns the launch-list reads by then.
 */
async function openingReads() {
	await tab.until(`window.boardEvents214 >= 1 && window.requests214.includes('/api/refresh') && window.pending214 === 0`, 'the opening snapshots and the reads they start, all handled');
	return count('/api/launches');
}
async function navigate(path: string) { await tab.navigate(fixture.url + path); await tab.boardStarted({ started: STARTED }); }
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
}, TEST_MS);
test.skipIf(!CHROME)('an idle new-controller page stays open for forty seconds with no timer reload; a waiting launch reloads once at expiry', async () => {
	await navigate('/?launch');
	const before = await openingReads();
	const defaultsBefore = await count('/api/launches/defaults');
	await sleep(40000);
	expect(await count('/api/launches')).toBe(before);
	expect(await count('/api/launches/defaults')).toBe(defaultsBefore);
	const time = new Date().toISOString();
	const launch = { kind: 'launch', id: 'pending-214', time, client: 'claude', folder: controller.workspace, scope: controller.workspace, text: '', gitInit: false, herdrWorkspace: 'wA', herdrWorkspaceLabel: 'Alpha', workspaceCreated: false, hcomName: 'waiting214', earlierSessions: [], outcome: 'started', error: null };
	writeFileSync(join(fixture.dir, 'board-state', 'sent-log.jsonl'), JSON.stringify(launch) + '\n');
	await navigate('/?launch');
	await tab.until(`document.body.innerText.includes('啟動中，等主控啟用')`);
	const starting = await openingReads();
	await tab.until(`document.body.innerText.includes('已開分頁，但主控尚未啟用')`);
	// The timer reloads once; the roster's card of this launch turning overdue (#689) is new board
	// data, which reloads the list once more. Nothing reloads after that.
	await sleep(2500);
	const expired = await count('/api/launches');
	expect(expired).toBeGreaterThanOrEqual(starting + 1);
	expect(expired).toBeLessThanOrEqual(starting + 2);
	await sleep(2500);
	expect(await count('/api/launches')).toBe(expired);
}, 70000);
