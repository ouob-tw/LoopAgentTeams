// A controller's work ledger on its page in a real browser, at a phone's width: a late item marked
// and saying how late, the table inside the page's width, and a controller without a ledger saying
// so. Skipped when the host has no Chrome.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser } from '../browser.ts';

let fixture: Fixture;
let browser: Browser | undefined;

const row = (id: number, ticket: string, late: Record<string, number>) => ({
	id, ticket, stage_label: '實作', status_label: '進行中', agent: 'tevu-impl302-zaga',
	estimate: '2026-10-24T09:00:00Z', deadline: '2026-10-24T10:00:00Z', late_minutes: late, history: [{ at: '2026-10-24T08:00:00Z' }]
});

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	const luna = fixture.bound('alpha', 'luna');
	const nova = fixture.bound('beta', 'nova');
	fixture.setHelper({
		output: { controllers: [luna, nova] },
		ledgers: { [luna.session_id]: { status: 'ok', ledger: { updated_at: '2026-10-24T08:00:00Z', items: [row(1, '#301', {}), row(2, '#302', { deadline: 65, estimate: 125 })] } } }
	});
	const cookie = await fixture.login('ledger-page');
	await fixture.refresh(cookie);
	browser = await launchChrome();
	const [name, value] = cookie.split('=');
	await browser.tab.send('Network.setCookie', { name, value, url: fixture.url });
	await browser.tab.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 1, mobile: true });
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

const ROWS = `[...document.querySelectorAll('.detail .ledger tbody tr')].map((tr) => ({ text: tr.innerText.replace(/\\s+/g, ' '), late: tr.classList.contains('late'), background: getComputedStyle(tr.cells[0]).backgroundColor }))`;

test.skipIf(!CHROME)('a late item is marked with how late it is, inside the page at a phone width; no ledger says so', async () => {
	const tab = browser!.tab;
	const [luna, nova] = fixture.listed();
	await tab.navigate(`${fixture.url}/?controller=${luna.session_id}`);
	await tab.until(`document.querySelectorAll('.detail .ledger tbody tr').length === 2`, 'the ledger rows');

	const [onTime, late] = await tab.eval<{ text: string; late: boolean; background: string }[]>(ROWS);
	expect(onTime.late).toBe(false);
	expect(late.late).toBe(true);
	expect(late.text).toContain('遲到 超過期限 1h05m；超過預計 2h05m');
	expect(late.background).not.toBe(onTime.background);
	expect(await tab.eval(`document.documentElement.scrollWidth <= window.innerWidth`)).toBe(true);

	await tab.navigate(`${fixture.url}/?controller=${nova.session_id}`);
	await tab.until(`document.querySelector('.detail .ledger')?.innerText.includes('尚無總表')`, 'no ledger');
}, 60_000);
