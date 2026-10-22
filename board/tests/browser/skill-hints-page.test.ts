// Skill-name hints in a real browser: headless Chrome driven over its DevTools protocol, on the
// built board with fake data, Claude's skills in the fixture's temporary home and project folder,
// and Codex's from a fake Codex app server. The command line hints the skills of whoever the line
// goes to; the new-controller and new-agent forms those of the chosen client. Skipped when the host
// has no Chrome.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { NODE, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser } from '../browser.ts';

const ROOT = join(import.meta.dir, '../..');
const codexDir = mkdtempSync(join(tmpdir(), 'lat-board-skill-hints-'));

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let project: string;

const tab = () => browser!.tab;
const evaluate = <T>(expression: string) => tab().eval<T>(expression);
const until = (expression: string, what = expression) => tab().until(expression, what);

const LINE = 'textarea[aria-label^="指令列"]';
const FIRST = 'textarea[aria-label="第一句話"]';
/** The names the open hint list shows, as shown. */
const SHOWN = `JSON.stringify([...document.querySelectorAll('[role="listbox"][aria-label="Skill"] strong')].map((name) => name.textContent))`;
const shows = (names: string[]) => until(`${SHOWN} === ${JSON.stringify(JSON.stringify(names))}`, `the list shows ${names.join(', ')}`);
const closed = (what: string) => until(`!document.querySelector('[role="listbox"][aria-label="Skill"]')`, what);
const valueOf = (box: string) => evaluate<string>(`document.querySelector(${JSON.stringify(box)}).value`);

/** Empty a box and put the focus in it. */
async function clear(box: string) {
	await evaluate(`(() => {
		const box = document.querySelector(${JSON.stringify(box)});
		box.focus();
		box.value = '';
		box.dispatchEvent(new Event('input', { bubbles: true }));
	})()`);
}
const type = (text: string) => tab().send('Input.insertText', { text });
const KEY_CODES = { ArrowDown: 40, ArrowUp: 38, Enter: 13, Tab: 9, Escape: 27 } as const;
async function press(name: keyof typeof KEY_CODES) {
	for (const kind of ['keyDown', 'keyUp']) {
		await tab().send('Input.dispatchKeyEvent', { type: kind, key: name, code: name, windowsVirtualKeyCode: KEY_CODES[name], ...(kind === 'keyDown' && name === 'Enter' ? { text: '\r' } : {}) });
	}
}

