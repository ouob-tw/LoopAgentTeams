// The 待辦 tab's top row in a real browser: headless Chrome driven over its DevTools protocol, on
// the built board, at a desktop and a phone width. Skipped when the host has no Chrome.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { sleep, startFixture, type Fixture } from './harness.ts';
import { CHROME, launchChrome, type Browser, type Tab } from './browser.ts';



let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;

beforeAll(async () => {
	fixture = await startFixture();
	cookie = await fixture.login();
}, 30_000);
afterEach(async () => {
	await browser?.close();
});
afterAll(async () => {
	await fixture?.cleanup();
});

async function visit(width: number) {
	browser = await launchChrome({ screen: `document.querySelector('.inbox')?.innerText ?? ''` });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 761 });
	await tab.send('Page.navigate', { url: `${fixture.url}/?tab=inbox` });
	await tab.until(`JSON.stringify(history.state).includes('depth')`, 'the board to start');
	await tab.until(`!!document.querySelector('.inbox .toggle')`, 'the 待辦 tab');
}

for (const width of [1280, 360]) {
	test.skipIf(!CHROME)(`${width}px: no visible 待辦 title in the tab, the view switch sits at the left, the area keeps its name`, async () => {
		await visit(width);
		const row = await tab.eval<{ visibleTitles: string[]; toggleLeft: number; inboxLeft: number; toggleTop: number; headerTop: number; named: string[]; fits: boolean }>(`(() => {
			const inbox = document.querySelector('.inbox');
			const header = inbox.querySelector('header');
			const toggle = header.querySelector('.toggle');
			// Titles a reader of the screen sees: headings with a box of more than a pixel.
			const visibleTitles = [...inbox.querySelectorAll('h1, h2, h3')].filter((node) => node.getBoundingClientRect().width > 1).map((node) => node.innerText);
			return {
				visibleTitles,
				toggleLeft: toggle.getBoundingClientRect().left,
				inboxLeft: inbox.getBoundingClientRect().left,
				toggleTop: toggle.getBoundingClientRect().top,
				headerTop: header.getBoundingClientRect().top,
				named: [header.querySelector('h2')?.textContent, toggle.getAttribute('aria-label')],
				fits: document.documentElement.scrollWidth <= window.innerWidth
			};
		})()`);
		expect(row.visibleTitles).toEqual([]);
		// Left-aligned: the first button starts where the column's content starts, on the header's row.
		expect(row.toggleLeft - row.inboxLeft).toBeLessThan(30);
		expect(Math.abs(row.toggleTop - row.headerTop)).toBeLessThan(2);
		// Still named for assistive technology: a heading that is hidden from the eye only.
		expect(row.named).toEqual(['待辦', '待辦檢視']);
		expect(row.fits).toBe(true);
	}, 30_000);
}
