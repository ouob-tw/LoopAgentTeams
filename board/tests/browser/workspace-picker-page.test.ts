// The launch forms' Herdr workspace field, in a real browser: where each form starts, the new
// workspace's name following the folder until it is typed, what the form sends, and that the field
// fits a phone's width. Sending is answered in the page, so nothing is launched; what the server
// does with each choice is in tests/server/agent-launch.test.ts. Skipped when the host has no Chrome.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser } from '../browser.ts';

let fixture: Fixture;
let browser: Browser | undefined;
let alpha: string;
let beta: string;

const send = (method: string, params: object = {}) => browser!.tab.send(method, params);
const evaluate = <T>(expression: string) => browser!.tab.eval<T>(expression);
const until = (expression: string, timeoutMs?: number) => browser!.tab.until(expression, expression, timeoutMs);

const SELECT = `[...document.querySelectorAll('.where select')][0]`;
const OPTIONS = `JSON.stringify([...${SELECT}.options].map((option) => [option.value, option.text]))`;
const TITLE = `document.querySelector('.new h2')?.textContent`;
const NAME = `document.querySelector('.where input')`;

/** Choose an option of the workspace field, the way picking it does. */
const pick = (value: string) =>
	evaluate(`(() => {
		const select = ${SELECT};
		select.value = ${JSON.stringify(value)};
		select.dispatchEvent(new Event('change', { bubbles: true }));
	})()`);
/** Type into a box the way the keyboard does. */
const type = (box: string, text: string) =>
	evaluate(`(() => {
		const box = ${box};
		box.value = ${JSON.stringify(text)};
		box.dispatchEvent(new Event('input', { bubbles: true }));
	})()`);
/** Answer the next launch in the page, keeping what the form sent in `window.sentLaunch`. */
const catchLaunch = () =>
	evaluate(`(() => {
		window.sentLaunch = null;
		const fetch = window.realFetch ?? window.fetch;
		window.realFetch = fetch;
		window.fetch = (input, init) => {
			if (String(input).endsWith('/api/launches') && init?.method === 'POST') {
				window.sentLaunch = JSON.parse(init.body);
				return Promise.resolve(new Response(JSON.stringify({ ok: false, reason: '測試不開', entry: null, logError: null }), { status: 409, headers: { 'content-type': 'application/json' } }));
			}
			return fetch(input, init);
		};
	})()`);
const sent = async () => {
	await until('window.sentLaunch !== null');
	return evaluate<{ workspace: unknown; agent: unknown }>('window.sentLaunch');
};

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	const cookie = await fixture.login('workspace-picker');
	const luna = fixture.bound('alpha', 'luna');
	alpha = luna.workspace;
	const sol = fixture.bound('beta', 'sol');
	beta = sol.workspace;
	fixture.report(luna.session_id, { tag: 'DONE', summary: '好了', hcom_name: 'luna', workspace: alpha });
	fixture.list([luna, sol]);
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			workspaces: [
				{ workspace_id: 'wA', number: 1, label: 'Alpha' },
				{ workspace_id: 'wE', number: 2, label: 'Empty' }
			]
		})
	);
	await fixture.refresh(cookie);
	browser = await launchChrome();
	const [name, value] = cookie.split('=');
	await send('Network.setCookie', { name, value, url: fixture.url });
	await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

test.skipIf(!CHROME)("a workspace's + form starts in that workspace and offers the others, auto and a new one", async () => {
	await send('Page.navigate', { url: `${fixture.url}/?new-agent=wA` });
	await until(`!!document.querySelector('#folder-box')?.value && !!${SELECT}`);
	expect(await evaluate<string>(`${SELECT}.value`)).toBe('current');
	expect(JSON.parse(await evaluate<string>(OPTIONS))).toEqual([
		['current', '當前工作區（Alpha）'],
		['auto', '自動（依資料夾挑選，沒有就新增）'],
		['in:wE', 'Empty'],
		['new', '新建工作區…']
	]);
	expect(await evaluate<string>(TITLE)).toBe('在 Alpha 開新 Agent');

	// Left as it is, the agent opens where the + was pressed.
	await catchLaunch();
	await until(`!document.querySelector('form > .primary').disabled`);
	await evaluate(`document.querySelector('form > .primary').click()`);
	expect((await sent()).workspace).toEqual({ kind: 'existing', id: 'wA' });

	await pick('in:wE');
	await until(`${TITLE} === '在 Empty 開新 Agent'`);
	await catchLaunch();
	await evaluate(`document.querySelector('form > .primary').click()`);
	expect((await sent()).workspace).toEqual({ kind: 'existing', id: 'wE' });

	await pick('auto');
	await until(`${TITLE} === '在 自動選擇的工作區 開新 Agent'`);
	await catchLaunch();
	await evaluate(`document.querySelector('form > .primary').click()`);
	expect((await sent()).workspace).toEqual({ kind: 'auto' });
}, 30_000);

