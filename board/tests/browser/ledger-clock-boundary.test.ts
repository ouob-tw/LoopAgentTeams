// The ledger page's displays that read "today" (a closed time as 17:51:00, a problem's time as 17:40:00,
// with no date in front) at a day boundary: the page's clock is set to ten seconds before Asia/Taipei
// midnight (so the day ends while the page is open), and to a month's last evening (so the day after is
// in the next month), with the ledger's data on that same day. The server's zone is set here, not taken
// from the host. The assertions are those of ledger-page.test.ts's first two tests for these times.
// Skipped when the host has no Chrome.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser } from '../browser.ts';
import { onDay, pinnedClock, ticketLedger } from '../fixtures/ledger-tickets.ts';

let fixture: Fixture;
let cookie: string;

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture({ env: { TZ: 'Asia/Taipei' } });
	cookie = await fixture.login('ledger-clock-boundary');
}, 30_000);

afterAll(async () => {
	await fixture?.cleanup();
});

const BOUNDARIES = [
	// 23:59:50 on 2026-11-12 in Asia/Taipei.
	{ name: 'just before midnight', day: '2026-11-12', clock: '2026-11-12T15:59:50Z' },
	// 23:59:50 on 2026-11-30 in Asia/Taipei: the next day is December 1.
	{ name: 'on the last evening of a month', day: '2026-11-30', clock: '2026-11-30T15:59:50Z' }
];

for (const { name, day, clock } of BOUNDARIES) {
	test.skipIf(!CHROME)(`closed time and problem times show without a date ${name}`, async () => {
		const luna = fixture.bound('alpha', `luna-${day}`);
		spawnSync('git', ['init', '-q', luna.workspace]);
		spawnSync('git', ['-C', luna.workspace, 'remote', 'add', 'origin', 'git@github.com:ouob-tw/LoopAgentTeams.git']);
		const report = join(luna.workspace, '.lat/runs/issue-534/report.md');
		mkdirSync(join(luna.workspace, '.lat/runs/issue-534'), { recursive: true });
		writeFileSync(report, '# #534 report\n');
		fixture.setHelper({ output: { controllers: [luna] }, ledgers: { [luna.session_id]: { status: 'ok', ledger: onDay(ticketLedger(luna.workspace, report), day) } } });
		await fixture.refresh(cookie);

		let browser: Browser | undefined;
		try {
			browser = await launchChrome({ scripts: [pinnedClock(clock)] });
			const tab = browser.tab;
			const [cookieName, cookieValue] = cookie.split('=');
			await tab.send('Network.setCookie', { name: cookieName, value: cookieValue, url: fixture.url });
			await tab.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
			await tab.navigate(`${fixture.url}/?controller=${luna.session_id}`);
			await tab.until(
				`(() => { const button = document.querySelector('.detail [data-tab="ledger"]'); if (button.getAttribute('aria-selected') !== 'true') button.click(); return document.querySelectorAll('.detail .ledger .ticket').length > 0; })()`,
				'the ticket lines'
			);
			const line = (ref: string) => `[...document.querySelectorAll('.detail .ledger .ticket')].find((li) => li.querySelector('.ref').innerText.startsWith(${JSON.stringify(ref)}))`;
			const toggle = (ref: string) => tab.eval(`${line(ref)}.querySelector('summary').click()`);

			// The closed time (ledger-page.test.ts, first test).
			// As ledger-page.test.ts does: let the page settle on the board's zone before reading times.
			await tab.eval(`new Promise((done) => setTimeout(done, 400))`);
			await toggle('#534');
			const figures = await tab.eval<[string, string][]>(`[...${line('#534')}.querySelector('.row').querySelectorAll('dt')].filter((dt) => dt.innerText === '結案時間').map((dt) => [dt.innerText, dt.nextElementSibling.innerText.replace(/\\s+/g, ' ').trim()])`);
			expect(figures).toEqual([['結案時間', '17:51:00']]);

			// The problems' lines (second test).
			await toggle('#533');
			const problems = (ref: string) => tab.eval<string[]>(`[...${line(ref)}.querySelectorAll('.problem')].map((li) => li.innerText.replace(/\\s+/g, ' ').trim())`);
			expect(await problems('#533')).toEqual([
				'丙 長標題換行的測試失敗 自動測試・suite-gate・第 1 版・17:40:00・測試抓到',
				'丙 函式命名與既有的不一致 審查・zapi-t533-rev・第 1 版・17:40:00・列為已知限制',
				'甲 手機上職責連結被截斷，點不到 驗收・zapi-t533-qa・第 2 版・17:55:00'
			]);
			expect(await problems('#534')).toEqual(['乙 每次推送都重畫所有已送出的標題 審查・zapi-t534-rev・第 1 版・17:40:00・已修 42f5bed0c0ff']);
		} finally {
			await browser?.close();
		}
	}, 60_000);
}