function skill(folder: string, name: string, description: string) {
	mkdirSync(join(folder, name), { recursive: true });
	writeFileSync(join(folder, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n`);
}

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture({
		env: {
			LAT_BOARD_SKILLS_COMMAND: JSON.stringify([NODE, join(ROOT, 'tests/fake-codex.mjs'), codexDir]),
			// What the line sends is typed by a fake, logged in the same folder.
			LAT_BOARD_INJECT_COMMAND: JSON.stringify([NODE, join(ROOT, 'tests/fake-inject.mjs'), codexDir])
		}
	});
	cookie = await fixture.login('skill-hints');
	const home = join(fixture.dir, 'home');
	const luna = fixture.bound('proj', 'luna');
	const sol = fixture.bound('proj', 'sol', { client: 'codex' });
	project = luna.workspace;
	mkdirSync(join(project, '.git'), { recursive: true });
	skill(join(home, '.claude/skills'), 'user-one', 'User skill. More words.');
	skill(join(project, '.claude/skills'), 'project-one', '專案的 skill。');
	skill(join(project, '.agents/skills'), 'codex-project', 'Codex only.');
	writeFileSync(
		join(codexDir, 'codex.json'),
		JSON.stringify({
			skills: [
				{ name: 'codex-project', description: 'Codex only. More.', enabled: true },
				{ name: 'tdd', description: 'Test first.', enabled: true }
			]
		})
	);
	fixture.report(luna.session_id, { tag: 'DONE', summary: '好了', hcom_name: 'luna', workspace: project });
	fixture.report(sol.session_id, { tag: 'DONE', summary: '好了', hcom_name: 'sol', workspace: project });
	fixture.list([luna, sol]);
	await fixture.refresh(cookie);
	browser = await launchChrome({ screen: SHOWN });
	const [name, value] = cookie.split('=');
	await tab().send('Network.setCookie', { name, value, url: fixture.url });
	await tab().send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
	rmSync(codexDir, { recursive: true, force: true });
});

test.skipIf(!CHROME)("the command line hints the recipient's own skills: `/` for Claude, `$` for Codex", async () => {
	await tab().navigate(`${fixture.url}/?launch`);
	await until(`!!document.querySelector('#folder-box')?.value`, 'the page hydrated');
	await clear(LINE);
	await type('@luna /');
	await shows(['/project-one', '/user-one']);
	expect(await evaluate<string>(`document.querySelector('[role="listbox"][aria-label="Skill"]').textContent`)).toContain('User skill.');
	expect(await evaluate<string>(`document.querySelector('[role="listbox"][aria-label="Skill"]').textContent`)).not.toContain('More words');
	await type('us');
	await shows(['/user-one']);
	// Enter puts it in and sends nothing.
	await press('Enter');
	await closed('the list closed by the pick');
	expect(await valueOf(LINE)).toBe('@luna /user-one ');

	// Esc closes the list and leaves the text as it was; typing on in the same name keeps it closed.
	await type('/p');
	await shows(['/project-one']);
	await press('Escape');
	await closed('the list closed by Esc');
	expect(await valueOf(LINE)).toBe('@luna /user-one /p');
	await type('r');
	await Bun.sleep(200);
	expect(await evaluate(SHOWN)).toBe('[]');

	// A slash inside a word or a path opens nothing; nor does the other client's character.
	await clear(LINE);
	await type('@luna a/b and /home/u');
	await Bun.sleep(300);
	expect(await evaluate(SHOWN)).toBe('[]');
	await clear(LINE);
	await type('@luna $');
	await Bun.sleep(300);
	expect(await evaluate(SHOWN)).toBe('[]');

	// Codex: `$`, its own list, picked by the arrows and Tab.
	await clear(LINE);
	await type('@sol $');
	await shows(['$codex-project', '$tdd']);
	await press('ArrowDown');
	await press('Tab');
	await closed('the list closed by Tab');
	expect(await valueOf(LINE)).toBe('@sol $tdd ');
	await clear(LINE);
	await type('@sol /');
	await Bun.sleep(300);
	expect(await evaluate(SHOWN)).toBe('[]');
}, 30_000);

test.skipIf(!CHROME)('no list opens while an input method is composing', async () => {
	await clear(LINE);
	await type('@luna ');
	await tab().send('Input.imeSetComposition', { text: '/', selectionStart: 1, selectionEnd: 1 });
	await Bun.sleep(300);
	expect(await evaluate(SHOWN)).toBe('[]');
	await tab().send('Input.insertText', { text: '／' });
	await Bun.sleep(300);
	expect(await evaluate(SHOWN)).toBe('[]');
	expect(await valueOf(LINE)).toBe('@luna ／');
	// The Enter Safari sends to confirm a candidate (key code 229) is the input method's, not the list's.
	await clear(LINE);
	await type('@luna /');
	await shows(['/project-one', '/user-one']);
	for (const kind of ['keyDown', 'keyUp']) await tab().send('Input.dispatchKeyEvent', { type: kind, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229 });
	await Bun.sleep(200);
	expect(await valueOf(LINE)).toBe('@luna /');
	await press('Escape');
}, 30_000);

test.skipIf(!CHROME)('a skill list that cannot be read shows no hints and the line still sends', async () => {
	await tab().navigate(`${fixture.url}/?launch`);
	await until(`!!document.querySelector('#folder-box')?.value`, 'the page hydrated');
	await evaluate(`(() => {
		const fetch = window.fetch;
		window.fetch = (input, init) => (String(input).includes('/api/skills') ? Promise.reject(new TypeError('offline')) : fetch(input, init));
	})()`);
	await clear(LINE);
	await type('@luna /us');
	await Bun.sleep(300);
	expect(await evaluate(SHOWN)).toBe('[]');
	await type(' 你好');
	await evaluate(`document.querySelector('.cmd .send-slot button').click()`);
	await until(`document.querySelector(${JSON.stringify(LINE)}).value === ''`, 'the line sent and emptied');
	expect(readFileSync(join(codexDir, 'inject-typed.jsonl'), 'utf8')).toContain('/us 你好');
}, 30_000);

test.skipIf(!CHROME)('the new-controller and new-agent forms hint the chosen client, picked with a tap', async () => {
	writeFileSync(join(fixture.dir, 'herdr.json'), JSON.stringify({ workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }] }));
	for (const url of [`${fixture.url}/?launch`, `${fixture.url}/?new-agent=wA`]) {
		await tab().navigate(url);
		await until(`!!document.querySelector('#folder-box')?.value`, 'the page hydrated');
		await evaluate(`(() => {
			const box = document.querySelector('#folder-box');
			box.value = ${JSON.stringify(project)};
			box.dispatchEvent(new Event('input', { bubbles: true }));
			document.querySelector('input[type=radio][value="claude"]').click();
		})()`);
		const box = url.includes('new-agent') ? 'textarea[aria-label="第一則訊息（選填）"]' : FIRST;
		await clear(box);
		await type('請 /');
		await shows(['/project-one', '/user-one']);
		await tab().pointerClick('[role="listbox"][aria-label="Skill"] li:nth-child(2) button');
		await closed('the list closed by the tap');
		expect(await valueOf(box)).toBe('請 /user-one ');
		await evaluate(`document.querySelector('input[type=radio][value="codex"]').click()`);
		await clear(box);
		await type('$');
		await shows(['$codex-project', '$tdd']);
		await press('Enter');
		expect(await valueOf(box)).toBe('$codex-project ');
		await evaluate(`document.querySelector('input[type=radio][value="claude"]').click()`);
	}
}, 30_000);

test.skipIf(!CHROME)('on a phone the list fits the screen, above the line and in the new form, and takes a tap', async () => {
	await tab().send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
	await tab().navigate(`${fixture.url}/?launch`);
	await until(`!!document.querySelector('#folder-box')?.value`, 'the page hydrated');
	await clear(LINE);
	await type('@luna /');
	await shows(['/project-one', '/user-one']);
	const box = await evaluate<{ left: number; right: number; top: number; bottom: number; line: number }>(`(() => {
		const r = document.querySelector('[role="listbox"][aria-label="Skill"]').getBoundingClientRect();
		return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, line: document.querySelector(${JSON.stringify(LINE)}).getBoundingClientRect().top };
	})()`);
	expect(box.left).toBeGreaterThanOrEqual(0);
	expect(box.right).toBeLessThanOrEqual(390);
	expect(box.top).toBeGreaterThanOrEqual(0);
	expect(box.bottom).toBeLessThanOrEqual(box.line);
	await tab().pointerClick('[role="listbox"][aria-label="Skill"] li:nth-child(1) button');
	await closed('the list closed by the tap');
	expect(await valueOf(LINE)).toBe('@luna /project-one ');

	// The new form's first message, on the same phone.
	await evaluate(`(() => {
		const box = document.querySelector('#folder-box');
		box.value = ${JSON.stringify(project)};
		box.dispatchEvent(new Event('input', { bubbles: true }));
		document.querySelector('input[type=radio][value="codex"]').click();
	})()`);
	await clear(FIRST);
	await type('$');
	await shows(['$codex-project', '$tdd']);
	const form = await evaluate<{ left: number; right: number; top: number }>(`(() => {
		const r = document.querySelector('[role="listbox"][aria-label="Skill"]').getBoundingClientRect();
		return { left: r.left, right: r.right, top: r.top };
	})()`);
	expect(form.left).toBeGreaterThanOrEqual(0);
	expect(form.right).toBeLessThanOrEqual(390);
	expect(form.top).toBeGreaterThanOrEqual(0);
	await tab().pointerClick('[role="listbox"][aria-label="Skill"] li:nth-child(2) button');
	await closed('the list closed by the tap');
	expect(await valueOf(FIRST)).toBe('$tdd ');
	await evaluate(`document.querySelector('input[type=radio][value="claude"]').click()`);
	await tab().send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
}, 30_000);
