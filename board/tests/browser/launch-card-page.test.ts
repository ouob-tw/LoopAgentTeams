// The roster's card for a controller launched from the board (#689), in a real browser: sending
// the new-controller form puts a 啟動中 card on the roster within 2 seconds of the launch answering,
// framed and sized like a controller's card on a wide screen and like its tag on a phone, a long
// project name cut short; once the controller binds its own card takes the place, never both; a
// failed launch's card says so and can be removed. hcom and Herdr are the fixture's fakes, so
// nothing is started. Frames go to LAT_BOARD_SHOTS when it is set. Skipped when the host has no Chrome.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';
import { BOARD_STARTED, CHROME, launchChrome, shot, type Browser } from '../browser.ts';

let fixture: Fixture;
let browser: Browser | undefined;
let cookie: string;
let luna: ReturnType<Fixture['bound']>;
let folder: string;

const send = (method: string, params: object = {}) => browser!.tab.send(method, params);
const evaluate = <T>(expression: string) => browser!.tab.eval<T>(expression);
const until = (expression: string, timeoutMs?: number) => browser!.tab.until(expression, expression, timeoutMs);

const LONG = 'a-project-with-a-name-far-too-long-for-any-roster-card';
const CARD = `document.querySelector('.unfolded .people [data-launch]')`;
const LUNA = `document.querySelector('.unfolded .people [data-controller="luna"]')`;
const box = (element: string) => `(() => { const r = ${element}.getBoundingClientRect(); return { x: r.x, width: r.width, height: r.height }; })()`;

const resize = (width: number) => send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 700 });
const herdr = (paths: string[]) =>
	writeFileSync(join(fixture.dir, 'herdr.json'), JSON.stringify({ panes: paths.map((cwd) => ({ workspace_id: 'wA', cwd })), workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }] }));
const hcom = (plan: object) => fixture.setHcom({ agents: [{ name: 'luna', session_id: luna.session_id, status: 'listening' }], ...plan });

/** Run `look` with the page reloaded in the dark theme, then put the theme back. */
async function dark(look: () => Promise<void>) {
	await evaluate(`localStorage.setItem('lat-board-theme', 'dark')`);
	await send('Page.reload');
	await until(`${BOARD_STARTED} && document.documentElement.dataset.theme === 'dark' && !!document.querySelector('.people [data-launch]')`);
	await look();
	await evaluate(`localStorage.removeItem('lat-board-theme')`);
	await send('Page.reload');
	await until(`${BOARD_STARTED} && !!document.querySelector('.people [data-launch]')`);
}

/** Send the new-controller form for `folder` in `mode`, timing from the click on 新建主控 to the
 *  card's arrival in the page, and to the launch's answer. */
async function sendForm(mode: 'manual' | 'unattended' = 'manual') {
	await resize(1400);
	await send('Page.navigate', { url: `${fixture.url}/?launch` });
	await until(`!!document.querySelector('#folder-box') && !!document.querySelector('.new textarea')`);
	await evaluate(`(() => {
		window.answeredAt = null;
		window.cardAt = null;
		window.sentAt = null;
		const fetch = window.fetch;
		window.fetch = async (input, init) => {
			const response = await fetch(input, init);
			if (String(input).endsWith('/api/launches') && init?.method === 'POST') window.answeredAt = performance.now();
			return response;
		};
		new MutationObserver(() => { if (window.cardAt === null && ${CARD}) window.cardAt = performance.now(); }).observe(document.body, { childList: true, subtree: true });
		const type = (element, value) => {
			element.value = value;
			element.dispatchEvent(new Event('input', { bubbles: true }));
		};
		type(document.querySelector('#folder-box'), ${JSON.stringify(folder)});
		type(document.querySelector('.new textarea'), '把測試修好');
	})()`);
	if (mode === 'unattended') await evaluate(`[...document.querySelectorAll('.new .mode button')][1].click()`);
	await until(`!document.querySelector('form > .primary').disabled`);
	await evaluate(`(() => { window.sentAt = performance.now(); document.querySelector('form > .primary').click(); })()`);
	await until('window.answeredAt !== null && window.cardAt !== null', 15_000);
	return evaluate<{ card: number; answer: number }>('({ card: window.cardAt - window.sentAt, answer: window.answeredAt - window.sentAt })');
}

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture({ env: { LAT_BOARD_STATUS_POLL_SECONDS: '60', LAT_BOARD_STATUS_WORKING_POLL_SECONDS: '60' } });
	cookie = await fixture.login('launch-card');
	luna = fixture.bound('alpha', 'luna');
	mkdirSync(join(luna.workspace, '.git'), { recursive: true });
	fixture.report(luna.session_id, { tag: 'DONE', summary: '好了', hcom_name: 'luna', workspace: luna.workspace });
	fixture.list([luna]);
	folder = join(fixture.dir, 'projects', LONG);
	mkdirSync(join(folder, '.git'), { recursive: true });
	herdr([luna.workspace, folder]);
	hcom({ names: ['pavo'] });
	await fixture.refresh(cookie);
	browser = await launchChrome();
	const [name, value] = cookie.split('=');
	await send('Network.setCookie', { name, value, url: fixture.url });
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

