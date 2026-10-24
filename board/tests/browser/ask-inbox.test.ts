import { launchChrome, type Browser, type Tab } from '../browser.ts';
// Board asks in 待辦 in a real browser: the real hook asks into the test board's shared folder; the
// ask is one entry of 待辦 titled with its agent, kind, first question and time left; opening it
// shows the agent's page at the card; answering there (or in another browser) moves the entry to
// 已處理 with its result; a timed-out ask stays until it is answered as a message; by project it
// sits under its agent's working folder.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';

const HOOK = join(import.meta.dir, '../../hooks/board-ask.py');
const SCREEN = `({ detail: document.querySelector('.detail')?.innerText ?? '', notices: document.querySelector('.dock .toasts')?.innerText ?? '' })`;

let fixture: Fixture;
let cookie: string;
const browsers: Browser[] = [];

const QUESTION = { question: 'Pick a color?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'Choose red.' }, { label: 'Blue', description: 'Choose blue.' }] };

/** The hook as Claude runs it for the agent of session `session`. */
function ask(session: string, env: Record<string, string> = {}, question = QUESTION) {
	const child = Bun.spawn(['uv', 'run', '--no-project', 'python', HOOK, 'hook'], {
		stdin: new TextEncoder().encode(
			JSON.stringify({ session_id: session, cwd: '/ignored', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [question] }, tool_use_id: `toolu_${session}` })
		),
		stdout: 'pipe',
		env: { PATH: Bun.env.PATH ?? '', HOME: Bun.env.HOME ?? '', LAT_BOARD_ASKS_DIR: join(fixture.dir, 'board-asks'), HERDR_PANE_ID: `wA:p-${session}`, LAT_BOARD_ASK_WAIT_SECONDS: '60', ...env }
	});
	return Promise.all([child.exited, new Response(child.stdout).text()]).then(([code, stdout]) => ({ code, stdout }));
}

const agentOf = (session: string, folder: string) => ({ agent: 'claude', agent_session: { kind: 'id', value: session }, agent_status: 'blocked', cwd: folder, pane_id: `wA:p-${session}`, tab_id: `wA:t-${session}`, workspace_id: 'wA' });

beforeAll(async () => {
	fixture = await startFixture();
	cookie = await fixture.login();
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents: [agentOf('s-one', '/work/alpha'), agentOf('s-two', '/work/beta')],
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
			tabs: [
				{ tab_id: 'wA:t-s-one', workspace_id: 'wA', label: 'one' },
				{ tab_id: 'wA:t-s-two', workspace_id: 'wA', label: 'two' }
			]
		})
	);
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	for (const session of ['s-one', 's-two']) {
		writeFileSync(
			join(fixture.dir, 'transcripts', `${session}.jsonl`),
			Array.from({ length: 60 }, (_, index) => JSON.stringify({ kind: 'user', time: `2026-10-24T09:${String(index).padStart(2, '0')}:00.000Z`, text: `line ${index}` })).join('\n') + '\n'
		);
	}
	await fixture.refresh(cookie);
}, 30_000);
afterEach(async () => {
	for (const browser of browsers.splice(0)) await browser.close();
});
afterAll(async () => {
	await fixture?.cleanup();
});

