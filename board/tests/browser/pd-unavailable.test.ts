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
		const visible = `document.querySelector('.pd-unavailable')?.checkVisibility() && document.querySelector('.pd-unavailable').textContent === 'pd 服務不可用'`;
		const wide = { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false };
		const phone = { width: 360, height: 900, deviceScaleFactor: 1, mobile: true };
		const BADGE = (text: string) => `document.querySelector('.pd-badge')?.checkVisibility() && document.querySelector('.pd-badge').innerText === '${text}' && !document.querySelector('.inbox .pd')`;
		// A phone starts folded to the badge too, which opens the notice.
		await tab.send('Emulation.setDeviceMetricsOverride', phone);
		set({ pending: [], vault: 'unavailable' });
		await tab.navigate(fixture.url);
		await tab.boardStarted();
		await tab.until(BADGE('pd 服務不可用'), 'phone: outage on load is a folded badge');
		expect(await tab.eval(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
		await tab.pointerClick('.pd-badge');
		await tab.until(visible, 'phone: the badge opens the notice');
		// A wide screen loads with the outage already there: folded to a badge that says it, not a window over the column.
		await tab.send('Emulation.setDeviceMetricsOverride', wide);
		set({ pending: [], vault: 'unavailable' });
		await tab.navigate(fixture.url);
		await tab.boardStarted();
		await tab.until(BADGE('pd 服務不可用'), 'wide: outage on load is a folded badge');
		expect(await tab.eval(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
		// The badge opens the whole notice; 稍後 folds it again.
		await tab.pointerClick('.pd-badge');
		await tab.until(`document.querySelector('.inbox .pd .pd-unavailable')?.textContent === 'pd 服務不可用' && !document.querySelector('.pd-badge')`, 'wide: badge opens the notice');
		await tab.pointerClick('.pd button.later');
		await tab.until(BADGE('pd 服務不可用'), 'wide: later folds it back');
		// A new request opens it, outage or not.
		set({ pending: [{ id: 1, caller: 'test', item: 'test item', fields: [], argv: [], cwd: '/' }], vault: 'unavailable' });
		await tab.until(`document.querySelector('.pd-unavailable')?.checkVisibility() && !!document.querySelector('[data-pd-request="1"]') && !document.querySelector('.pd-badge')`, 'wide: a request opens the folded window');
		expect(await tab.eval(`document.querySelector('[data-pd-request="1"]').textContent.includes('拒絕')`)).toBe(true);
		// pd turning unavailable while the board is open does not open it by itself.
		set({ pending: [], vault: 'ok' });
		await tab.until(`!document.querySelector('.inbox .pd, .pd-badge')`, 'wide: healthy and empty shows nothing');
		set({ pending: [], vault: 'unavailable' });
		await tab.until(BADGE('pd 服務不可用'), 'wide: outage while open stays a badge');
		await new Promise((resolve) => setTimeout(resolve, 800));
		expect(await tab.eval(`!document.querySelector('.inbox .pd')`)).toBe(true);
		// An unreachable daemon is the same.
		set({ pending: [], vault: 'ok' });
		await tab.until(`!document.querySelector('.pd-badge')`, 'wide: recovery');
		set({ pending: [], unavailable: true });
		await tab.until(BADGE('pd 服務不可用'), 'wide: unreachable daemon is a badge');
		set({ pending: [], vault: 'ok' });
		await tab.until(`!document.querySelector('.inbox .pd, .pd-badge')`, 'recovery clears the badge');
		// A locked vault is the same: a badge that says so, which opens to the notice.
		set({ pending: [], vault: 'locked' });
		await tab.until(BADGE('pd 已鎖定'), 'locked notice folded');
		await tab.pointerClick('.pd-badge');
		await tab.until(`document.querySelector('.pd-unavailable')?.textContent === 'pd 已鎖定' && !document.querySelector('.pd-badge')`, 'locked notice open');
		await tab.pointerClick('.pd button.later');
		await tab.until(BADGE('pd 已鎖定'), 'folded again');
		set({ pending: [], vault: 'ok' });
		await tab.until(`!document.querySelector('.pd-badge')`, 'recovery clears the folded notice');
	} finally {
		await browser.close();
		await fixture.cleanup();
	}
}, 30_000);
