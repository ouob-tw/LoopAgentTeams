// A test device's board in a real browser (headless Chrome over DevTools, the built board, fake
// data), wide and at a phone's width: its mark on every screen, the buttons of agents it did not
// start greyed out with why, its own agent's working, and a password device untouched.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEST_DEVICE_NOT_OWNED } from '../../src/lib/board/test-device.ts';
import { addOwned } from '../../src/lib/server/devices.ts';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser, type Tab } from '../browser.ts';

let fixture: Fixture;
let password: string;
let testCookie: string;
let browser: Browser | undefined;
let tab: Tab;

const herdrAgent = (session: string, workspace = 'wA') => ({
	agent: 'claude',
	agent_session: { kind: 'id', value: session },
	agent_status: 'working',
	cwd: `/home/someone/projects/${session}`,
	pane_id: `${workspace}:p-${session}`,
	tab_id: `${workspace}:t-${session}`,
	workspace_id: workspace
});

beforeAll(async () => {
	fixture = await startFixture({ env: { LAT_BOARD_PD_SECONDS: '1' } });
	password = await fixture.login();
	const agents = [herdrAgent('s-mine'), herdrAgent('s-theirs')];
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents,
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
			tabs: agents.map((agent) => ({ tab_id: agent.tab_id, workspace_id: 'wA', label: agent.agent_session.value }))
		})
	);
	writeFileSync(join(fixture.dir, 'pd.json'), JSON.stringify({ pending: [{ id: 3, waiting: 5, caller: 'codex', item: 'npm token', item_id: 'i-3', fields: ['password'], argv: ['npm', 'publish'], cwd: '/srv' }] }));
	const issued = fixture.cli('test-login', '--label', 'qa-page', '--url', fixture.url);
	const code = issued.stdout.match(/login\/test#(\S+)/)![1];
	const id = issued.stdout.match(/裝置 ([0-9a-f]{8})/)![1];
	const redeemed = await fixture.fetch('/api/login/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
	testCookie = redeemed.headers.getSetCookie()[0].split(';')[0];
	// As a launch of its own would, once the agent ran.
	addOwned(join(fixture.dir, 'board-state'), id, 's-mine');
	await fixture.refresh(password);
}, 30_000);
afterEach(async () => {
	await browser?.close();
	browser = undefined;
});
afterAll(async () => {
	await fixture?.cleanup();
});

/** Counts the page's reads of its own test login terms. */
const COUNT_DEVICE_READS = `(() => { const fetch = window.fetch; window.deviceReads = 0; window.fetch = (input, init) => { if (String(input) === '/api/device') window.deviceReads++; return fetch(input, init); }; })()`;

async function visit(cookie: string, width: number, search = '') {
	browser = await launchChrome({ scripts: [COUNT_DEVICE_READS] });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width < 761 });
	await tab.send('Page.navigate', { url: `${fixture.url}/${search}` });
	await tab.until(`JSON.stringify(history.state).includes('depth')`, 'the board to start');
}

/** The mark's box, whether it is in view, and the pd window's top. */
const MARK = `(() => { const band = document.querySelector('.test-band'); const r = band?.getBoundingClientRect(); const pd = document.querySelector('.inbox .pd')?.getBoundingClientRect(); return band ? { text: band.innerText, top: r.top, bottom: r.bottom, width: r.width, pdTop: pd && pd.height ? pd.top : null } : null; })()`;
/** What the open agent's page offers: its buttons' states and the notes it shows. */
const AGENT_PAGE = `(() => {
	const disabled = (selector) => document.querySelector(selector)?.disabled ?? null;
	const box = document.querySelector('.dock textarea');
	return {
		close: disabled('.detail [data-action="close"]'),
		box: box?.disabled ?? null,
		placeholder: box?.placeholder ?? '',
		note: [...document.querySelectorAll('.detail [data-note="test-device"]')].filter((note) => note.checkVisibility()).map((note) => note.innerText.trim())
	};
})()`;

for (const width of [1280, 390]) {
	test.skipIf(!CHROME)(`at ${width}px: the mark stays in view, another's agent is locked with why, its own works`, async () => {
		await visit(testCookie, width, '?agent=s-theirs');
		await tab.until(`!!document.querySelector('.detail [data-note="test-device"]')`, 'the locked agent page');
		if (width > 760) await tab.until(`!!document.querySelector('.inbox .pd')?.checkVisibility() && document.querySelector('.inbox .pd').getAnimations().length === 0`, 'the pd window');
		const mark = await tab.eval<{ text: string; top: number; bottom: number; width: number; pdTop: number | null }>(MARK);
		expect(mark.text).toContain('測試裝置');
		expect(mark.text).toContain('qa-page');
		expect(mark.top).toBe(0);
		expect(mark.width).toBe(width);
		// Defect seen by eye: the pd window sat under the band (its top at 8px, the band 30px tall).
		if (width > 760) {
			expect(mark.pdTop).not.toBeNull();
			expect(mark.pdTop!).toBeGreaterThanOrEqual(mark.bottom);
		}
		const theirs = await tab.eval<{ close: boolean; box: boolean; placeholder: string; note: string[] }>(AGENT_PAGE);
		expect(theirs).toMatchObject({ close: true, box: true, placeholder: TEST_DEVICE_NOT_OWNED, note: [TEST_DEVICE_NOT_OWNED] });
		// Scrolled down on a phone, the mark is still there.
		await tab.eval(`window.scrollTo(0, 2000)`);
		expect((await tab.eval<{ top: number }>(MARK)).top).toBe(0);

		await visit(testCookie, width, '?agent=s-mine');
		await tab.until(`!!document.querySelector('.detail [data-action="close"]')`, 'its own agent page');
		const mine = await tab.eval<{ close: boolean; box: boolean; placeholder: string; note: string[] }>(AGENT_PAGE);
		expect(mine).toMatchObject({ close: false, box: false, note: [] });
		expect(mine.placeholder).not.toBe(TEST_DEVICE_NOT_OWNED);
		expect(await tab.eval(`document.documentElement.scrollWidth <= window.innerWidth`)).toBe(true);
	}, 60_000);
}

test.skipIf(!CHROME)('a password device shows no mark and keeps every button', async () => {
	await visit(password, 1280, '?agent=s-theirs');
	await tab.until(`!!document.querySelector('.detail [data-action="close"]')`, 'the agent page');
	expect(await tab.eval(MARK)).toBeNull();
	expect(await tab.eval(AGENT_PAGE)).toMatchObject({ close: false, box: false, note: [] });
}, 60_000);

test.skipIf(!CHROME)('an idle test device reads its terms once per new snapshot, not in a loop', async () => {
	await visit(testCookie, 1280);
	await tab.until(`!!document.querySelector('.test-band')`, 'the test device mark');
	await new Promise((resolve) => setTimeout(resolve, 3_000));
	// Nothing changes on this board: the first snapshot's read and perhaps one more.
	const reads = await tab.eval<number>('window.deviceReads');
	// Read at least once: the page learns of agents its launches start from these reads.
	expect(reads).toBeGreaterThanOrEqual(1);
	expect(reads).toBeLessThanOrEqual(3);
}, 60_000);
