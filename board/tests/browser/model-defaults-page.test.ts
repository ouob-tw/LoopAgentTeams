// The launch forms name the model and effort a client would use by default, and the command line's
// label shows a new controller's model once its first turn starts, without a reload. In a real
// browser: headless Chrome driven over its DevTools protocol, on the built board with fake data and
// client settings in the fixture's temporary home. Skipped when the host has no Chrome.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DEFAULT_UNREADABLE_TEXT } from '../../src/lib/board/models.ts';
import type { HelperController } from '../../src/lib/board/types.ts';
import { sleep, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser } from '../browser.ts';

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let luna: HelperController;
let own: string;
let plain: string;

const send = (method: string, params: object = {}) => browser!.tab.send(method, params);
const evaluate = <T>(expression: string) => browser!.tab.eval<T>(expression);
const until = (expression: string, timeoutMs?: number) => browser!.tab.until(expression, expression, timeoutMs);

/** The option of the form's model and effort fields that leaves the value to the client (its value is empty), as the page shows it. */
const SHOWN = `JSON.stringify([...document.querySelectorAll('.settings select')].map((select) => [...select.options].find((option) => option.value === '').text))`;
const shows = (model: string, effort: string) => until(`${SHOWN} === ${JSON.stringify(JSON.stringify([model, effort]))}`);
/** A known default that is in the list is marked on its own option: `value：預設`. */
const marked = (value: string) => `${value}：預設`;
/** The default is not offered twice: no option other than the empty one reads this text. */
const noDuplicateDefault = (index: number, value: string) =>
	until(`[...document.querySelectorAll('.settings select')[${index}].options].filter((option) => option.text === ${JSON.stringify(value)} || option.text.startsWith('預設')).length === 0`);
/** Click the radio button of the form with this value. */
async function choose(value: string) {
	const radio = `document.querySelector(${JSON.stringify(`input[type=radio][value="${value}"]`)})`;
	await until(`!!${radio}`);
	await evaluate(`${radio}.click()`);
}
/** Wait until the page has hydrated: the form has filled in the most recent folder. */
const filledIn = () => until(`!!document.querySelector('#folder-box')?.value`);
/** Type a folder into the form's folder box. */
async function pickFolder(path: string) {
	await evaluate(`(() => {
		const box = document.querySelector('#folder-box');
		box.value = ${JSON.stringify(path)};
		box.dispatchEvent(new Event('input', { bubbles: true }));
	})()`);
}
/** Pick an option of the model field. */
const pickModel = (value: string) =>
	evaluate(`(() => {
		const select = document.querySelectorAll('.settings select')[0];
		select.value = ${JSON.stringify(value)};
		select.dispatchEvent(new Event('change', { bubbles: true }));
	})()`);

function write(path: string, content: string | object) {
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
}
const home = () => join(fixture.dir, 'home');

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	cookie = await fixture.login('model-defaults');
	write(join(home(), '.claude/settings.json'), { model: 'opus', effortLevel: 'medium', modelSettings: { 'claude-sonnet-5-5': { effortLevel: 'low' } } });
	write(join(home(), '.codex/config.toml'), 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "medium"\n');
	// Two projects controllers have reported from: one with its own Claude settings.
	luna = fixture.bound('own', 'luna');
	own = luna.workspace;
	write(join(own, '.claude/settings.local.json'), { model: 'haiku', effortLevel: 'high' });
	const sol = fixture.bound('plain', 'sol');
	plain = sol.workspace;
	fixture.report(luna.session_id, { tag: 'DONE', summary: '好了', hcom_name: 'luna', workspace: own });
	fixture.report(sol.session_id, { tag: 'DONE', summary: '好了', hcom_name: 'sol', workspace: plain });
	fixture.list([luna, sol]);
	writeFileSync(join(fixture.dir, 'herdr.json'), JSON.stringify({ workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }] }));
	await fixture.refresh(cookie);
	browser = await launchChrome({ screen: SHOWN });
	const [name, value] = cookie.split('=');
	await send('Network.setCookie', { name, value, url: fixture.url });
	await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

