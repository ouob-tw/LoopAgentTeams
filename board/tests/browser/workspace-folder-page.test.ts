// The folder a workspace's + form starts in, in a real browser: the one the workspace's last agent
// was started in, as the sent log says, across reloads and a board restart; each workspace its own;
// a folder no longer there gives way to the workspace's agents' folder; what is typed stays. What
// the server records for a launch is in tests/server/agent-launch.test.ts. Skipped without Chrome.
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser } from '../browser.ts';

let fixture: Fixture;
let browser: Browser | undefined;
let cookie: string;
let alpha: string;
let gamma: string;
let epsilon: string;
let luna: string;

const send = (method: string, params: object = {}) => browser!.tab.send(method, params);
const evaluate = <T>(expression: string) => browser!.tab.eval<T>(expression);
const until = (expression: string, timeoutMs?: number) => browser!.tab.until(expression, expression, timeoutMs);
const BOX = `document.querySelector('#folder-box')`;

/** A plain agent's launch into `workspace` from `folder`, `minutesAgo` before now, in the sent log. */
function logLaunch(workspace: string, folder: string, minutesAgo: number, outcome = 'started') {
	const time = new Date(Date.now() - minutesAgo * 60_000).toISOString();
	const line = { id: `l-${workspace}-${minutesAgo}`, kind: 'launch', role: 'agent', time, client: 'claude', folder, scope: folder, text: '', gitInit: false, herdrWorkspace: workspace, herdrWorkspaceLabel: workspace, workspaceCreated: false, hcomName: null, earlierSessions: [], outcome, error: outcome === 'failed' ? '測試失敗' : null };
	appendFileSync(join(fixture.dir, 'board-state', 'sent-log.jsonl'), JSON.stringify(line) + '\n');
}

/** Open a workspace's + form, the page loaded afresh. */
async function open(workspace: string) {
	await send('Page.navigate', { url: `${fixture.url}/?new-agent=${workspace}` });
	await until(`!!${BOX}?.value`);
}
const folderShown = () => evaluate<string>(`${BOX}.value`);

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	cookie = await fixture.login('workspace-folder');
	const bound = fixture.bound('alpha', 'luna');
	luna = bound.session_id;
	alpha = bound.workspace;
	mkdirSync(join(alpha, '.git'), { recursive: true });
	fixture.report(luna, { tag: 'DONE', summary: '好了', hcom_name: 'luna', workspace: alpha });
	fixture.list([bound]);
	gamma = join(fixture.dir, 'gamma');
	epsilon = join(fixture.dir, 'epsilon');
	for (const folder of [gamma, epsilon]) mkdirSync(folder);
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents: [{ agent: 'claude', agent_session: { kind: 'id', value: 'herdr-1' }, agent_status: 'idle', cwd: alpha, pane_id: 'p1', tab_id: 'wA:t1', workspace_id: 'wA' }],
			panes: [{ pane_id: 'p1', tab_id: 'wA:t1', workspace_id: 'wA', cwd: alpha }],
			tabs: [{ tab_id: 'wA:t1', workspace_id: 'wA', label: 'luna' }],
			workspaces: [
				{ workspace_id: 'wA', number: 1, label: 'Alpha' },
				{ workspace_id: 'wE', number: 2, label: 'Empty' },
				{ workspace_id: 'wF', number: 3, label: 'Fresh' }
			]
		})
	);
	mkdirSync(join(fixture.dir, 'board-state'), { recursive: true });
	// wA's last agent went to gamma, not the folder its agent works in; wE's to epsilon, and a later
	// failed launch there does not count; wF's to a folder that is gone.
	logLaunch('wE', epsilon, 30);
	logLaunch('wE', alpha, 20, 'failed');
	logLaunch('wF', join(fixture.dir, 'gone'), 10);
	logLaunch('wA', gamma, 5);
	await fixture.refresh(cookie);
	browser = await launchChrome();
	const [name, value] = cookie.split('=');
	await send('Network.setCookie', { name, value, url: fixture.url });
	await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

test.skipIf(!CHROME)("each workspace's + form starts in the folder its last agent was started in, after a reload and a restart too", async () => {
	await open('wA');
	await until(`${BOX}.value === ${JSON.stringify(gamma)}`);
	await open('wE');
	await until(`${BOX}.value === ${JSON.stringify(epsilon)}`);
	// A remembered folder that is gone gives way: wF has no agents, so the most recent folder, the
	// project luna reported from just now.
	await open('wF');
	await until(`${BOX}.value === ${JSON.stringify(alpha)}`);

	await open('wA');
	await send('Page.reload', {});
	await until(`${BOX}?.value === ${JSON.stringify(gamma)}`);
	await fixture.stop();
	await fixture.start();
	await open('wE');
	await until(`${BOX}.value === ${JSON.stringify(epsilon)}`);
	await open('wA');
	await until(`${BOX}.value === ${JSON.stringify(gamma)}`);
}, 60_000);

test.skipIf(!CHROME)('what is typed stays when the lists are read again; a gone folder gives way to the agents\' folder', async () => {
	await open('wA');
	await until(`${BOX}.value === ${JSON.stringify(gamma)}`);
	await evaluate(`(() => { const box = ${BOX}; box.value = '/typed/by/hand'; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
	// A new launch from elsewhere, and a new report for a fresh snapshot, make the form read its
	// lists again; the answer names epsilon as wA's folder now.
	await evaluate(`(() => {
		window.listed = null;
		const fetch = window.fetch;
		window.fetch = async (input, init) => {
			const response = await fetch(input, init);
			if (String(input).endsWith('/api/launches') && !init?.method) response.clone().json().then((list) => (window.listed = list.workspaceFolders.wA));
			return response;
		};
	})()`);
	logLaunch('wA', epsilon, 1);
	fixture.report(luna, { tag: 'DONE', summary: '又好了', hcom_name: 'luna', workspace: alpha });
	await fixture.refresh(cookie);
	await until(`window.listed === ${JSON.stringify(epsilon)}`);
	await Bun.sleep(200);
	expect(await folderShown()).toBe('/typed/by/hand');

	// With the remembered folder gone, wA starts in the folder its agent works in.
	rmSync(epsilon, { recursive: true });
	await open('wA');
	await until(`${BOX}.value === ${JSON.stringify(alpha)}`);
}, 30_000);
