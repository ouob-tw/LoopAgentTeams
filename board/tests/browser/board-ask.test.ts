import { launchChrome, type Browser, type Tab } from '../browser.ts';
// A board ask from end to end in a real browser: the real hook asks (as Claude would run it) into
// the test board's shared folder, the agent's page shows the card, the answer goes back through the
// hook. Two browsers answering at once: one answer counts, the other is told someone answered.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';

const HOOK = join(import.meta.dir, '../../hooks/board-ask.py');
const SCREEN = `({ detail: document.querySelector('.detail')?.innerText ?? '', notices: document.querySelector('.dock .toasts')?.innerText ?? '' })`;

let fixture: Fixture;
let cookie: string;
const browsers: Browser[] = [];

const QUESTIONS = [
	{ question: 'Pick a color?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'Choose red.' }, { label: 'Blue', description: 'Choose blue.' }] },
	{ question: 'Pick fruits?', header: 'Fruit', multiSelect: true, options: [{ label: 'Apple', description: 'Crisp.' }, { label: 'Cherry, sour', description: 'Small.' }] }
];

/** The hook as Claude runs it for the agent of session `s-ask`, asking into the board's folder. */
function ask(questions: object[]) {
	const child = Bun.spawn(['uv', 'run', '--no-project', 'python', HOOK, 'hook'], {
		stdin: new TextEncoder().encode(
			JSON.stringify({ session_id: 's-ask', cwd: '/work', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions }, tool_use_id: 'toolu_1' })
		),
		stdout: 'pipe',
		env: { PATH: Bun.env.PATH ?? '', HOME: Bun.env.HOME ?? '', LAT_BOARD_ASKS_DIR: join(fixture.dir, 'board-asks'), HERDR_PANE_ID: 'wA:p-s-ask', LAT_BOARD_ASK_WAIT_SECONDS: '60' }
	});
	return Promise.all([child.exited, new Response(child.stdout).text()]).then(([code, stdout]) => ({ code, stdout }));
}

beforeAll(async () => {
	fixture = await startFixture();
	cookie = await fixture.login();
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents: [{ agent: 'claude', agent_session: { kind: 'id', value: 's-ask' }, agent_status: 'blocked', cwd: '/work', pane_id: 'wA:p-s-ask', tab_id: 'wA:t-s-ask', workspace_id: 'wA' }],
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
			tabs: [{ tab_id: 'wA:t-s-ask', workspace_id: 'wA', label: 'asker' }]
		})
	);
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', 's-ask.jsonl'), JSON.stringify({ kind: 'user', time: '2026-10-24T09:00:00.000Z', text: '問我幾個問題' }) + '\n');
	await fixture.refresh(cookie);
}, 30_000);
afterEach(async () => {
	for (const browser of browsers.splice(0)) await browser.close();
});
afterAll(async () => {
	await fixture?.cleanup();
});

/** A new Chrome on the board's Herdr 分頁 with the asking agent's page open. */
async function open(): Promise<Tab> {
	const browser = await launchChrome({ screen: SCREEN });
	browsers.push(browser);
	const { tab } = browser;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
	await tab.send('Page.navigate', { url: `${fixture.url}/` });
	await tab.until(`JSON.stringify(history.state).includes('depth')`, 'the board to start');
	await tab.eval(`document.querySelector('[data-middle="agents"]').click()`);
	await tab.until(`document.querySelector('[data-agent="s-ask"]')`, 'the agent in the list');
	return tab;
}
const card = '.detail [data-ask]';
/** Check the option `label` of question `index`, or 其他. */
const choose = (tab: Tab, index: number, label: string) =>
	tab.eval(`[...document.querySelectorAll('${card} [data-question="${index}"] label')].find((entry) => entry.innerText.split('\\n')[0] === ${JSON.stringify(label)}).querySelector('input').click()`);
const sendButton = `${card} form button`;

