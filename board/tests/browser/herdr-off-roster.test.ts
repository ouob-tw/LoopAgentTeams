// A controller still bound whose client is closed and whose reports are all archived, in a real
// browser: headless Chrome driven over its DevTools protocol, on the built board with fake hcom,
// Herdr, helper and input command, wide and at a phone's width. It is off the roster, so the To-do
// tab does not list it, but on the Herdr tab its card opens the controller's page and the command
// line wakes it, resuming its conversation; gone from Herdr, its row of the 已關閉 section is a
// controller's, woken with the wake's options. Skipped when the host has no Chrome.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { SentEntry } from '../../src/lib/board/answers.ts';
import type { BoardSnapshot } from '../../src/lib/board/types.ts';
import { jsonLines, NODE, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser, type Tab } from '../browser.ts';



const SCREEN = `({ search: location.search, detail: document.querySelector('.detail')?.innerText ?? '', notices: document.querySelector('.dock')?.innerText ?? '' })`;
/** The tab strip's labels, without their counts. */
const TABS = `[...document.querySelectorAll('.detail [role="tablist"] [role="tab"]')].map((b) => b.innerText.replace(/\\s*\\d+$/, '').trim())`;
const FITS = `document.documentElement.scrollWidth <= window.innerWidth`;
const BOX = '.dock .cmd textarea';
const SEND = '.dock .cmd .send-slot button:not([data-action="interrupt"])';
const OPTIONS = '.dock .cmd button.options';
const POPUP = '.dock .popup[aria-label="喚醒選項"]';
const CARD = `document.querySelector('.inbox button.agent[data-agent="s-old"]')`;
/** Click the first button in `scope` whose text includes `text`. */
const click = (scope: string, text: string) =>
	`[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => b.innerText.includes(${JSON.stringify(text)})).click()`;
const pageOf = (header: string) => `document.querySelector('.detail .profile h2')?.innerText === ${JSON.stringify(header)}`;

const DAY_MS = 24 * 60 * 60_000;

const injectDir = mkdtempSync(join(tmpdir(), 'lat-board-inject-'));
let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;
let old: ReturnType<Fixture['bound']>;
/** Like `old`, but Herdr no longer lists them: in the 已關閉 section, one for each width. */
const GONE = ['s-gone-1280', 's-gone-390'];

function herdrAgent(session: string, cwd: string) {
	return {
		agent: 'claude',
		agent_session: { kind: 'id', value: session },
		agent_status: 'idle',
		cwd,
		pane_id: `wA:p-${session}`,
		tab_id: `wA:t-${session}`,
		workspace_id: 'wA'
	};
}
const lines = jsonLines;
const injects = (): string[][] => lines(join(injectDir, 'inject-calls.jsonl'));
const resumes = (): string[][] => lines(join(fixture.dir, 'hcom-calls.jsonl')).map((call: { args: string[] }) => call.args).filter((args) => args[0] === 'r');
async function sentLog(controllerId: string): Promise<SentEntry[]> {
	return (await (await fixture.fetch(`/api/messages?controller=${encodeURIComponent(controllerId)}`, { cookie })).json()).entries;
}
async function agentLog(agentId: string): Promise<unknown[]> {
	return (await (await fixture.fetch(`/api/agents/log?session=${encodeURIComponent(agentId)}`, { cookie })).json()).entries;
}

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture({
		env: {
			LAT_BOARD_INJECT_COMMAND: JSON.stringify([NODE, join(import.meta.dir, '../fake-inject.mjs'), injectDir]),
			LAT_BOARD_HCOM_TIMEOUT_SECONDS: '1'
		}
	});
	cookie = await fixture.login('herdr-off-roster');
	old = fixture.bound('qa', 'old', { session_id: 's-old' });
	const gone = GONE.map((session) => fixture.bound(session, session.replace('s-', ''), { session_id: session }));
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	for (const controller of [old, ...gone]) {
		const session = controller.session_id;
		// Its only report is over 7 days old, so archived.
		const time = new Date(Date.now() - 8 * DAY_MS).toISOString();
		fixture.report(session, { tag: 'DONE', summary: '早就收工', message: '早就收工了。', time, hcom_name: controller.hcom_name, workspace: controller.workspace });
		const said = [{ kind: 'user', text: '請開始。' }, { kind: 'assistant', text: '早就收工了。' }];
		writeFileSync(join(fixture.dir, 'transcripts', `${session}.jsonl`), said.map((line) => JSON.stringify({ ...line, time }) + '\n').join(''));
	}
	fixture.list([old, ...gone]);
	// Bound, but hcom no longer lists them: closed. `old` keeps its pane in Herdr; the others are
	// seen there once, then their panes close.
	fixture.setHcom({ agents: [] });
	const setHerdr = (agents: ReturnType<typeof herdrAgent>[]) =>
		writeFileSync(
			join(fixture.dir, 'herdr.json'),
			JSON.stringify({
				agents,
				panes: agents.map((agent) => ({ pane_id: agent.pane_id, workspace_id: agent.workspace_id, cwd: agent.cwd })),
				workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
				tabs: agents.map((agent) => ({ tab_id: agent.tab_id, workspace_id: agent.workspace_id, label: `分頁-${agent.agent_session.value}` }))
			})
		);
	setHerdr([old, ...gone].map((controller) => herdrAgent(controller.session_id, controller.workspace)));
	await fixture.refresh(cookie);
	setHerdr([herdrAgent('s-old', old.workspace)]);
	for (const [index, controller] of gone.entries()) {
		const event = {
			data: { action: 'stopped', by: 'pty', reason: 'killed', snapshot: { name: controller.hcom_name, session_id: controller.session_id, tool: 'claude', directory: controller.workspace } },
			id: index + 1,
			instance: controller.hcom_name,
			ts: new Date(Date.now() - 60_000).toISOString(),
			type: 'life'
		};
		appendFileSync(join(fixture.dir, 'hcom-events.jsonl'), JSON.stringify(event) + '\n');
	}
	await fixture.refresh(cookie);
}, 30_000);

