import { launchChrome, type Browser, type Tab } from '../browser.ts';
// A board ask from end to end in a real browser: the real hook asks (as Claude would run it) into
// the test board's shared folder, the agent's page shows the card, the answer goes back through the
// hook. Two browsers answering at once: one answer counts, the other is told someone answered.
// Once the hook's wait ran out, the answer goes to the agent as a message instead.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
function ask(questions: object[], env: Record<string, string> = {}) {
	const child = Bun.spawn(['uv', 'run', '--no-project', 'python', HOOK, 'hook'], {
		stdin: new TextEncoder().encode(
			JSON.stringify({ session_id: 's-ask', cwd: '/work', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions }, tool_use_id: 'toolu_1' })
		),
		stdout: 'pipe',
		env: { PATH: Bun.env.PATH ?? '', HOME: Bun.env.HOME ?? '', LAT_BOARD_ASKS_DIR: join(fixture.dir, 'board-asks'), HERDR_PANE_ID: 'wA:p-s-ask', LAT_BOARD_ASK_WAIT_SECONDS: '60', ...env }
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
/** Check Red, the first option of the first question, as a script expression. */
const CHOOSE_RED = `[...document.querySelectorAll('${card} [data-question="0"] label')].find((entry) => entry.innerText.split('\\n')[0] === 'Red').querySelector('input').click()`;

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

test('after the deadline the card says an answer goes as a message; of two browsers one sends it, the other is told someone answered', async () => {
	const stopped = ask([QUESTIONS[0]], { LAT_BOARD_ASK_WAIT_SECONDS: '1' });
	const tabs = await Promise.all([open(), open()]);
	expect(JSON.parse((await stopped).stdout).continue).toBe(false);
	for (const tab of tabs) {
		await tab.eval(`document.querySelector('[data-agent="s-ask"]').click()`);
		await tab.until(`document.querySelector('${card}[data-state="timed_out"]')`, 'the timed-out card');
		expect(await tab.eval(`document.querySelector('${card} [role="status"]').innerText`)).toBe('已逾時，作答會當訊息傳給它');
	}
	await choose(tabs[0], 0, 'Red');
	await choose(tabs[1], 0, 'Blue');
	await Promise.all(tabs.map((tab) => tab.eval(`document.querySelector('${sendButton}').click()`)));

	const calls = join(fixture.dir, 'herdr-calls.jsonl');
	const prompts = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((call) => call[1] === 'prompt') : []);
	const settled = (tab: Tab) => tab.until(`['relayed', 'taken'].includes(document.querySelector('${card}').dataset.state)`, 'the card to settle');
	await Promise.all(tabs.map(settled));
	const winner = (await tabs[0].eval(`document.querySelector('${card}').dataset.state`)) === 'relayed' ? 0 : 1;
	const loser = tabs[1 - winner];
	await loser.until(`document.querySelector('${card}').dataset.state === 'taken'`, 'the other to read 已有人作答');
	expect(await loser.eval(`document.querySelector('${card}').innerText`)).toContain('已有人作答');
	expect(await tabs[winner].eval(`document.querySelector('${card} [role="status"]').innerText`)).toBe('已傳話');
	const sent = prompts();
	expect(sent).toHaveLength(1);
	expect(sent[0][3]).toContain(`回答：${winner === 0 ? 'Red' : 'Blue'}`);
	expect(sent[0][3]).toContain('問題：Pick a color?');
}, 60_000);

test('a timed-out card stays on the page of an agent that left Herdr\'s list, and answering it there sends nothing', async () => {
	const stopped = ask([QUESTIONS[0]], { LAT_BOARD_ASK_WAIT_SECONDS: '1' });
	const tab = await open();
	await stopped;
	await tab.eval(`document.querySelector('[data-agent="s-ask"]').click()`);
	await tab.until(`document.querySelector('${card}[data-state="timed_out"]')`, 'the timed-out card');
	await choose(tab, 0, 'Red');
	// Closed in Herdr; hcom still lists it.
	const herdr = join(fixture.dir, 'herdr.json');
	const listed = readFileSync(herdr, 'utf8');
	writeFileSync(herdr, JSON.stringify({ ...JSON.parse(listed), agents: [], tabs: [] }));
	fixture.setHcom({ agents: [{ name: 'asker', session_id: 's-ask', status: 'listening' }] });
	try {
		await fixture.refresh(cookie);
		await tab.until(`document.querySelector('.detail').innerText.includes('這個 Agent 已不在 Herdr 的清單上')`, 'the page to say it left');
		expect(await tab.eval(`document.querySelector('${card}')?.dataset.state`)).toBe('timed_out');
		// Opened afresh, by its address: still there, still to be answered.
		await tab.send('Page.navigate', { url: `${fixture.url}/?agent=s-ask` });
		await tab.until(`JSON.stringify(history.state).includes('depth')`, 'the board to start again');
		await tab.until(`document.querySelector('${card}[data-state="timed_out"]')`, 'the timed-out card after a reload');
		expect(await tab.eval(`document.querySelector('.detail').innerText`)).toContain('這個 Agent 已不在 Herdr 的清單上');
		// A click before the page has taken over the card is lost: picked again until it counts.
		await tab.until(`(${CHOOSE_RED}, !document.querySelector('${sendButton}').disabled)`, 'the pick to count');
		const calls = join(fixture.dir, 'herdr-calls.jsonl');
		const before = existsSync(calls) ? readFileSync(calls, 'utf8') : '';
		await tab.eval(`document.querySelector('${sendButton}').click()`);
		await tab.until(`document.querySelector('${card}').dataset.state === 'gone'`, 'the card to read Agent 已不在');
		expect(await tab.eval(`document.querySelector('${card} [role="status"]').innerText`)).toBe('Agent 已不在，無法送出');
		expect(await tab.eval(`document.querySelectorAll('${card} button').length`)).toBe(0);
		expect(existsSync(calls) ? readFileSync(calls, 'utf8') : '').toBe(before);

		// And again once answered.
		await tab.send('Page.navigate', { url: `${fixture.url}/?agent=s-ask` });
		await tab.until(`JSON.stringify(history.state).includes('depth')`, 'the board to start again');
		await tab.until(`document.querySelector('${card}')`, 'the card after a reload');
		expect(await tab.eval(`document.querySelector('.detail').innerText`)).toContain('這個 Agent 已不在 Herdr 的清單上');
		expect(await tab.eval(`document.querySelector('${card}').dataset.state`)).toBe('gone');
	} finally {
		writeFileSync(herdr, listed);
		fixture.setHcom({ agents: [] });
		await fixture.refresh(cookie);
	}
}, 60_000);

test('a LAT controller asking through the menu is denied: no card on the board and nothing new in 待辦', async () => {
	// The real panel helper reads a registry that binds this session as a controller.
	const panel = join(fixture.dir, 'panel-config');
	mkdirSync(panel, { recursive: true });
	writeFileSync(join(panel, 'bindings.json'), JSON.stringify({ version: 2, bindings: { 's-ask': { hcom_name: 'tene', client: 'claude', session_id: 's-ask', workspace: '/work', questions_path: '/work/.lat/questions/tene.md', herdr_workspace: 'wA', herdr_tab: 'wA:t-s-ask', herdr_pane: 'wA:p-s-ask' } } }));
	const inbox = async () => JSON.stringify((await fixture.refresh(cookie)).inbox);
	const before = await inbox();
	const files = () => readdirSync(join(fixture.dir, 'board-asks')).sort();
	const filesBefore = files();

	// Earlier tests left their cards on this agent's page: the denied ask must add none.
	const tab = await open();
	await tab.eval(`document.querySelector('[data-agent="s-ask"]').click()`);
	await tab.until(`document.querySelector('.detail .profile')`, 'the agent page');
	const cards = () => tab.eval(`document.querySelectorAll('${card}').length`);
	const cardsBefore = await cards();

	const { code, stdout } = await ask(QUESTIONS, { LAT_BOARD_LAT_DIR: join(import.meta.dir, '../../../skills/local/lat'), HERDR_PLUGIN_CONFIG_DIR: panel });
	expect(code).toBe(0);
	expect(JSON.parse(stdout).hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
	expect(files()).toEqual(filesBefore);

	const after = await inbox();
	await Bun.sleep(1000);
	expect(await tab.eval(`document.querySelector('[data-agent="s-ask"]').innerText.includes('等你回答')`)).toBe(false);
	expect(await cards()).toBe(cardsBefore);
	expect(after).toBe(before);
	expect(tab.errors).toEqual([]);
}, 60_000);
