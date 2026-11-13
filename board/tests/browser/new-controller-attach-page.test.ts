// Attachments on the first message of the new-controller form and of the Herdr new-agent form, in a
// real browser: pasted, picked or dropped files upload as on the command line, sending waits for them,
// the paths join the first message, and files stay when the launch fails. Launching is answered in
// the page, so nothing is started. Skipped when the host has no Chrome.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser } from '../browser.ts';

let fixture: Fixture;
let browser: Browser | undefined;
let folder: string;
let scratch: string;

const send = (method: string, params: object = {}) => browser!.tab.send(method, params);
const evaluate = <T>(expression: string) => browser!.tab.eval<T>(expression);
const until = (expression: string, timeoutMs?: number) => browser!.tab.until(expression, expression, timeoutMs);

const BOX = `document.querySelector('.new textarea')`;
const SUBMIT = `document.querySelector('form > .primary')`;
const TRAY = `[...document.querySelectorAll('.new .tray li')]`;
const TOAST = `document.body.innerText`;

const type = (text: string) =>
	evaluate(`(() => {
		const box = ${BOX};
		box.value = ${JSON.stringify(text)};
		box.dispatchEvent(new Event('input', { bubbles: true }));
	})()`);
const dropFile = (name: string, body: string) =>
	evaluate(`(() => {
		const data = new DataTransfer();
		data.items.add(new File([${JSON.stringify(body)}], ${JSON.stringify(name)}));
		${BOX}.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
	})()`);
const pasteFile = (name: string, body: string) =>
	evaluate(`(() => {
		const data = new DataTransfer();
		data.items.add(new File([${JSON.stringify(body)}], ${JSON.stringify(name)}));
		${BOX}.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
	})()`);
/** Answer the next launch in the page, keeping what the form sent; `held` makes it wait for `window.release()`. */
const catchLaunch = (ok: boolean) =>
	evaluate(`(() => {
		window.sentLaunch = null;
		const fetch = window.realFetch ?? window.fetch;
		window.realFetch = fetch;
		window.fetch = (input, init) => {
			if (String(input).endsWith('/api/launches') && init?.method === 'POST') {
				window.sentLaunch = JSON.parse(init.body);
				const answer = ${ok} ? { ok: true, reason: null, entry: null, logError: null } : { ok: false, reason: '測試不開', entry: null, logError: null };
				return Promise.resolve(new Response(JSON.stringify(answer), { status: ${ok} ? 200 : 409, headers: { 'content-type': 'application/json' } }));
			}
			return fetch(input, init);
		};
	})()`);
const open = async (search: string, width = 1200) => {
	await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width < 700 });
	await send('Page.navigate', { url: `${fixture.url}/${search}` });
	await until(`!!document.querySelector('#folder-box')?.value && !!${BOX}`);
};
const uploaded = (count: number) => until(`${TRAY}.length === ${count} && ${TRAY}.every((li) => li.title.startsWith('/'))`);
const click = async () => {
	await until(`!${SUBMIT}.disabled`);
	await evaluate(`${SUBMIT}.click()`);
};

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	const cookie = await fixture.login('new-controller-attach');
	const luna = fixture.bound('alpha', 'luna');
	folder = luna.workspace;
	mkdirSync(join(folder, '.git'), { recursive: true });
	fixture.report(luna.session_id, { tag: 'DONE', summary: '好了', hcom_name: 'luna', workspace: folder });
	fixture.list([luna]);
	writeFileSync(join(fixture.dir, 'herdr.json'), JSON.stringify({ workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }] }));
	await fixture.refresh(cookie);
	scratch = mkdtempSync(join(tmpdir(), 'lat-new-attach-'));
	browser = await launchChrome();
	const [name, value] = cookie.split('=');
	await send('Network.setCookie', { name, value, url: fixture.url });
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test.skipIf(!CHROME)('new controller: pasted and dropped files join the first message; a refused launch keeps them, a made one clears them', async () => {
	await open('?launch');
	await type('看這個');
	await pasteFile('a.txt', 'aaa');
	await dropFile('b.txt', 'bbb');
	await uploaded(2);
	const paths = await evaluate<string[]>(`${TRAY}.map((li) => li.title)`);

	await catchLaunch(false);
	await click();
	await until('window.sentLaunch !== null');
	expect((await evaluate<{ text: string }>('window.sentLaunch')).text).toBe(`看這個\n\n附件：\n${paths.join('\n')}`);
	await until(`${TOAST}.includes('表單內容保留著')`);
	expect(await evaluate<number>(`${TRAY}.length`)).toBe(2);
	expect(await evaluate<string>(`${BOX}.value`)).toBe('看這個');

	await catchLaunch(true);
	await click();
	await until('window.sentLaunch !== null');
	await until(`${TRAY}.length === 0 && ${BOX}.value === ''`);
}, 30_000);