test('the question shows on its agent\'s page, is answered there and goes back to the client', async () => {
	const answered = ask(QUESTIONS);
	const tab = await open();
	await tab.until(`document.querySelector('[data-agent="s-ask"]').innerText.includes('等你回答')`, 'the list to say 等你回答');
	await tab.eval(`document.querySelector('[data-agent="s-ask"]').click()`);
	await tab.until(`document.querySelector('${card}')`, 'the card');
	// Above the conversation: where it is newest.
	expect(await tab.eval(`document.querySelector('${card}').compareDocumentPosition(document.querySelector('.detail [role="tabpanel"]:not([hidden]) li, .detail [role="tabpanel"]:not([hidden]) article:not([data-ask])')) & Node.DOCUMENT_POSITION_FOLLOWING`)).toBeTruthy();
	expect(await tab.eval(`document.querySelector('.detail .profile .status').innerText`)).toContain('等你回答');
	const shown = await tab.eval<{ question: string; options: string[] }[]>(
		`[...document.querySelectorAll('${card} [data-question]')].map((section) => ({ question: section.querySelector('h2').innerText, options: [...section.querySelectorAll('li')].map((li) => li.innerText.replace(/\\s+/g, ' ').trim()) }))`
	);
	expect(shown).toEqual([
		{ question: 'Color Pick a color? 單選', options: ['Red Choose red.', 'Blue Choose blue.', '其他'] },
		{ question: 'Fruit Pick fruits? 複選', options: ['Apple Crisp.', 'Cherry, sour Small.', '其他'] }
	]);
	expect(await tab.eval(`document.querySelector('${card} [role="timer"]').innerText`)).toMatch(/^剩 [01]:\d\d/);

	await choose(tab, 0, 'Blue');
	// Both questions must be answered first.
	expect(await tab.eval(`document.querySelector('${sendButton}').disabled`)).toBe(true);
	await choose(tab, 1, 'Apple');
	// A label with a comma in it is still one option once answered.
	await choose(tab, 1, 'Cherry, sour');
	await choose(tab, 1, '其他');
	await tab.until(`document.querySelector('${card} [data-question="1"] textarea')`, 'the 其他 box');
	await tab.eval(`(() => { const box = document.querySelector('${card} [data-question="1"] textarea'); box.value = 'Mango'; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
	await tab.eval(`document.querySelector('${sendButton}').click()`);

	const { code, stdout } = await answered;
	expect(code).toBe(0);
	expect(JSON.parse(stdout).hookSpecificOutput).toEqual({
		hookEventName: 'PreToolUse',
		permissionDecision: 'allow',
		updatedInput: { questions: QUESTIONS, answers: { 'Pick a color?': 'Blue', 'Pick fruits?': 'Apple, Cherry, sour, Mango' } }
	});
	await tab.until(`document.querySelector('${card}').dataset.state === 'filled'`, 'the card to read 已填回');
	expect(await tab.eval(`document.querySelector('${card}').innerText`)).toContain('已填回');
	expect(await tab.eval(`document.querySelectorAll('${card} input, ${card} textarea, ${card} button').length`)).toBe(0);
	expect(await tab.eval(`[...document.querySelectorAll('${card} li.picked')].map((li) => li.innerText.replace(/\\s+/g, ' ').trim())`)).toEqual([
		'✓ Blue Choose blue.',
		'✓ Apple Crisp.',
		'✓ Cherry, sour Small.',
		'✓ 其他：Mango'
	]);
	await tab.until(`!document.querySelector('[data-agent="s-ask"]').innerText.includes('等你回答')`, 'the list to stop saying 等你回答');

	await tab.eval(`document.querySelector('.detail [data-tab="log"]').click()`);
	await tab.until(`document.querySelector('.detail [data-action="board-ask"]')`, 'the operation record entry');
	expect(await tab.eval(`document.querySelector('.detail [data-action="board-ask"]').innerText`)).toMatch(/看板提問[\s\S]*已送出答案[\s\S]*Pick a color\? → Blue\nPick fruits\? → Apple, Cherry, sour, Mango/);
	expect(tab.errors).toEqual([]);
}, 60_000);

test('two browsers answering at once: one answer counts, the other is told someone answered', async () => {
	const answered = ask([QUESTIONS[0]]);
	const tabs = await Promise.all([open(), open()]);
	for (const tab of tabs) {
		await tab.eval(`document.querySelector('[data-agent="s-ask"]').click()`);
		await tab.until(`document.querySelector('${card}[data-state="waiting"]')`, 'the waiting card');
	}
	await choose(tabs[0], 0, 'Red');
	await choose(tabs[1], 0, 'Blue');
	await Promise.all(tabs.map((tab) => tab.eval(`document.querySelector('${sendButton}').click()`)));

	const { stdout } = await answered;
	const got = JSON.parse(stdout).hookSpecificOutput.updatedInput.answers['Pick a color?'];
	const winner = tabs[got === 'Red' ? 0 : 1];
	const loser = tabs[got === 'Red' ? 1 : 0];
	await winner.until(`document.querySelector('${card}').dataset.state === 'filled'`, 'the winner to read 已填回');
	await loser.until(`document.querySelector('${card}').dataset.state === 'taken'`, 'the other to read 已有人作答');
	expect(await loser.eval(`document.querySelector('${card}').innerText`)).toContain('已有人作答');
	expect(await loser.eval(`document.querySelector('.dock .toasts').innerText`)).toContain('已有人作答');
}, 60_000);