beforeEach(() => {
	if (!CHROME) return;
	for (const file of ['inject-calls.jsonl', 'inject-typed.jsonl']) rmSync(join(injectDir, file), { force: true });
	rmSync(join(fixture.dir, 'hcom-calls.jsonl'), { force: true });
});
afterEach(async () => {
	await browser?.close();
});
afterAll(async () => {
	await fixture?.cleanup();
	rmSync(injectDir, { recursive: true, force: true });
});

/** A new Chrome, logged in, on the board in a window `width` wide. */
async function visit(width: number) {
	browser = await launchChrome({ screen: SCREEN });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width < 761 });
	await tab.send('Page.navigate', { url: `${fixture.url}/` });
	await tab.until(`JSON.stringify(history.state).includes('depth')`, 'the board to start');
}
const type = (text: string) =>
	tab.eval(`(() => {
		const box = document.querySelector(${JSON.stringify(BOX)});
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(text)});
		box.dispatchEvent(new Event('input', { bubbles: true }));
	})()`);

test.skipIf(!CHROME)('it is off the roster and its report stays archived, but a controller on the Herdr tab', async () => {
	const snapshot: BoardSnapshot = await fixture.board(cookie);
	expect(snapshot.controllers).toEqual([]);
	expect(snapshot.offRoster.map((controller) => [controller.id, controller.status]).sort()).toEqual([['s-gone-1280', 'closed'], ['s-gone-390', 'closed'], ['s-old', 'closed']]);
	expect(snapshot.inbox).toEqual([]);
	expect(snapshot.agents.map((agent) => [agent.id, agent.controller])).toEqual([['s-old', true]]);
	expect(snapshot.closed.agents.map((agent) => [agent.id, agent.controller]).sort()).toEqual([['s-gone-1280', true], ['s-gone-390', true]]);
});

