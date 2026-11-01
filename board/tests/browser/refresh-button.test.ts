// The refresh button in a real browser, on a board the test stops and starts: while the link is
// down it is red on every layout and nothing else says so; a refresh that fails then, or for want
// of an answer, is quiet, and one the server fails is a notice; its icon makes a whole turn.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { question, startFixture, type Fixture } from '../harness.ts';
import { launchChrome, type Browser, type Tab } from '../browser.ts';

/** Lets the test make the next refreshes fail, as the server failing them or with no answer. */
const FAKE_REFRESH = `(() => { const fetch = window.fetch; window.fetch = async (input, init) => { if (String(input) === '/api/refresh' && window.slowRefresh) await new Promise((resolve) => setTimeout(resolve, window.slowRefresh)); if (String(input) === '/api/refresh' && window.failRefresh === 'http') return Promise.resolve(new Response('{}', { status: 500 })); if (String(input) === '/api/refresh' && window.failRefresh === 'network') return Promise.reject(new TypeError('Failed to fetch')); return fetch(input, init); }; })()`;
/** The refresh buttons a person can see now. */
const SHOWN = `[...document.querySelectorAll('button.tool.icon')].filter((button) => /重新整理|讀取中/.test(button.ariaLabel ?? '') && button.getClientRects().length && getComputedStyle(button).visibility === 'visible')`;
const NOTICES = `(document.querySelector('.dock .toasts')?.innerText ?? '').trim()`;
const FAILED = '重新整理失敗，請稍後再試。';

let fixture: Fixture, cookie: string, browser: Browser, tab: Tab, controller: ReturnType<Fixture['bound']>;

const size = (width: number, height: number) => tab.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 760 });
const button = async () => {
	await tab.until(`${SHOWN}.length === 1`, 'one refresh button in view');
	return tab.eval<{ offline: boolean; color: string; label: string; title: string }>(`(() => { const b = ${SHOWN}[0]; return { offline: b.classList.contains('offline'), color: getComputedStyle(b.querySelector('svg')).color, label: b.ariaLabel, title: b.title }; })()`);
};
const idle = () => tab.until(`!document.querySelector('button.tool.spinning')`, 'the refresh to end');
/** Click the refresh button; the most of a turn its icon got to, and how it ended. */
const spin = () =>
	tab.eval<Promise<{ turned: number; turning: number }>>(`new Promise((resolve) => {
		const b = ${SHOWN}[0];
		b.click();
		let turned = 0;
		const look = () => {
			const running = b.querySelector('svg').getAnimations()[0];
			if (running) turned = Math.max(turned, running.currentTime);
			if (b.classList.contains('spinning') || !turned) { if (performance.now() - started < 5000) return requestAnimationFrame(look); }
			resolve({ turned, turning: b.querySelector('svg').getAnimations().length });
		};
		const started = performance.now();
		requestAnimationFrame(look);
	})`);

beforeAll(async () => {
	fixture = await startFixture();
	cookie = await fixture.login();
	controller = fixture.bound('alpha', 'tavi', { questions: [question({ id: 'Q-1' })] });
	fixture.list([controller]);
	await fixture.refresh(cookie);
	browser = await launchChrome({ scripts: [FAKE_REFRESH] });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await size(1280, 800);
	await tab.navigate(`${fixture.url}/`);
	await tab.until(`JSON.stringify(history.state).includes('depth')`, 'the board to start');
}, 30_000);
afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

test('a reload of the page turns the icon too, and it stops', async () => {
	await tab.navigate(`${fixture.url}/`);
	await tab.until(`document.querySelector('button.tool.spinning')`, 'the icon turning after a load');
	await idle();
}, 30_000);

test('the icon makes at least a whole turn for a quick answer, and stops; with reduced motion it does not turn', async () => {
	await idle();
	const { turned, turning } = await spin();
	expect(turned).toBeGreaterThanOrEqual(1_000);
	expect(turning).toBe(0);

	await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
	await tab.eval(`${SHOWN}[0].click()`);
	await tab.until(`document.querySelector('button.tool.spinning')`, 'the refresh under reduced motion');
	expect(await tab.eval<number>(`${SHOWN}[0].querySelector('svg').getAnimations().length`)).toBe(0);
	await idle();
	await tab.send('Emulation.setEmulatedMedia', { features: [] });
}, 30_000);

test('a slow refresh stops the icon at the end of a turn', async () => {
	await idle();
	await tab.eval(`window.slowRefresh = 3_200`);
	const { turned } = await spin();
	await tab.eval(`window.slowRefresh = undefined`);
	expect(turned).toBeGreaterThanOrEqual(4_000);
	expect(turned).toBeLessThan(4_150);
}, 30_000);

test('with the link up a refresh the server failed is a notice; one that got no answer is not', async () => {
	await idle();
	await tab.eval(`window.failRefresh = 'network'`);
	await spin();
	expect(await tab.eval<string>(NOTICES)).toBe('');
	await tab.eval(`window.failRefresh = 'http'`);
	await spin();
	await tab.until(`${NOTICES}.includes(${JSON.stringify(FAILED)})`, 'the failure notice');
	await tab.eval(`document.querySelector('.dock .toasts button')?.click(); window.failRefresh = undefined`);
	await tab.until(`!${NOTICES}`, 'the notice closed');
}, 30_000);

test('while the link is down the button is red on every layout, nothing else says so, and refreshing is quiet; back up it is its own colour', async () => {
	await idle();
	const usual = await button();
	expect(usual).toMatchObject({ offline: false, label: '重新整理', title: '立即重新讀取所有資料' });

	await fixture.stop();
	await tab.until(`document.querySelector('button.tool.offline')`, 'the button to turn red', 15_000);
	const red = await button();
	expect(red).toMatchObject({ offline: true, label: '連線中斷，重新整理' });
	expect(red.title).toContain('連線中斷');
	expect(red.color).not.toBe(usual.color);
	expect(await tab.eval<string>(NOTICES)).toBe('');

	// Roster folded.
	await tab.eval(`document.querySelector('.tool.fold').click()`);
	expect((await button()).color).toBe(red.color);

	// A phone: the lists' screen and a content screen.
	await size(390, 800);
	expect((await button()).color).toBe(red.color);
	await tab.eval(`document.querySelector('nav.roster .unfolded [data-controller], nav.roster .unfolded li button').click()`);
	await tab.until(`document.querySelector('.topbar')?.getClientRects().length`, 'a content screen');
	expect((await button()).color).toBe(red.color);
	await size(1280, 800);
	// Opening that page could not read its records, which still says so as any other read does.
	await tab.eval(`document.querySelectorAll('.dock .toasts button').forEach((close) => close.click())`);

	// A refresh now, whether the request gets no answer or an answer of a broken proxy.
	const { turned } = await spin();
	expect(turned).toBeGreaterThanOrEqual(1_000);
	await tab.eval(`window.failRefresh = 'http'`);
	await spin();
	await tab.eval(`window.failRefresh = undefined`);
	expect(await tab.eval<string>(NOTICES)).toBe('');
	expect((await button()).offline).toBe(true);

	await fixture.start();
	await tab.until(`!document.querySelector('button.tool.offline')`, 'the button its own colour again', 15_000);
	expect((await button()).color).toBe(usual.color);
	expect(await tab.eval<string>(NOTICES)).toBe('');
}, 60_000);
