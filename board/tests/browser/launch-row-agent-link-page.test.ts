// A plain agent's launch row on the new-agent form, in a real browser: once the agent is listed
// in Herdr the row has a button to its page, as a controller's row has; while it is not, the row
// has none. The launch list is rewritten in the page, so nothing is launched. Skipped when the host
// has no Chrome.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser } from '../browser.ts';

let fixture: Fixture;
let browser: Browser | undefined;

const send = (method: string, params: object = {}) => browser!.tab.send(method, params);
const evaluate = <T>(expression: string) => browser!.tab.eval<T>(expression);
const until = (expression: string, timeoutMs?: number) => browser!.tab.until(expression, expression, timeoutMs);

const launchRow = (hcomName: string, state: string, time: string) => ({
	id: `launch-${hcomName}`,
	kind: 'launch',
	role: 'agent',
	time,
	client: 'claude',
	folder: '/srv/alpha',
	scope: '/srv/alpha',
	text: '',
	gitInit: false,
	herdrWorkspace: 'wA',
	herdrWorkspaceLabel: 'Alpha',
	workspaceCreated: false,
	hcomName,
	earlierSessions: [],
	outcome: 'ok',
	error: null,
	state,
	controllerId: null,
	follow: null
});
/** The rows the form lists, whatever the log holds: `plain` is the agent Herdr lists below. */
const ROWS = [
	launchRow('plain', 'appeared', '2026-10-25T10:00:00Z'),
	launchRow('ghost', 'starting', '2026-10-25T10:01:00Z'),
	launchRow('lost', 'overdue', '2026-10-25T10:02:00Z'),
	{ ...launchRow('broken', 'failed', '2026-10-25T10:03:00Z'), outcome: 'failed', error: '開不起來' }
];
const BUTTON = `[...document.querySelectorAll('.launches ol li')].map((li) => [li.querySelector('.meta')?.innerText ?? '', [...li.querySelectorAll('button.open')].map((b) => b.innerText)])`;

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	const cookie = await fixture.login('launch-row-agent-link');
	const luna = fixture.bound('alpha', 'luna');
	fixture.report(luna.session_id, { tag: 'DONE', summary: '好了', hcom_name: 'luna', workspace: luna.workspace });
	fixture.list([luna]);
	fixture.setHcom({
		agents: [
			{ name: 'luna', session_id: luna.session_id, status: 'listening', launch_context: { pane_id: 'wA:p-luna' } },
			{ name: 'plain', session_id: 's-plain', status: 'listening', launch_context: { pane_id: 'wA:p-plain' } }
		]
	});
	const herdrAgent = (session: string) => ({
		agent: 'claude',
		agent_session: { kind: 'id', value: session },
		agent_status: 'idle',
		cwd: '/srv/alpha',
		pane_id: `wA:p-${session}`,
		tab_id: `wA:t-${session}`,
		workspace_id: 'wA'
	});
	const agents = [herdrAgent(luna.session_id), herdrAgent('s-plain')];
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents,
			panes: agents.map((agent) => ({ pane_id: agent.pane_id, workspace_id: agent.workspace_id, cwd: agent.cwd })),
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
			tabs: agents.map((agent) => ({ tab_id: agent.tab_id, workspace_id: agent.workspace_id, label: agent.agent_session.value }))
		})
	);
	await fixture.refresh(cookie);
	browser = await launchChrome();
	const [name, value] = cookie.split('=');
	await send('Network.setCookie', { name, value, url: fixture.url });
	await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
	await send('Page.addScriptToEvaluateOnNewDocument', {
		source: `(() => {
			const fetch = window.fetch;
			window.fetch = async (input, init) => {
				const response = await fetch(input, init);
				if (!String(input).endsWith('/api/launches') || (init?.method ?? 'GET') !== 'GET') return response;
				const list = await response.json();
				return new Response(JSON.stringify({ ...list, launches: ${JSON.stringify(ROWS)} }), { status: 200, headers: { 'content-type': 'application/json' } });
			};
		})()`
	});
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

test.skipIf(!CHROME)("a plain agent's launch row leads to its page once Herdr lists it, and nowhere before", async () => {
	await send('Page.navigate', { url: `${fixture.url}/?new-agent=wA` });
	await until(`document.querySelectorAll('.launches ol li').length === ${ROWS.length}`);
	const rows = await evaluate<[string, string[]][]>(BUTTON);
	const byName = Object.fromEntries(rows.map(([meta, buttons]) => [ROWS.find((row) => meta.includes(`@${row.hcomName}`))!.hcomName, buttons]));
	expect(byName).toEqual({ plain: ['看這個 Agent →'], ghost: [], lost: [], broken: [] });

	await evaluate(`[...document.querySelectorAll('.launches ol li button.open')][0].click()`);
	await until(`location.search.includes('agent=s-plain')`);
	await until(`!!document.querySelector('.detail')`);
}, 30_000);