for (const width of [1280, 390]) {
	test.skipIf(!CHROME)(`${width}px: its card opens the controller's page, whose command line wakes it; the To-do tab still does not list it`, async () => {
		const text = `醒來 ${width}`;
		await visit(width);
		// The To-do tab: no controller on its roster, nothing in its list.
		expect(await tab.eval(`!!document.querySelector('[data-controller="old"]')`)).toBe(false);
		expect(await tab.eval(`document.querySelector('.unfolded .roster, .unfolded')?.innerText.includes('qa') ?? false`)).toBe(false);
		await tab.eval(`document.querySelector('[data-middle="agents"]').click()`);
		await tab.until(`!!${CARD}`, 'its card');
		expect(await tab.eval<string>(`${CARD}.innerText`)).toContain('主控');
		await tab.eval(`${CARD}.click()`);
		await tab.until(`${pageOf('qa')} && document.querySelector(${JSON.stringify(SEND)})?.innerText.trim() === '喚醒'`, "the controller's page");
		expect(new URLSearchParams(await tab.eval<string>('location.search')).get('agent')).toBe('s-old');
		expect(await tab.eval(TABS)).toEqual(['對話紀錄', '回報', '送出紀錄', '操作紀錄']);
		expect(await tab.eval<string>(`document.querySelector('.detail .profile').innerText`)).toContain('已關閉');
		if (width > 760) expect(await tab.eval(`document.querySelector('.dock .to').innerText`)).toBe('→ @old');
		// The wake's options, as on any closed controller's page; addressed by its name too.
		await type(`@old ${text}`);
		await tab.eval(`document.querySelector(${JSON.stringify(OPTIONS)}).click()`);
		await tab.until(`!!document.querySelector(${JSON.stringify(POPUP)})`, 'the wake options');
		expect(await tab.eval<string>(`document.querySelector(${JSON.stringify(POPUP)}).innerText`)).toContain('開新一輪 LAT');
		expect(await tab.eval(FITS)).toBe(true);
		await tab.eval(`document.querySelector(${JSON.stringify(SEND)}).click()`);
		await tab.until(`document.querySelector(${JSON.stringify(BOX)}).value === ''`, 'the box emptied');
		// Resumed by its session ID; nothing typed, nothing sent as an agent.
		expect(resumes()).toEqual([['r', 's-old', '--terminal', 'herdr', '--no-run-here', '--go', '--hcom-prompt', text]]);
		expect(injects()).toEqual([]);
		expect(await agentLog('s-old')).toEqual([]);
		const wake = (await sentLog('s-old')).find((entry) => 'text' in entry && entry.text === text);
		expect(wake).toMatchObject({ kind: 'wake', route: 'resume' });
		await tab.eval(click('.detail [role="tablist"]', '送出紀錄'));
		await tab.until(`document.querySelector('#panel-sent:not([hidden])')?.innerText.includes(${JSON.stringify(text)})`, 'the wake in the sent log');
		// Back on the To-do tab, it is still not listed and its report not brought back.
		if (await tab.eval(`!!document.querySelector('.topbar')`)) {
			await tab.eval(`document.querySelector('.topbar button').click()`);
			await tab.until(`!document.querySelector('.topbar')`, 'the list again');
		}
		await tab.eval(`document.querySelector('[data-middle="inbox"]').click()`);
		await tab.until(`document.querySelector('[data-middle="inbox"]').getAttribute('aria-pressed') === 'true'`, 'the To-do tab');
		expect(await tab.eval(`!!document.querySelector('[data-controller="old"]')`)).toBe(false);
		expect(await tab.eval<string>(`document.querySelector('.inbox').innerText`)).not.toContain('早就收工');
		const after: BoardSnapshot = await fixture.board(cookie);
		expect(after.controllers).toEqual([]);
		expect(after.inbox).toEqual([]);
		// The attempt stays open until the resumed client shows; given up for the next test.
		await fixture.fetch('/api/wake/abandon', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ controllerId: 's-old', wakeId: wake!.id }),
			cookie
		});
	}, 60_000);
}

for (const width of [1280, 390]) {
	test.skipIf(!CHROME)(`${width}px: gone from Herdr, its row of the 已關閉 section opens a controller's page, woken with the wake's options`, async () => {
		const session = `s-gone-${width}`;
		const ROW = `[data-closed="${session}"]`;
		const WAKE = `[data-wake="${session}"]`;
		const text = `接回 ${width}`;
		await visit(width);
		await tab.eval(`document.querySelector('[data-middle="agents"]').click()`);
		await tab.until(`!!document.querySelector('.inbox .closed .trigger')`, 'the 已關閉 section');
		await tab.eval(`document.querySelector('.inbox .closed .trigger').click()`);
		await tab.until(`!!document.querySelector('${ROW}')`, 'its row');
		expect(await tab.eval(`document.querySelector('${ROW} .tag')?.innerText`)).toBe('主控');
		// Its 接回 is on its page, opened from the row.
		await tab.eval(`document.querySelector('${ROW}').click()`);
		await tab.until(`!!document.querySelector('.detail [data-closed-agent="${session}"]')`, 'its page');
		await tab.eval(`document.querySelector('.detail [data-action="resume"]').click()`);
		await tab.until(`(document.querySelector('${WAKE}')?.innerText ?? '').includes('開新一輪 LAT')`, "the wake's options");
		expect(await tab.eval(`document.querySelectorAll('${WAKE} .pills button').length`)).toBeGreaterThan(0);
		expect(await tab.eval(FITS)).toBe(true);
		await tab.eval(`(() => { const box = document.querySelector('${WAKE} textarea'); box.value = ${JSON.stringify(text)}; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
		await tab.eval(`document.querySelector('${WAKE} [data-action="wake"]').click()`);
		await tab.until(`document.querySelector('.dock .toasts')?.innerText.includes('已開始接回 @${width}')`, 'the notice');
		// A controller wake: resumed with its text, in its sent log, not as an agent.
		expect(resumes()).toEqual([['r', session, '--terminal', 'herdr', '--no-run-here', '--go', '--hcom-prompt', text]]);
		const wake = (await sentLog(session)).find((entry) => 'text' in entry && entry.text === text);
		expect(wake).toMatchObject({ kind: 'wake', route: 'resume' });
		expect((await fixture.board(cookie)).controllers).toEqual([]);
	}, 60_000);
}