/** A new Chrome on the board's 待辦 tab. */
async function open(path = '/'): Promise<Tab> {
	const browser = await launchChrome({ screen: SCREEN });
	browsers.push(browser);
	const { tab } = browser;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
	await tab.send('Page.navigate', { url: `${fixture.url}${path}` });
	await tab.until(`JSON.stringify(history.state).includes('depth')`, 'the board to start');
	return tab;
}
const row = (session: string) => `.inbox [data-ask-row]:has(.owner[title$="· ${session === 's-one' ? 'one' : 'two'}"])`;
const text = (tab: Tab, selector: string) => tab.eval<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText.replace(/\\s+/g, ' ').trim() ?? ''`);
const card = '.detail [data-ask]';
const choose = (tab: Tab, label: string) =>
	tab.eval(`[...document.querySelectorAll('${card} [data-question="0"] label')].find((entry) => entry.innerText.split('\\n')[0] === ${JSON.stringify(label)}).querySelector('input').click()`);
const processed = (tab: Tab) => tab.eval(`[...document.querySelectorAll('.inbox .toggle button')].find((button) => button.innerText.startsWith('已處理')).click()`);

test('a waiting ask is an entry of 待辦; opening it shows the agent\'s page at the card; answering there moves it to 已處理 as 已填回', async () => {
	const answered = ask('s-one');
	const tab = await open();
	await tab.until(`document.querySelector(${JSON.stringify(row('s-one'))})`, 'the ask in 待辦');
	const shown = await text(tab, row('s-one'));
	expect(shown).toContain('alpha · one');
	expect(shown).toContain('提問');
	expect(shown).toContain('Pick a color?');
	expect(shown).toMatch(/剩 [01]:\d\d/);

	await tab.eval(`document.querySelector(${JSON.stringify(row('s-one'))} + ' .main').click()`);
	await tab.until(`document.querySelector('${card}[data-state="waiting"]')`, 'the card');
	expect(await tab.eval<string>(`location.search`)).toContain('agent=s-one');
	// Scrolled to: the card is in view.
	await tab.until(`(() => { const box = document.querySelector('${card}').getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; })()`, 'the card in view');

	await choose(tab, 'Blue');
	await tab.eval(`document.querySelector('${card} form button').click()`);
	expect(JSON.parse((await answered).stdout).hookSpecificOutput.updatedInput.answers).toEqual({ 'Pick a color?': 'Blue' });
	await tab.until(`!document.querySelector(${JSON.stringify(row('s-one'))})`, 'the entry to leave 待辦');
	await processed(tab);
	await tab.until(`document.querySelector(${JSON.stringify(row('s-one'))})`, 'the entry among the processed');
	expect(await text(tab, row('s-one'))).toContain('已填回');
	expect(tab.errors).toEqual([]);
}, 60_000);

test('an answer in another browser changes the entry here too', async () => {
	const answered = ask('s-one');
	const mine = await open();
	const theirs = await open('/?agent=s-one');
	await mine.until(`document.querySelector(${JSON.stringify(row('s-one'))})`, 'the ask in 待辦');
	await theirs.until(`document.querySelector('${card}[data-state="waiting"]')`, 'the card');
	await choose(theirs, 'Red');
	await theirs.eval(`document.querySelector('${card} form button').click()`);
	await answered;
	await mine.until(`!document.querySelector(${JSON.stringify(row('s-one'))})`, 'the entry to leave 待辦 on the other browser');
}, 60_000);

test('a timed-out ask stays in 待辦; answering sends a message and moves it to 已處理 as 已傳話', async () => {
	await ask('s-two', { LAT_BOARD_ASK_WAIT_SECONDS: '1' });
	const tab = await open();
	await tab.until(`document.querySelector(${JSON.stringify(row('s-two'))})`, 'the timed-out ask in 待辦');
	expect(await text(tab, row('s-two'))).toContain('已逾時，作答會當訊息傳給它');

	// By project: under the project of the agent's folder.
	await tab.eval(`[...document.querySelectorAll('.inbox .toggle button')].find((button) => button.innerText === '依專案').click()`);
	await tab.until(`[...document.querySelectorAll('.inbox h3')].some((heading) => heading.innerText === 'beta')`, 'the project heading');
	expect(await tab.eval<string[]>(`[...document.querySelectorAll('.inbox h3')].map((heading) => heading.innerText)`)).toContain('beta');
	expect(await tab.eval<boolean>(`(() => { const heading = [...document.querySelectorAll('.inbox h3')].find((entry) => entry.innerText === 'beta'); let next = heading.nextElementSibling; while (next && next.tagName !== 'H3') { if (next.querySelector('[data-ask-row]') || next.matches('[data-ask-row]')) return true; next = next.nextElementSibling; } return false; })()`)).toBe(true);

	await tab.eval(`[...document.querySelectorAll('.inbox .toggle button')].find((button) => button.innerText === '依時間').click()`);
	await tab.until(`document.querySelector(${JSON.stringify(row('s-two'))})`, 'the time order again');
	await tab.eval(`document.querySelector(${JSON.stringify(row('s-two'))} + ' .main').click()`);
	await tab.until(`document.querySelector('${card}[data-state="timed_out"]')`, 'the timed-out card');
	await choose(tab, 'Red');
	await tab.eval(`document.querySelector('${card} form button').click()`);
	await tab.until(`document.querySelector('${card}').dataset.state === 'relayed'`, 'the card to read 已傳話');
	const calls = join(fixture.dir, 'herdr-calls.jsonl');
	expect(existsSync(calls) && readFileSync(calls, 'utf8')).toContain('回答：Red');
	await tab.until(`!document.querySelector(${JSON.stringify(row('s-two'))})`, 'the entry to leave 待辦');
	await processed(tab);
	await tab.until(`document.querySelector(${JSON.stringify(row('s-two'))})`, 'the entry among the processed');
	expect(await text(tab, row('s-two'))).toContain('已傳話');
	expect(tab.errors).toEqual([]);
}, 60_000);

test('opening an older ask from 待辦 leaves the operation record, and scrolls to its card below newer ones', async () => {
	await ask('s-one', { LAT_BOARD_ASK_WAIT_SECONDS: '1' }, { ...QUESTION, question: 'Older question?' });
	await ask('s-one', { LAT_BOARD_ASK_WAIT_SECONDS: '1' }, { ...QUESTION, question: 'Newer question?' });
	const tab = await open('/?agent=s-one');
	await tab.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 420, deviceScaleFactor: 1, mobile: false });
	await tab.eval(`document.querySelector('.detail [data-tab="log"]').click()`);
	await tab.until(`document.querySelector('#agent-panel-transcript').hidden`, 'the operation record');
	const older = `.inbox [data-ask-row]:has(.title)`;
	await tab.eval(`document.querySelector('[data-middle="inbox"]').click()`);
	const olderRow = `[...document.querySelectorAll('${older}')].find((entry) => entry.innerText.includes('Older question?'))`;
	await tab.until(olderRow, 'the older ask in 待辦');
	await tab.eval(`${olderRow}.querySelector('.main').click()`);
	const olderCard = `.detail [data-ask]:has(h2)`;
	await tab.until(`!document.querySelector('#agent-panel-transcript').hidden`, 'the conversation to be shown again');
	await tab.until(
		`(() => { const cards = [...document.querySelectorAll('${olderCard}')].filter((entry) => entry.innerText.includes('Older question?')); const box = cards[0]?.getBoundingClientRect(); return !!box && box.top >= 0 && box.bottom <= innerHeight; })()`,
		'the older card in view'
	);
	expect(tab.errors).toEqual([]);
}, 60_000);
