// Markdown tables in a report, in a real browser at a desktop and a phone width: no column under
// five characters, a long cell about three lines, a table wider than its box scrolls inside itself
// and the page does not. Skipped when the host has no Chrome. Set LAT_FRAMES to a folder to also
// save screenshots there.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser, type Tab } from '../browser.ts';

const long = (n: number) => '這是一段很長的說明文字，'.repeat(Math.ceil(n / 12)).slice(0, n);
const TABLE = [
	'| 名 | 說明 | 備註 |',
	'|---|---|---|',
	`| a | ${long(90)} | 短 |`,
	`| bb | ${long(40)} | 也很短 |`,
	'',
	`| ${Array.from({ length: 8 }, (_, i) => `欄${i + 1}`).join(' | ')} |`,
	`|${'---|'.repeat(8)}`,
	`| ${Array.from({ length: 8 }, () => long(36)).join(' | ')} |`
].join('\n');

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;
let luna: ReturnType<Fixture['bound']>;

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	cookie = await fixture.login('md-table');
	luna = fixture.bound('alpha', 'luna', {});
	fixture.report(luna.session_id, { tag: 'DONE', summary: '表格', message: TABLE, hcom_name: 'luna', workspace: luna.workspace });
	fixture.list([luna]);
	await fixture.refresh(cookie);
}, 30_000);
afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

/** Each table's cells and its box, as the page lays them out. */
const MEASURE = `[...document.querySelectorAll('.md table')].map((table) => {
	const em = parseFloat(getComputedStyle(table).fontSize);
	const cells = [...table.querySelectorAll('th, td')].map((cell) => ({ width: cell.getBoundingClientRect().width / em, lines: Math.round(cell.getBoundingClientRect().height / (parseFloat(getComputedStyle(cell).lineHeight) || em * 1.4)) }));
	return { cells, scrolls: table.scrollWidth > table.clientWidth + 1, boxWidth: table.clientWidth, pageFits: document.documentElement.scrollWidth <= window.innerWidth };
})`;

type Measured = { cells: { width: number; lines: number }[]; scrolls: boolean; boxWidth: number; pageFits: boolean }[];

for (const width of [1280, 390]) {
	test.skipIf(!CHROME)(`${width}px: columns are at least five characters, long cells about three lines, wide tables scroll inside`, async () => {
		await browser?.close();
		browser = await launchChrome({ screen: `document.querySelector('#panel-reports')?.innerHTML.slice(0, 1500)` });
		tab = browser.tab;
		const [name, value] = cookie.split('=');
		await tab.send('Network.setCookie', { name, value, url: fixture.url });
		await tab.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 761 });
		await tab.navigate(`${fixture.url}/?controller=${luna.session_id}`);
		await tab.until(`document.querySelector('.detail [role="tablist"]')`, 'the controller page');
		await tab.eval(`[...document.querySelectorAll('.detail [role="tab"]')].find((b) => b.innerText.includes('回報')).click()`);
		// Clicked again until the board, still starting, takes it.
		await tab.until(`(document.querySelector('.md table') || document.querySelector('#panel-reports .row .main')?.click(), document.querySelectorAll('.md table').length > 0)`, 'the report open');
		const [narrow, wide] = await tab.eval<Measured>(MEASURE);
		for (const table of [narrow, wide]) {
			expect(table.pageFits).toBe(true);
			for (const cell of table.cells) {
				expect(cell.width).toBeGreaterThanOrEqual(5);
				expect(cell.lines).toBeLessThanOrEqual(3);
			}
		}
		if (width === 390) expect(narrow.scrolls || wide.scrolls).toBe(true);
		expect(wide.scrolls).toBe(true);
		const frames = process.env.LAT_FRAMES;
		if (frames) {
			mkdirSync(frames, { recursive: true });
			const shot = async (file: string) => writeFileSync(join(frames, file), Buffer.from(((await tab.send('Page.captureScreenshot', { format: 'png' })) as { data: string }).data, 'base64'));
			await tab.eval(`document.querySelector('.md table').scrollIntoView({ block: 'start' })`);
			await shot(`table-${width}-start.png`);
			await tab.eval(`(() => { const t = document.querySelectorAll('.md table')[1]; t.scrollIntoView({ block: 'start' }); t.scrollLeft = 300; })()`);
			await shot(`table-${width}-scrolled.png`);
		}
	});
}
