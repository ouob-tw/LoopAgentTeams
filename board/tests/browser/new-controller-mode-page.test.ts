// The new-controller form's 手動／無人 switch (#656) in a real browser: manual each time the form
// is opened, the choice goes with the launch, a finger high on a phone, and the Herdr new-agent form
// has none. Launching is answered in the page, so nothing is started. Skipped when the host has no Chrome.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser } from '../browser.ts';

let fixture: Fixture;
let browser: Browser | undefined;

const send = (method: string, params: object = {}) => browser!.tab.send(method, params);
const evaluate = <T>(expression: string) => browser!.tab.eval<T>(expression);
const until = (expression: string, timeoutMs?: number) => browser!.tab.until(expression, expression, timeoutMs);

const BOX = `document.querySelector('.new textarea')`;
const SUBMIT = `document.querySelector('form > .primary')`;
const MODES = `[...document.querySelectorAll('.new .mode button')]`;
const pressed = () => evaluate<string[]>(`${MODES}.filter((button) => button.getAttribute('aria-pressed') === 'true').map((button) => button.textContent.trim())`);

/** Answer the next launch in the page, keeping what the form sent. */
const catchLaunch = () =>
	evaluate(`(() => {
		window.sentLaunch = null;
		const fetch = window.realFetch ?? window.fetch;
		window.realFetch = fetch;
		window.fetch = (input, init) => {
			if (String(input).endsWith('/api/launches') && init?.method === 'POST') {
				window.sentLaunch = JSON.parse(init.body);
				return Promise.resolve(new Response(JSON.stringify({ ok: true, reason: null, entry: null, logError: null }), { status: 200, headers: { 'content-type': 'application/json' } }));
			}
			return fetch(input, init);
		};
	})()`);
const open = async (search: string, width = 1400) => {
	await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 700 });
	await send('Page.navigate', { url: `${fixture.url}/${search}` });
	await until(`!!document.querySelector('#folder-box')?.value && !!${BOX}`);
};
const sendForm = async (text: string) => {
	await evaluate(`(() => {
		const box = ${BOX};
		box.value = ${JSON.stringify(text)};
		box.dispatchEvent(new Event('input', { bubbles: true }));
	})()`);
	await catchLaunch();
	await until(`!${SUBMIT}.disabled`);
	await evaluate(`${SUBMIT}.click()`);
	await until('window.sentLaunch !== null');
	return evaluate<{ mode?: string }>('window.sentLaunch');
};

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	const cookie = await fixture.login('new-controller-mode');
	const luna = fixture.bound('alpha', 'luna');
	mkdirSync(join(luna.workspace, '.git'), { recursive: true });
	fixture.report(luna.session_id, { tag: 'DONE', summary: '好了', hcom_name: 'luna', workspace: luna.workspace });
	fixture.list([luna]);
	writeFileSync(join(fixture.dir, 'herdr.json'), JSON.stringify({ workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }] }));
	await fixture.refresh(cookie);
	browser = await launchChrome();
	const [name, value] = cookie.split('=');
	await send('Network.setCookie', { name, value, url: fixture.url });
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

test.skipIf(!CHROME)('the form opens on 手動, sends the mode chosen, and opens on 手動 again', async () => {
	await open('?launch');
	expect(await evaluate<string[]>(`${MODES}.map((button) => button.textContent.trim())`)).toEqual(['手動', '無人']);
	expect(await pressed()).toEqual(['手動']);
	expect((await sendForm('手動開')).mode).toBe('manual');

	await evaluate(`${MODES}[1].click()`);
	expect(await pressed()).toEqual(['無人']);
	expect((await sendForm('無人開')).mode).toBe('unattended');

	// Leaving the form and coming back does not keep the last choice.
	await open('?new-agent=wA');
	await open('?launch');
	expect(await pressed()).toEqual(['手動']);
}, 30_000);

test.skipIf(!CHROME)('on a phone the switch is a finger high, fits the width and lines up with the other settings', async () => {
	await open('?launch', 390);
	const boxes = await evaluate<{ height: number; right: number; bottom: number }[]>(
		`${MODES}.map((button) => { const box = button.getBoundingClientRect(); return { height: box.height, right: box.right, bottom: box.bottom }; })`
	);
	for (const box of boxes) {
		expect(box.height).toBeGreaterThanOrEqual(44);
		expect(box.right).toBeLessThanOrEqual(390);
	}
	expect(await evaluate<boolean>('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
	// One row: both halves of the switch at the same height.
	expect(boxes[0].bottom).toBe(boxes[1].bottom);
}, 30_000);

test.skipIf(!CHROME)('the Herdr new-agent form has no mode switch and sends no mode', async () => {
	await open('?new-agent=wA');
	expect(await evaluate<number>(`${MODES}.length`)).toBe(0);
	expect((await sendForm('一般 Agent')).mode).toBeUndefined();
}, 30_000);
