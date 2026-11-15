// Switching between conversations keeps the scrollbar's place (#644): the new conversation's first
// read is held with the DevTools Fetch domain, so the page shows only "讀取中…" for a while. The
// content must be as wide while it reads as after it has loaded, and the 我說過的話 bar must stay
// where it was. LAT_BOARD_SHOTS names a folder for frames.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { sleep, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, shot, type Browser, type Tab } from '../browser.ts';

const BAR = '[data-block="my-messages-bar"]';
const LINES = `[data-block="transcript"] li.said`;

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;
let luna: ReturnType<Fixture['bound']>;

const line = (kind: string, text: string) => JSON.stringify({ kind, time: '2026-11-13T09:00:00.000Z', text }) + '\n';
const conversation = (count: number) => Array.from({ length: count }, (_, index) => line('user', `提問 ${index}`) + line('assistant', `回覆 ${index}。`.repeat(8))).join('');
function recordOf(session: string, text: string) {
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', `${session}.jsonl`), text);
}

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	cookie = await fixture.login('scrollbar-gutter');
	luna = fixture.bound('alpha', 'luna', { client: 'codex' });
	const nova = fixture.bound('alpha', 'nova', { client: 'codex' });
	fixture.list([luna, nova]);
	recordOf(luna.session_id, conversation(130));
	recordOf(nova.session_id, conversation(130).replaceAll('回覆', '答覆'));
	recordOf('s-agent', conversation(130));
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents: [{ agent: 'codex', agent_session: { kind: 'id', value: 's-agent' }, agent_status: 'idle', cwd: '/home/someone/projects/s-agent', pane_id: 'wA:p-1', tab_id: 'wA:t-1', workspace_id: 'wA' }],
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
			tabs: [{ tab_id: 'wA:t-1', workspace_id: 'wA', label: '分頁' }]
		})
	);
	await fixture.refresh(cookie);
}, 30_000);
afterEach(async () => {
	await browser?.close();
	browser = undefined;
});
afterAll(async () => {
	await fixture?.cleanup();
});

/** The width the conversation has: its box, and the scrolling column's inside (what is left of the scrollbar). The bar's right edge too. */
const measure = () =>
	tab.eval<{ box: number; column: number; barRight: number; reading: boolean; other: boolean }>(`(() => {
		const box = document.querySelector('[data-block="transcript"]');
		const column = box.closest('.detail');
		const bar = document.querySelector('${BAR}')?.getBoundingClientRect();
		return { box: box.getBoundingClientRect().width, column: column.clientWidth, barRight: bar?.right ?? -1, reading: box.innerText.includes('讀取中'), other: box.innerText.includes('答覆') };
	})()`);

async function release() {
	for (const requestId of tab.paused.splice(0)) await tab.send('Fetch.continueRequest', { requestId }).catch(() => {});
}

for (const width of [1280, 390]) {
	test.skipIf(!CHROME)(`${width}px: switching conversation keeps the content and the bar where they were while the new one reads`, async () => {
		browser = await launchChrome({ screen: `location.search + ' ' + document.body.innerText.slice(0, 300)` });
		tab = browser.tab;
		const [name, value] = cookie.split('=');
		await tab.send('Network.setCookie', { name, value, url: fixture.url });
		await tab.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width < 761 });
		if (width < 761) await tab.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
		await tab.navigate(`${fixture.url}/?controller=${luna.session_id}`);
		await tab.until(`!!document.querySelector('${LINES}')`, 'the first conversation');
		await sleep(300);
		const first = await measure();
		await shot(tab, `scrollbar-gutter-${width}-1-first`);
		// The next conversation's read is held: the page shows "讀取中…" only, shorter than the window.
		await tab.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/transcript?*' }] });
		if (width < 761) await tab.eval(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '←')?.click()`);
		const nova = `[...document.querySelectorAll('button.person')].find((b) => b.innerText.includes('@nova'))`;
		await tab.until(`!!${nova}`, 'the other controller');
		await tab.eval(`${nova}.click()`);
		await tab.until(`document.querySelector('[data-block="transcript"]')?.innerText.includes('讀取中')`, 'the reading line');
		for (const start = Date.now(); tab.paused.length === 0; await sleep(20)) if (Date.now() - start > 10_000) throw new Error('the read was not held');
		await sleep(300);
		const reading = await measure();
		await shot(tab, `scrollbar-gutter-${width}-2-reading`);
		await release();
		await tab.until(`!!document.querySelector('${LINES}') && !document.querySelector('[data-block="transcript"]').innerText.includes('讀取中')`, 'the second conversation');
		await sleep(300);
		const loaded = await measure();
		await shot(tab, `scrollbar-gutter-${width}-3-loaded`);
		expect(reading.reading).toBe(true);
		expect(first.other).toBe(false);
		expect(loaded.other).toBe(true);
		expect(reading.column).toBe(loaded.column);
		expect(reading.box).toBe(loaded.box);
		expect(reading.barRight).toBe(loaded.barRight);
		expect(reading.column).toBe(first.column);
		expect(tab.errors).toEqual([]);
	}, 60_000);
}
