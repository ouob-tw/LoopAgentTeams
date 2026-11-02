// The agent page of one with no hcom hooks: what it says and offers, and how a restart's outcomes
// read. Fakes as in `tests/server/agent-relink.test.ts`. With LAT_RELINK_SHOTS set, each state is
// also saved there as a picture.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHROME, launchChrome, type Browser, type Tab } from '../browser.ts';
import { sleep, startFixture, type Fixture } from '../harness.ts';

const SESSION = 's-plain';
const PANE = 'wA:p1';
const SHOTS = process.env.LAT_RELINK_SHOTS;
const NOTICE = `document.querySelector('.dock .toasts')?.innerText ?? ''`;
const has = (action: string) => `!!document.querySelector('.detail button[data-action="${action}"]')`;

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;
const children: ChildProcess[] = [];
let plain: number;
let hooked: number;
const errors: string[] = [];

const child = (env: Record<string, string>) => {
	const started = spawn('sleep', ['600'], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: 'ignore' });
	children.push(started);
	return started.pid!;
};
const processOf = (pid: number) => ({ pane_id: PANE, shell_pid: 4242, foreground_process_group_id: pid, foreground_processes: [{ pid, name: 'claude', argv: ['claude', '--resume', SESSION] }] });
const herdrAgent = (status = 'idle') => ({ agent: 'claude', agent_session: { kind: 'id', value: SESSION }, agent_status: status, cwd: '/projects/ouob-ops', pane_id: PANE, tab_id: 'wA:t1', workspace_id: 'wA' });
const SCREEN = ['╭', '─'.repeat(40), '❯ ', '─'.repeat(40), '  ⏵⏵ auto mode on (shift+tab to cycle)'].join('\n');
function setHerdr(fields: object = {}) {
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents: [herdrAgent()],
			panes: [{ pane_id: PANE, tab_id: 'wA:t1', workspace_id: 'wA', cwd: '/projects/ouob-ops' }],
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'ouob-ops' }],
			tabs: [{ tab_id: 'wA:t1', workspace_id: 'wA', label: 'modi 維運' }],
			processes: { [PANE]: processOf(plain) },
			screens: { [PANE]: [SCREEN] },
			exitOnPrompt: { [PANE]: true },
			...fields
		})
	);
}
const back = { name: 'modi', session_id: SESSION, status: 'listening', tool: 'claude', process_bound: true, launch_context: { pane_id: PANE } };
const hcomPlan = (fields: object = {}) => ({ holdTerminal: true, agents: [], resumed: back, resumedHerdr: herdrAgent(), resumedProcess: processOf(hooked), names: ['modi'], ...fields });