test.skipIf(!CHROME)('new controller: files alone are enough, and a file still uploading blocks the send with the reason', async () => {
	await open('?launch');
	expect(await evaluate<boolean>(`${SUBMIT}.disabled`)).toBe(true);
	// Hold the upload's chunk until released.
	await evaluate(`(() => {
		const fetch = window.fetch;
		window.realFetchHeld = fetch;
		window.fetch = async (input, init) => {
			if (init?.method === 'PUT') await new Promise((resolve) => (window.release = resolve));
			return fetch(input, init);
		};
	})()`);
	await pasteFile('only.txt', 'only');
	await until(`!!${TRAY}[0] && ${TRAY}[0].innerText.includes('上傳中')`);
	await until(`!${SUBMIT}.disabled`);
	await catchLaunch(true);
	await click();
	await until(`${TOAST}.includes('附件還在上傳')`);
	expect(await evaluate('window.sentLaunch')).toBe(null);
	await evaluate('window.release()');
	await uploaded(1);
	const [path] = await evaluate<string[]>(`${TRAY}.map((li) => li.title)`);
	await click();
	await until('window.sentLaunch !== null');
	expect((await evaluate<{ text: string }>('window.sentLaunch')).text).toBe(`附件：\n${path}`);
}, 30_000);

test.skipIf(!CHROME)('new agent in a Herdr workspace takes files too, kept apart from the new controller form', async () => {
	await open('?launch');
	await pasteFile('c.txt', 'ccc');
	await uploaded(1);
	await open('?new-agent=wA');
	expect(await evaluate<number>(`${TRAY}.length`)).toBe(0);
	await pasteFile('d.txt', 'ddd');
	await uploaded(1);
	const [path] = await evaluate<string[]>(`${TRAY}.map((li) => li.title)`);
	await catchLaunch(false);
	await click();
	await until('window.sentLaunch !== null');
	expect((await evaluate<{ text: string }>('window.sentLaunch')).text).toBe(`附件：\n${path}`);
	await until(`${TOAST}.includes('表單內容保留著')`);
	expect(await evaluate<number>(`${TRAY}.length`)).toBe(1);
}, 30_000);

test.skipIf(!CHROME)('phone width: the paperclip and the tray fit without sideways scroll', async () => {
	await open('?launch', 390);
	for (const name of ['one.txt', 'two.txt', 'three.txt']) await pasteFile(name, name);
	await uploaded(3);
	const geometry = await evaluate<{ scroll: number; width: number; clip: DOMRect; tray: DOMRect; box: DOMRect }>(
		`({ scroll: document.documentElement.scrollWidth, width: innerWidth, clip: document.querySelector('.new .attach').getBoundingClientRect().toJSON(), tray: document.querySelector('.new .tray').getBoundingClientRect().toJSON(), box: ${BOX}.getBoundingClientRect().toJSON() })`
	);
	expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
	expect(geometry.clip.width).toBeGreaterThan(20);
	expect(geometry.clip.right).toBeLessThanOrEqual(geometry.width);
	expect(geometry.clip.left).toBeGreaterThanOrEqual(0);
	expect(geometry.tray.right).toBeLessThanOrEqual(geometry.width);
	expect(geometry.tray.bottom).toBeLessThanOrEqual(geometry.box.top + 1);
});