test.skipIf(!CHROME)('a new workspace is named after the folder until the name is typed, and is sent with it', async () => {
	await send('Page.navigate', { url: `${fixture.url}/?new-agent=wA` });
	await until(`!!document.querySelector('#folder-box')?.value && !!${SELECT}`);
	await type(`document.querySelector('#folder-box')`, alpha);
	await pick('new');
	await until(`${NAME}?.value === ${JSON.stringify(alpha.split('/').at(-1))}`);
	// Another folder renames it while the name was not typed.
	await type(`document.querySelector('#folder-box')`, beta);
	await until(`${NAME}?.value === ${JSON.stringify(beta.split('/').at(-1))}`);
	await type(NAME, '我的工作區');
	await type(`document.querySelector('#folder-box')`, alpha);
	await until(`${TITLE} === '在 新工作區「我的工作區」 開新 Agent'`);
	expect(await evaluate<string>(`${NAME}.value`)).toBe('我的工作區');

	await catchLaunch();
	await until(`!document.querySelector('form > .primary').disabled`);
	await evaluate(`document.querySelector('form > .primary').click()`);
	expect((await sent()).workspace).toEqual({ kind: 'new', label: '我的工作區' });
	// A failed launch keeps the form as it was.
	await until(`${NAME}?.value === '我的工作區' && ${SELECT}.value === 'new'`);

	// An emptied name cannot be sent.
	await type(NAME, ' ');
	await until(`document.querySelector('form > .primary').disabled`);
	expect(await evaluate<string>(`document.querySelector('.new .failed')?.textContent`)).toBe('請輸入新工作區的名稱。');
	await type(NAME, '我的工作區');
}, 30_000);

test.skipIf(!CHROME)('the new-controller form starts automatically, as before, and has no current workspace', async () => {
	await send('Page.navigate', { url: `${fixture.url}/?launch` });
	await until(`!!document.querySelector('#folder-box')?.value && !!${SELECT}`);
	expect(await evaluate<string>(`${SELECT}.value`)).toBe('auto');
	expect(JSON.parse(await evaluate<string>(OPTIONS)).map(([value]: string[]) => value)).toEqual(['auto', 'in:wA', 'in:wE', 'new']);
	expect(await evaluate<string>(TITLE)).toBe('新建主控');
	await type(`document.querySelector('.new textarea')`, '做一件事');

	await catchLaunch();
	await until(`!document.querySelector('form > .primary').disabled`);
	await evaluate(`document.querySelector('form > .primary').click()`);
	expect(await sent()).toMatchObject({ workspace: { kind: 'auto' }, agent: null });

	await pick('in:wE');
	await until(`${TITLE} === '在 Empty 新建主控'`);
	await catchLaunch();
	await evaluate(`document.querySelector('form > .primary').click()`);
	expect((await sent()).workspace).toEqual({ kind: 'existing', id: 'wE' });
	await pick('auto');
}, 30_000);

test.skipIf(!CHROME)('at a phone\'s width the field and the name box fit without scrolling sideways', async () => {
	await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 740, deviceScaleFactor: 2, mobile: true });
	await send('Page.navigate', { url: `${fixture.url}/?new-agent=wA` });
	await until(`!!document.querySelector('#folder-box')?.value && !!${SELECT}`);
	await pick('new');
	await until(`!!${NAME}`);
	const fits = `(() => {
		const width = document.documentElement.clientWidth;
		const inside = [${SELECT}, ${NAME}].every((box) => box.getBoundingClientRect().right <= width + 0.5);
		return inside && document.documentElement.scrollWidth <= width;
	})()`;
	await until(fits);
	await pick('current');
	await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
}, 30_000);