async function visit(width: number) {
	browser = await launchChrome({});
	tab = browser.tab;
	tab.screen = `({ notices: document.querySelector('.dock')?.innerText ?? '', actions: [...document.querySelectorAll('.detail button[data-action]')].map((button) => button.dataset.action) })`;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width < 761 });
	await tab.send('Runtime.enable', {});
	await tab.send('Page.navigate', { url: `${fixture.url}/?agent=${SESSION}` });
	// Started: the board's first history write is done, so its buttons work.
	await tab.until(`JSON.stringify(history.state).includes('depth')`, 'the board to start');
	await tab.until(has('close'), 'the agent page');
	expect(await tab.eval(`document.documentElement.scrollWidth <= window.innerWidth`)).toBe(true);
}
async function shot(name: string) {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	const { data } = (await tab.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
	writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
}
const press = () => tab.pointerClick('.detail button[data-action="relink"]');

beforeAll(async () => {
	if (!CHROME) return;
	plain = child({});
	hooked = child({ HCOM_PROCESS_ID: 'some-process' });
	fixture = await startFixture({ env: { LAT_BOARD_UNPAUSE_WAIT_SECONDS: '2' } });
	cookie = await fixture.login();
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
}, 30_000);
afterAll(async () => {
	for (const started of children) started.kill();
	await fixture?.cleanup();
});
beforeEach(async () => {
	if (!CHROME) return;
	errors.length = 0;
	rmSync(join(fixture.dir, 'hcom-paused'), { recursive: true, force: true });
	rmSync(join(fixture.dir, 'hcom-added.json'), { force: true });
	writeFileSync(join(fixture.dir, 'transcripts', `${SESSION}.jsonl`), JSON.stringify({ kind: 'user', text: '幫我看維運', time: '2026-11-02T09:00:00Z' }) + '\n');
	fixture.list([]);
	setHerdr();
	fixture.setHcom(hcomPlan());
	await fixture.refresh(cookie);
});
afterEach(async () => {
	await browser?.close();
	browser = undefined;
});

for (const [width, label] of [[1280, 'desktop'], [390, 'phone']] as const) {
	test.skipIf(!CHROME)(`${label}: says why and offers the restart, no pause; a press relinks it and the page then offers the pause`, async () => {
		await visit(width);
		await tab.until(has('relink'), 'the restart button');
		const page = await tab.eval<string>(`document.querySelector('.detail [data-note="no-hooks"]').innerText`);
		expect(page).toContain('它沒有經 hcom 啟動，要重新啟動才能接回 HCOM');
		expect(await tab.eval<string>(`document.querySelector('.detail button[data-action="relink"]').innerText`)).toBe('重新啟動並接回 HCOM');
		expect(await tab.eval(has('pause'))).toBe(false);
		expect(await tab.eval(has('unpause'))).toBe(false);
		await shot(`${label}-1-no-hooks`);
		// Long enough to see the page while the old process is gone and the new one not there yet.
		fixture.setHcom(hcomPlan({ resumeDelayMs: 2_500 }));
		await press();
		await tab.until(`document.querySelector('.detail button[data-action="relink"]')?.innerText === '處理中…'`, 'the press to show');
		await shot(`${label}-2-pressed`);
		// Off Herdr's list now; a read tells the page, which says why rather than that it is gone.
		await sleep(1_000);
		await fixture.refresh(cookie);
		await tab.until(`document.querySelector('.detail')?.innerText.includes('正在重新啟動並接回 HCOM')`, 'the page to say it is restarting');
		await shot(`${label}-2b-restarting`);
		await tab.until(`(${NOTICE}).includes('已重新啟動並接回 HCOM')`, 'the notice');
		await tab.until(has('pause'), 'the pause of a linked agent');
		expect(await tab.eval(has('relink'))).toBe(false);
		expect(await tab.eval(`document.documentElement.scrollWidth <= window.innerWidth`)).toBe(true);
		await shot(`${label}-3-relinked`);
	}, 30_000);
}

test.skipIf(!CHROME)('whatever hcom lists for it, neither the header nor the roster shows it linked', async () => {
	fixture.setHcom(hcomPlan({ agents: [{ name: 'modi', session_id: SESSION, status: 'launching', tool: 'adhoc', process_bound: false, launch_context: { pane_id: PANE } }] }));
	await fixture.refresh(cookie);
	await visit(1280);
	await tab.until(has('relink'), 'the restart button');
	expect(await tab.eval(`document.querySelector('.detail .profile').innerText`)).not.toContain('HCOM\n');
	expect(await tab.eval(`[...document.querySelectorAll('.profile .chip')].some((chip) => chip.innerText.includes('HCOM'))`)).toBe(false);
	expect(await tab.eval(`[...document.querySelectorAll('button.agent')].some((row) => row.innerText.includes('HCOM'))`)).toBe(false);
	await shot('desktop-6-listed-no-hooks');
}, 30_000);

test.skipIf(!CHROME)('a paused one offers the restart, not the resume', async () => {
	mkdirSync(join(fixture.dir, 'hcom-paused'), { recursive: true });
	writeFileSync(join(fixture.dir, 'hcom-paused', `${SESSION}.json`), JSON.stringify({ session_id: SESSION, hcom_name: 'modi', client: 'claude', pane: PANE, paused_at: new Date(Date.now() - 60_000).toISOString() }));
	await visit(1280);
	await tab.until(has('relink'), 'the restart button');
	expect(await tab.eval(has('unpause'))).toBe(false);
	await shot('desktop-4-paused-no-hooks');
}, 30_000);

const outcomes: [string, () => void, string][] = [
	['refused-working', () => setHerdr({ agents: [herdrAgent('working')] }), '它正在工作，沒有重新啟動'],
	['refused-background', () => writeFileSync(join(fixture.dir, 'transcripts', `${SESSION}.jsonl`), [JSON.stringify({ kind: 'user', text: 'x', time: '2026-11-02T09:00:00Z' }), JSON.stringify({ type: 'system', subtype: 'turn_duration', pendingBackgroundAgentCount: 2 })].join('\n') + '\n'), '2 個背景 subagent'],
	['failed-resume', () => fixture.setHcom(hcomPlan({ exit: 1, stderr: 'cannot resume\n', resumed: undefined, resumedHerdr: undefined, resumedProcess: undefined })), '新程序沒有啟動']
];
for (const [name, arrange, says] of outcomes) {
	test.skipIf(!CHROME)(`the notice reads plainly: ${name}`, async () => {
		await visit(1280);
		await tab.until(has('relink'), 'the restart button');
		arrange();
		await press();
		await tab.until(`(${NOTICE}).includes(${JSON.stringify(says)})`, 'the notice');
		await shot(`desktop-5-${name}`);
		if (name === 'failed-resume') await tab.until(`document.querySelector('.detail')?.innerText.includes('已不在 Herdr 的清單上')`, 'the page to show it is gone');
	}, 30_000);
}