test.skipIf(!CHROME)("the new-controller form names each client's defaults, the folder's own, and the effort for a chosen model", async () => {
	await send('Page.navigate', { url: `${fixture.url}/?launch` });
	await filledIn();
	// No folder: the user's settings alone.
	await pickFolder('');
	await shows(marked('claude-opus-5-5'), marked('medium'));
	// The marked option is the initial selection and the only one that reads as that value or as a 預設 line.
	await noDuplicateDefault(0, 'claude-opus-5-5');
	await noDuplicateDefault(1, 'medium');
	expect(await evaluate<string>(`JSON.stringify([...document.querySelectorAll('.settings select')].map((select) => [select.value, select.selectedOptions[0].text]))`)).toBe(
		JSON.stringify([['', marked('claude-opus-5-5')], ['', marked('medium')]])
	);
	// An effort chosen explicitly that then becomes the default folds into the marked option.
	await evaluate(`(() => { const s = document.querySelectorAll('.settings select')[1]; s.value = 'high'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
	await pickFolder(own);
	await shows(marked('claude-haiku-5-5'), marked('high'));
	expect(await evaluate<string>(`document.querySelectorAll('.settings select')[1].value`)).toBe('');
	await pickFolder(plain);
	await shows(marked('claude-opus-5-5'), marked('medium'));
	// A default that is not in the list keeps the single first option with its own text.
	write(join(own, '.claude/settings.local.json'), { model: 'claude-future-9', effortLevel: 'ultra' });
	await pickFolder(own + '/');
	await shows('預設：Future 9（claude-future-9）', '預設：ultra');
	write(join(own, '.claude/settings.local.json'), { model: 'haiku', effortLevel: 'high' });
	// Another folder first: a read again for the same folder is not made.
	await pickFolder(plain);
	await pickFolder(own);
	await shows(marked('claude-haiku-5-5'), marked('high'));
	await pickFolder(plain);
	await shows(marked('claude-opus-5-5'), marked('medium'));
	// Only the model chosen: the effort it gets is what modelSettings gives that model.
	await pickModel('claude-sonnet-5-5');
	await shows(marked('claude-opus-5-5'), marked('low'));
	await pickModel('claude-fable-5-2');
	await shows(marked('claude-opus-5-5'), marked('medium'));
	await choose('codex');
	await shows(marked('gpt-6.1-sol'), marked('medium'));

	// Settings that cannot be read say the client's own default is used.
	write(join(home(), '.codex/config.toml'), 'model = "gpt-6.1-sol\n');
	await pickFolder(own);
	await shows(`預設：${DEFAULT_UNREADABLE_TEXT}`, `預設：${DEFAULT_UNREADABLE_TEXT}`);
	write(join(home(), '.codex/config.toml'), 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "medium"\n');
	await pickFolder(plain);
	await shows(marked('gpt-6.1-sol'), marked('medium'));

	// A read again for the same folder that fails does not keep showing what may be out of date.
	await evaluate(`(() => {
		const fetch = window.fetch;
		window.fetch = (input, init) => (String(input).includes('/api/launches/defaults') ? Promise.reject(new TypeError('offline')) : fetch(input, init));
		window.restoreFetch = () => (window.fetch = fetch);
	})()`);
	fixture.report(luna.session_id, { tag: 'DONE', summary: '又好了', hcom_name: 'luna', workspace: own });
	await fixture.refresh(cookie);
	await shows('預設：看板讀取 client 設定失敗', '預設：看板讀取 client 設定失敗');
	await evaluate('window.restoreFetch()');
	await choose('claude');
}, 30_000);

test.skipIf(!CHROME)("the new-agent form names the defaults the same way", async () => {
	await send('Page.navigate', { url: `${fixture.url}/?new-agent=wA` });
	await until(`document.querySelector('h2')?.textContent.includes('Alpha')`);
	await filledIn();
	await pickFolder(own);
	await shows(marked('claude-haiku-5-5'), marked('high'));
	await choose('codex');
	await shows(marked('gpt-6.1-sol'), marked('medium'));
	await choose('claude');
}, 30_000);

test.skipIf(!CHROME)("the command line's label shows a new controller's settings once its first turn starts, without a reload", async () => {
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', `${luna.session_id}.jsonl`), JSON.stringify({ kind: 'user', time: null, text: '開始' }) + '\n');
	await send('Page.navigate', { url: `${fixture.url}/?launch` });
	// Addressed from the command line: its conversation is not open, so nothing feeds the label.
	// Hydrated: the form has read the defaults.
	await filledIn();
	await pickFolder(plain);
	await shows(marked('claude-opus-5-5'), marked('medium'));
	await evaluate(`document.querySelector('textarea[aria-label^="指令列"]').focus()`);
	await send('Input.insertText', { text: '@luna 你好' });
	const parts = `JSON.stringify([...document.querySelectorAll('.picker .part')].map((part) => part.textContent.trim()))`;
	await until(`${parts} === '["模型","強度"]'`);
	// The first read found no turn; the next board data reads again.
	const deadline = Date.now() + 10_000;
	while (!fixture.helperArgs('transcript').some((args) => args.includes(`--session-id=${luna.session_id}`))) {
		if (Date.now() > deadline) throw new Error(`the label never read the conversation: ${await evaluate(`document.querySelector('.to')?.textContent + '|' + document.querySelector('textarea[aria-label^="指令列"]').value + '|' + document.querySelector('textarea[aria-label^="指令列"]').getAttribute('aria-label')`)} ${JSON.stringify(fixture.helperArgs('transcript'))}`);
		await sleep(50);
	}
	await sleep(300);
	expect(await evaluate<string>(parts)).toBe('["模型","強度"]');

	writeFileSync(
		join(fixture.dir, 'transcripts', `${luna.session_id}.current.json`),
		JSON.stringify({ model: 'claude-opus-5-5', effort: 'high', time: '2026-10-20T01:00:00.000Z' })
	);
	fixture.report(luna.session_id, { tag: 'HELP', summary: '第一回合開始了', hcom_name: 'luna', workspace: own });
	await fixture.refresh(cookie);
	await until(`${parts} === '["Opus 5.5","H"]'`);
}, 30_000);
