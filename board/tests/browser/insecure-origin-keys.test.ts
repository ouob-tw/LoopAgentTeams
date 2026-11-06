// The 按鍵面板 on a page that is not a secure context: the board opened by plain http under a name
// that is not localhost, as from a phone on the LAN. There `crypto.randomUUID` does not exist, and a
// press must still reach the pane. Chrome maps the name to the test board (--host-resolver-rules).
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { jsonLines, sleep, startFixture, type Fixture } from '../harness.ts';
import { launchChrome, type Browser } from '../browser.ts';

const PANE = 'wA:p-s-plain';
let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;

beforeAll(async () => {
	fixture = await startFixture({ env: { LAT_BOARD_HERDR_TIMEOUT_SECONDS: '2' } });
	cookie = await fixture.login('insecure-keys');
	fixture.setHcom({ agents: [] });
	const agent = { agent: 'claude', agent_session: { kind: 'id', value: 's-plain' }, agent_status: 'blocked', cwd: '/home/someone/projects/s-plain', pane_id: PANE, tab_id: 'wA:t-s-plain', workspace_id: 'wA' };
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents: [agent],
			panes: [{ pane_id: PANE, workspace_id: 'wA', cwd: agent.cwd, tab_id: agent.tab_id }],
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
			tabs: [{ tab_id: agent.tab_id, workspace_id: 'wA', label: '分頁-plain' }],
			screens: { [PANE]: ['Do you want to proceed?'] }
		})
	);
	await fixture.refresh(cookie);
}, 30_000);
afterAll(async () => {
	await fixture?.cleanup();
});
afterEach(async () => {
	await browser?.close();
	browser = undefined;
});

test('phone on a non-secure http origin: a key press reaches the pane', async () => {
	rmSync(join(fixture.dir, 'herdr-calls.jsonl'), { force: true });
	const origin = `http://board.lan.test:${new URL(fixture.url).port}`;
	browser = await launchChrome({ screen: `document.querySelector('.detail')?.innerText ?? ''`, args: ['--host-resolver-rules=MAP board.lan.test 127.0.0.1'] });
	const tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: origin });
	await tab.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
	await tab.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
	await tab.send('Page.navigate', { url: `${origin}/?agent=s-plain` });
	await tab.until(`JSON.stringify(history.state).includes('depth')`, 'the board to start');
	// The premise: this page is not a secure context and has no randomUUID.
	expect(await tab.eval(`[window.isSecureContext, typeof crypto.randomUUID]`)).toEqual([false, 'undefined']);
	await tab.eval(`[...document.querySelectorAll('.detail [role=tab]')].find((tab) => tab.firstChild.textContent.trim() === '終端').click()`);
	await tab.until(`!!document.querySelector('.screen-panel pre')`, 'the screen');
	await tab.until(`!!document.querySelector('.dock .keys-pane')`, 'the 按鍵面板');
	await tab.swipeOn('.dock textarea', -200);
	const KEYS = `[...document.querySelectorAll('.dock .keys-pane button.key')]`;
	const pane = `document.querySelector('.dock .keys-pane')`;
	await tab.until(`${KEYS}.length === 13 && ${KEYS}.every((button) => !button.disabled) && ${pane}.getBoundingClientRect().left <= document.querySelector('.dock').getBoundingClientRect().left + 2`, 'the 按鍵面板 shown');
	await tab.eval(`${KEYS}.find((button) => button.innerText === 'Esc').click()`);
	const deadline = Date.now() + 5_000;
	while (jsonLines(join(fixture.dir, 'herdr-calls.jsonl')).length < 1 && Date.now() < deadline) await sleep(50);
	expect(jsonLines(join(fixture.dir, 'herdr-calls.jsonl'))).toEqual([['pane', 'send-keys', PANE, 'esc']]);
});