test.skipIf(!CHROME)('the card is on the roster within 2 seconds of sending, before hcom is done, like a controller card, its long name cut short', async () => {
	// hcom takes 4 seconds to answer, as it waits for the client: the card does not wait for it.
	hcom({ names: ['pavo'], sleepMs: 4_000 });
	// Reading the bindings before the launch is slow too, as on a busy host.
	fixture.setHelper({ output: { controllers: [luna] }, sleepMs: 2_500 });
	const timing = await sendForm();
	fixture.list([luna]);
	expect(timing.card).toBeLessThan(2_000);
	expect(timing.answer).toBeGreaterThan(timing.card + 1_000);
	expect(await evaluate(`${CARD}.dataset.state`)).toBe('starting');
	expect(await evaluate(`${CARD}.querySelector('.phase').textContent`)).toBe('啟動中，等主控啟用');
	await shot(browser!.tab, '1400-starting');

	const card = await evaluate<{ x: number; width: number; height: number }>(box(CARD));
	const controller = await evaluate<{ x: number; width: number; height: number }>(box(LUNA));
	expect(card).toEqual(controller);
	// Cut with an ellipsis inside the card, not wrapped or spilling out.
	expect(await evaluate(`(() => { const p = ${CARD}.querySelector('.project'); return p.scrollWidth > p.clientWidth && p.getBoundingClientRect().right <= ${CARD}.getBoundingClientRect().right; })()`)).toBe(true);
	expect(await evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);

	// Folded, the rail has a mark for it above the controllers', opening the new-controller page.
	await evaluate(`document.querySelector('.summary .fold').click()`);
	await until(`!!document.querySelector('.rail [data-launch]')`);
	expect(await evaluate(`document.querySelector('.rail [data-launch]').getAttribute('aria-label')`)).toBe(`${LONG} @pavo：啟動中，等主控啟用`);
	await shot(browser!.tab, '1400-rail-starting');
	await evaluate(`document.querySelector('.rail .grip').click()`);
	await until(`!!${CARD}`);
	await dark(async () => shot(browser!.tab, '1400-dark-starting'));

	// A real click on the middle of the card, away from the new-controller page, opens it.
	await send('Page.navigate', { url: fixture.url });
	await until(`${BOARD_STARTED} && !!${CARD}`);
	const middle = await evaluate<{ x: number; y: number }>(`(() => { const r = ${CARD}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
	for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...middle, button: 'left', clickCount: 1 });
	await until(`location.search.includes('launch')`, 2_000);
}, 40_000);

test.skipIf(!CHROME)('on a phone the card is a tag like the others, with its state word', async () => {
	await resize(390);
	await send('Page.navigate', { url: fixture.url });
	await until(`${BOARD_STARTED} && !!document.querySelector('.people [data-launch]') && !!document.querySelector('.people [data-controller="luna"]')`);
	await evaluate('document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(resolve)))');
	const [card, controller] = await evaluate<{ height: number; top: number; width: number }[]>(`['[data-launch]', '[data-controller="luna"]'].map((selector) => {
		const r = document.querySelector('.people ' + selector).getBoundingClientRect();
		return { height: r.height, top: r.top, width: r.width };
	})`);
	expect(card.height).toBe(controller.height);
	expect(card.top).toBe(controller.top);
	// No wider than a tag may be (11rem).
	expect(card.width).toBeLessThanOrEqual(176);
	expect(await evaluate(`getComputedStyle(document.querySelector('.people [data-launch] .tag')).display`)).not.toBe('none');
	expect(await evaluate(`document.querySelector('.people [data-launch] .tag').textContent`)).toBe('啟動中');
	expect(await evaluate(`(() => { const p = document.querySelector('.people [data-launch] .project'); return p.scrollWidth > p.clientWidth; })()`)).toBe(true);
	await shot(browser!.tab, '390-starting');
	await dark(async () => shot(browser!.tab, '390-dark-starting'));
}, 30_000);

test.skipIf(!CHROME)('once the controller binds its own card takes the place: never both on the roster', async () => {
	await resize(1400);
	await send('Page.navigate', { url: fixture.url });
	await until(`!!${CARD}`);
	await evaluate(`(() => {
		window.both = false;
		new MutationObserver(() => {
			if (document.querySelector('.unfolded .people [data-launch]') && document.querySelector('.unfolded .people [data-controller="pavo"]')) window.both = true;
		}).observe(document.body, { childList: true, subtree: true, attributes: true });
	})()`);
	const pavo = fixture.bound(LONG, 'pavo', { workspace: folder });
	hcom({ names: ['pavo'], agents: [{ name: 'luna', session_id: luna.session_id, status: 'listening' }, { name: 'pavo', session_id: pavo.session_id, status: 'listening' }] });
	fixture.list([luna, pavo]);
	await fixture.refresh(cookie);
	await until(`!!document.querySelector('.unfolded .people [data-controller="pavo"]') && !${CARD}`);
	expect(await evaluate('window.both')).toBe(false);
	expect(await evaluate(`document.querySelectorAll('.unfolded .people [data-controller="pavo"]').length`)).toBe(1);
	await shot(browser!.tab, '1400-bound');
}, 30_000);

test.skipIf(!CHROME)('an unattended launch sent from the form gets its card within 2 seconds too, replaced once bound', async () => {
	// hcom's calls are counted across the file: every one names rinu.
	hcom({ names: ['rinu', 'rinu', 'rinu'], sleepMs: 4_000 });
	const timing = await sendForm('unattended');
	expect(timing.card).toBeLessThan(2_000);
	expect(await evaluate(`${CARD}.querySelector('.handle').textContent`)).toBe('@rinu');
	const pavo = fixture.listed().find((binding: { hcom_name: string }) => binding.hcom_name === 'pavo')!;
	const rinu = fixture.bound(LONG, 'rinu', { workspace: folder });
	hcom({ agents: [{ name: 'luna', session_id: luna.session_id, status: 'listening' }, { name: 'pavo', session_id: pavo.session_id, status: 'listening' }, { name: 'rinu', session_id: rinu.session_id, status: 'listening' }] });
	fixture.list([luna, pavo, rinu]);
	await fixture.refresh(cookie);
	await until(`!!document.querySelector('.unfolded .people [data-controller="rinu"]') && !${CARD}`);
}, 40_000);

test.skipIf(!CHROME)('a failed launch\'s card says it failed and can be removed', async () => {
	hcom({ exit: 1, stdout: '', stderr: 'Error: claude not found on PATH\n' });
	await sendForm();
	expect(await evaluate(`${CARD}.dataset.state`)).toBe('failed');
	expect(await evaluate(`${CARD}.querySelector('.phase').textContent`)).toBe('失敗');
	await send('Page.navigate', { url: fixture.url });
	// Running, not only the server's first render: a click before that does nothing.
	await until(`${BOARD_STARTED} && !!${CARD}`);
	await shot(browser!.tab, '1400-failed');
	await resize(390);
	await until(`!!document.querySelector('.people [data-launch]')`);
	await shot(browser!.tab, '390-failed');
	expect(await evaluate(`document.querySelector('.people [data-launch] .handle').textContent`)).toBe('Claude');
	await resize(1400);
	await evaluate(`${CARD}.querySelector('.dismiss').click()`);
	await until(`!${CARD}`);
	// Removed on this device, also after a reload.
	await send('Page.navigate', { url: fixture.url });
	// The server's first render does not know this device removed it: gone once the page runs.
	await until(`${BOARD_STARTED} && !!${LUNA} && !${CARD}`, 3_000);
}, 30_000);
