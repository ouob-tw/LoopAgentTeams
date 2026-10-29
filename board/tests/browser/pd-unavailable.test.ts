// Real rendered board with fake pd only; no production socket, account or browser profile.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { startFixture } from '../harness.ts';
import { launchChrome } from '../browser.ts';

test('pd outage is visible with zero pending requests, survives pending requests, and clears on recovery', async () => {
	const fixture = await startFixture({ env: { LAT_BOARD_PD_SECONDS: '0.2' } });
	const browser = await launchChrome();
	try {
		const cookie = await fixture.login();
		const [name, value] = cookie.split('=');
		const tab = browser.tab;
		await tab.send('Network.setCookie', { name, value, url: fixture.url });
		const set = (state: unknown) => writeFileSync(join(fixture.dir, 'pd.json'), JSON.stringify(state));
		set({ pending: [], vault: 'unavailable' });
		await tab.send('Page.navigate', { url: fixture.url });
		const visible = `document.querySelector('.pd-unavailable')?.checkVisibility() && document.querySelector('.pd-unavailable').textContent === 'pd 服務不可用'`;
		await tab.until(visible, 'vault unavailable notice without requests');
		for (const width of [360, 1280]) {
			await tab.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 360 });
			await tab.until(visible, `notice visible at ${width}px`);
			expect(await tab.eval(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
		}
		set({ pending: [], vault: 'ok' });
		await tab.until(`!document.querySelector('.pd-unavailable')`, 'first recovery');
		set({ pending: [], unavailable: true });
		await tab.until(visible, 'unreachable notice');
		set({ pending: [], vault: 'ok' });
		await tab.until(`!document.querySelector('.pd-unavailable')`, 'healthy hides notice');
		set({ pending: [{ id: 1, caller: 'test', item: 'test item', fields: [], argv: [], cwd: '/' }], vault: 'unavailable' });
		await tab.until(`${visible} && !!document.querySelector('[data-pd-request="1"]')`, 'outage preserves pending controls');
		expect(await tab.eval(`document.querySelector('[data-pd-request="1"]').textContent.includes('拒絕')`)).toBe(true);
		set({ pending: [], vault: 'ok' });
		await tab.until(`!document.querySelector('.pd-unavailable')`, 'final recovery');
	} finally {
		await browser.close();
		await fixture.cleanup();
	}
}, 30_000);
