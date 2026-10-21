// Writing to a controller from its page on the Herdr tab, in a real browser: headless Chrome driven
// over its DevTools protocol, on the built board with fake hcom, Herdr, helper and input command,
// wide and at a phone's width. A running controller gets the text typed into its input box and a
// closed or ended one is woken, with the wake's options, as from its information page; both show
// in its sent log. An ordinary agent is still written to as an agent. The controllers share one
// draft; what was typed to a controller as an agent before is moved into it once. Skipped when the
// host has no Chrome.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { SentEntry } from '../src/lib/board/answers.ts';
import { AGENT_DRAFTS_KEY, COMMAND_DRAFT_KEY } from '../src/lib/board/prefs.ts';
import { jsonLines, NODE, question, sleep, startFixture, type Fixture } from './harness.ts';
import { CHROME, launchChrome, type Browser, type Tab } from './browser.ts';



const SCREEN = `({ search: location.search, detail: document.querySelector('.detail')?.innerText ?? '', notices: document.querySelector('.dock')?.innerText ?? '' })`;
const FITS = `document.documentElement.scrollWidth <= window.innerWidth`;
const BOX = '.dock .cmd textarea';
const SEND = '.dock .cmd .send-slot button';
const OPTIONS = '.dock .cmd button.options';
const POPUP = '.dock .popup[aria-label="喚醒選項"]';
const STOP = '.dock [data-action="interrupt"]';
const CONFIRM_STOP = '.dock [data-action="confirm-interrupt"]';
/** Click the first button in `scope` whose text includes `text`. */
const click = (scope: string, text: string) =>
	`[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => b.innerText.includes(${JSON.stringify(text)})).click()`;
const pageOf = (header: string) => `document.querySelector('.detail .profile h2')?.innerText === ${JSON.stringify(header)}`;

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
/** When luna's report was issued, fixed once for the setup and the assertions on it. */
const LUNA_REPORTED_AT = minutesAgo(15);

const injectDir = mkdtempSync(join(tmpdir(), 'lat-board-inject-'));
let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;
let lead: ReturnType<Fixture['bound']>;
let gone: ReturnType<Fixture['bound']>;

function herdrAgent(session: string, cwd = `/home/someone/projects/${session}`) {
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
function setHerdr(extra: object = {}, more: string[] = []) {
	const agents = [herdrAgent('s-lead'), herdrAgent('s-gone', gone.workspace), herdrAgent('s-luna'), herdrAgent('s-plain'), ...more.map((session) => herdrAgent(session))];
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents,
			panes: agents.map((agent) => ({ pane_id: agent.pane_id, workspace_id: agent.workspace_id, cwd: agent.cwd })),
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
			tabs: agents.map((agent) => ({ tab_id: agent.tab_id, workspace_id: agent.workspace_id, label: `分頁-${agent.agent_session.value}` })),
			...extra
		})
	);
}
const hcomAgent = (name: string, session: string, status = 'listening') => ({ name, session_id: session, status, launch_context: { pane_id: `wA:p-${session}` } });
// `gone` is bound but hcom no longer lists it: closed, its pane still in Herdr. `lead` is in a turn.
const HCOM_AGENTS = [hcomAgent('lead', 's-lead', 'active'), hcomAgent('luna', 's-luna'), hcomAgent('plain', 's-plain')];
function record(session: string, said: { kind: 'user' | 'assistant'; minutes: number; text: string }[]) {
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', `${session}.jsonl`), said.map(({ kind, minutes, text }) => JSON.stringify({ kind, time: minutesAgo(minutes), text }) + '\n').join(''));
}
const lines = jsonLines;
const injects = (): string[][] => lines(join(injectDir, 'inject-calls.jsonl'));
/** The Herdr commands that act on an agent, not the lists every read makes. */
const herdrCalls = (): string[][] => lines(join(fixture.dir, 'herdr-calls.jsonl'));
const resumes = (): string[][] => lines(join(fixture.dir, 'hcom-calls.jsonl')).map((call: { args: string[] }) => call.args).filter((args) => args[0] === 'r');
async function sentLog(controllerId: string): Promise<SentEntry[]> {
	return (await (await fixture.fetch(`/api/messages?controller=${encodeURIComponent(controllerId)}`, { cookie })).json()).entries;
}
/** A message or wake of the sent log that carried `text`. */
const said = (entry: SentEntry, text: string) => 'text' in entry && entry.text === text;
async function agentLog(agentId: string): Promise<unknown[]> {
	return (await (await fixture.fetch(`/api/agents/log?session=${encodeURIComponent(agentId)}`, { cookie })).json()).entries;
}

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture({
		env: {
			LAT_BOARD_INJECT_COMMAND: JSON.stringify([NODE, join(import.meta.dir, 'fake-inject.mjs'), injectDir]),
			LAT_BOARD_HCOM_TIMEOUT_SECONDS: '1',
			LAT_BOARD_HERDR_TIMEOUT_SECONDS: '2'
		}
	});
	cookie = await fixture.login('herdr-controller-send');
	lead = fixture.bound('lat', 'lead', { session_id: 's-lead' });
	gone = fixture.bound('dusk', 'gone', { session_id: 's-gone' });
	record('s-lead', [{ kind: 'user', minutes: 10, text: '請開始。' }]);
	// A closed controller stays on the roster while a report of it is not yet archived.
	fixture.report('s-gone', { tag: 'DONE', summary: '收工', message: '先收工。', time: minutesAgo(25), hcom_name: 'gone', workspace: gone.workspace });
	record('s-gone', [
		{ kind: 'user', minutes: 30, text: '先做到這裡。' },
		{ kind: 'assistant', minutes: 25, text: '先收工。' }
	]);
	// Ended in LAT, its client still running in its pane.
	fixture.report('s-luna', { tag: 'DONE', summary: '交付', message: '月亮的交付。', time: LUNA_REPORTED_AT, hcom_name: 'luna', workspace: join(fixture.dir, 'workspaces', 'moon') });
	record('s-luna', [{ kind: 'assistant', minutes: 15, text: '月亮的交付。' }]);
	record('s-plain', [{ kind: 'user', minutes: 5, text: '幫我看一下測試' }]);
	fixture.list([lead, gone]);
	fixture.setHcom({ agents: HCOM_AGENTS });
	setHerdr();
	await fixture.refresh(cookie);
}, 30_000);

beforeEach(() => {
	if (!CHROME) return;
	for (const file of ['inject-calls.jsonl', 'inject-typed.jsonl']) rmSync(join(injectDir, file), { force: true });
	for (const file of ['hcom-calls.jsonl', 'herdr-calls.jsonl']) rmSync(join(fixture.dir, file), { force: true });
});
afterEach(async () => {
	await browser?.close();
});
afterAll(async () => {
	await fixture?.cleanup();
	rmSync(injectDir, { recursive: true, force: true });
});

/** A new Chrome, logged in, on the board at `search` in a window `width` wide; `stored` is put in
 *  the page's storage before the board starts. */
async function visit(width: number, search = '', stored: Record<string, string> = {}) {
	browser = await launchChrome({ screen: SCREEN });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width < 761 });
	if (Object.keys(stored).length) {
		await tab.navigate(`${fixture.url}/login`);
		await tab.eval(`(() => { for (const [key, value] of Object.entries(${JSON.stringify(stored)})) localStorage.setItem(key, value); })()`);
	}
	await tab.send('Page.navigate', { url: `${fixture.url}/${search}` });
	await started();
}
/** The board's first history write is done, so its buttons work. */
const started = () => tab.until(`JSON.stringify(history.state).includes('depth')`, 'the board to start');
const type = (text: string) =>
	tab.eval(`(() => {
		const box = document.querySelector(${JSON.stringify(BOX)});
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(text)});
		box.dispatchEvent(new Event('input', { bubbles: true }));
	})()`);
const boxText = () => tab.eval<string>(`document.querySelector(${JSON.stringify(BOX)}).value`);
const stored = (key: string) => tab.eval<string | null>(`localStorage.getItem(${JSON.stringify(key)})`);
async function until(check: () => Promise<boolean>, what: string) {
	const deadline = Date.now() + 10_000;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(50);
	}
}

for (const width of [1280, 390]) {
	test.skipIf(!CHROME)(`${width}px: a running controller gets the text typed into its input box, in its sent log, not as an agent`, async () => {
		const text = `跑著的主控 ${width}`;
		await visit(width, '?agent=s-lead');
		await tab.until(`${pageOf('lat')} && !!document.querySelector(${JSON.stringify(BOX)})`, "the controller's page");
		await type(text);
		if (width > 760) expect(await tab.eval(`document.querySelector('.dock .to').innerText`)).toBe('→ @lead');
		expect(await tab.eval(`document.querySelector(${JSON.stringify(SEND)}).getAttribute('aria-label')`)).toBe('送出');
		// No interrupt and no agent's model picker: the line is the controller's.
		expect(await tab.eval(`!!document.querySelector('.dock [data-action="interrupt"], .dock .pill-slot [data-pick]')`)).toBe(false);
		await tab.eval(`document.querySelector(${JSON.stringify(SEND)}).click()`);
		await tab.until(`document.querySelector(${JSON.stringify(BOX)}).value === ''`, 'the box emptied');
		expect(injects()).toEqual([['lead', text, '--enter']]);
		expect((await sentLog('s-lead')).find((entry) => said(entry, text))).toMatchObject({ kind: 'message', ok: true });
		expect(await agentLog('s-lead')).toEqual([]);
		// Its sent log on this page has it.
		await tab.eval(click('.detail [role="tablist"]', '送出紀錄'));
		await tab.until(`document.querySelector('#panel-sent:not([hidden])')?.innerText.includes(${JSON.stringify(text)})`, 'the sent log');
		expect(await tab.eval(FITS)).toBe(true);
	}, 60_000);

}

// Wide on its information page, a phone on the Herdr tab.
for (const [width, search] of [
	[1280, '?controller=s-lead'],
	[390, '?agent=s-lead']
] as const) {
	test.skipIf(!CHROME)(`${width}px: a controller at work is interrupted after a confirmation, named in the notice and in its sent log`, async () => {
		await visit(width, search);
		// Nothing typed: the send button is a stop.
		await tab.until(`${pageOf('lat')} && !!document.querySelector(${JSON.stringify(STOP)})`, 'the stop');
		await type('先別停');
		expect(await tab.eval(`!!document.querySelector(${JSON.stringify(STOP)})`)).toBe(false);
		expect(await tab.eval(`document.querySelector(${JSON.stringify(SEND)}).getAttribute('aria-label')`)).toBe('送出');
		await type('');
		await tab.until(`!!document.querySelector(${JSON.stringify(STOP)})`, 'the stop again');
		await tab.eval(`document.querySelector(${JSON.stringify(STOP)}).click()`);
		await tab.until(`!!document.querySelector(${JSON.stringify(CONFIRM_STOP)})`, 'the confirmation');
		const popup = await tab.eval<string>(`document.querySelector('.dock .popup').innerText`);
		expect(popup).toContain('主控');
		expect(popup).toContain('Esc');
		// Nothing is pressed before it is confirmed.
		expect(herdrCalls()).toEqual([]);
		expect(await tab.eval(FITS)).toBe(true);
		await tab.eval(`document.querySelector(${JSON.stringify(CONFIRM_STOP)}).click()`);
		await tab.until(`document.querySelector('.dock')?.innerText.includes('已對 @lead 送出 Esc')`, 'the interrupt notice');
		expect(herdrCalls()).toEqual([['agent', 'send-keys', 'wA:p-s-lead', 'esc']]);
		expect(injects()).toEqual([]);
		await tab.eval(click('.detail [role="tablist"]', '送出紀錄'));
		await tab.until(`document.querySelector('#panel-sent:not([hidden]) li[data-kind="agent-action"]')?.innerText.includes('已送出 Esc')`, 'the sent log');
		expect(await tab.eval(FITS)).toBe(true);
	}, 60_000);
}

test.skipIf(!CHROME)('a controller not at work keeps its wake button, with no interrupt', async () => {
	for (const [search, header] of [
		['?controller=s-luna', 'moon'],
		['?controller=s-gone', 'dusk']
	]) {
		await visit(1280, search);
		await tab.until(`${pageOf(header)} && document.querySelector(${JSON.stringify(SEND)})?.innerText.trim() === '喚醒'`, `${header}'s page`);
		expect(await tab.eval(`!!document.querySelector(${JSON.stringify(STOP)})`)).toBe(false);
		await browser?.close();
	}
}, 60_000);

test.skipIf(!CHROME)('an interrupt Herdr does not carry out says why, is not tried again, and is in the sent log as failed', async () => {
	const stderr = JSON.stringify({ error: { code: 'pane_not_found', message: 'pane went away' } });
	setHerdr({ fail: { 'agent send-keys': { exit: 1, stderr } } });
	try {
		await visit(1280, '?controller=s-lead');
		await tab.until(`${pageOf('lat')} && !!document.querySelector(${JSON.stringify(STOP)})`, 'the stop');
		await tab.eval(`document.querySelector(${JSON.stringify(STOP)}).click()`);
		await tab.until(`!!document.querySelector(${JSON.stringify(CONFIRM_STOP)})`, 'the confirmation');
		await tab.eval(`document.querySelector(${JSON.stringify(CONFIRM_STOP)}).click()`);
		await tab.until(`document.querySelector('.dock')?.innerText.includes('Herdr 沒有送出 Esc：pane went away')`, 'the reason');
		expect(await tab.eval<string>(`document.querySelector('.dock').innerText`)).not.toContain('已對');
		await sleep(500);
		expect(herdrCalls()).toEqual([['agent', 'send-keys', 'wA:p-s-lead', 'esc']]);
		await tab.eval(click('.detail [role="tablist"]', '送出紀錄'));
		await tab.until(`document.querySelector('#panel-sent:not([hidden]) li[data-kind="agent-action"]')?.innerText.includes('✗ Herdr 沒有送出 Esc：pane went away')`, 'the failed row');
		// The stop is there to press again.
		expect(await tab.eval(`document.querySelector(${JSON.stringify(STOP)}).disabled`)).toBe(false);
	} finally {
		setHerdr();
		await fixture.refresh(cookie);
	}
}, 60_000);

test.skipIf(!CHROME)('an interrupt whose Herdr command times out says so, is tried once, and is in the sent log as failed', async () => {
	setHerdr({ slowMs: { 'agent send-keys': 4_000 } });
	try {
		await visit(1280, '?controller=s-lead');
		await tab.until(`${pageOf('lat')} && !!document.querySelector(${JSON.stringify(STOP)})`, 'the stop');
		await tab.eval(`document.querySelector(${JSON.stringify(STOP)}).click()`);
		await tab.until(`!!document.querySelector(${JSON.stringify(CONFIRM_STOP)})`, 'the confirmation');
		await tab.eval(`document.querySelector(${JSON.stringify(CONFIRM_STOP)}).click()`);
		await tab.until(`document.querySelector('.dock')?.innerText.includes('Herdr 的按鍵指令逾時（2 秒），不確定有沒有中斷。')`, 'the reason');
		expect(await tab.eval<string>(`document.querySelector('.dock').innerText`)).not.toContain('已對');
		// Past the slow command's own end: still the one attempt.
		await sleep(3_000);
		expect(herdrCalls()).toEqual([['agent', 'send-keys', 'wA:p-s-lead', 'esc']]);
		await tab.eval(click('.detail [role="tablist"]', '送出紀錄'));
		await tab.until(
			`document.querySelector('#panel-sent:not([hidden]) li[data-kind="agent-action"]')?.innerText.includes('✗ Herdr 的按鍵指令逾時（2 秒）')`,
			'the failed row'
		);
	} finally {
		setHerdr();
		await fixture.refresh(cookie);
	}
}, 60_000);

test.skipIf(!CHROME)('only blank space typed keeps the stop; a line naming a controller is sent or wakes instead', async () => {
	await visit(1280, '?controller=s-lead');
	await tab.until(`${pageOf('lat')} && !!document.querySelector(${JSON.stringify(STOP)})`, 'the stop');
	await type('  \n ');
	await sleep(200);
	expect(await tab.eval(`!!document.querySelector(${JSON.stringify(STOP)})`)).toBe(true);
	for (const [line, label] of [
		['@lead 先別停', ''],
		['@luna 醒醒', '喚醒']
	]) {
		await type(line);
		await tab.until(`document.querySelector(${JSON.stringify(SEND)})?.innerText.trim() === ${JSON.stringify(label)}`, `the ${label} button`);
		expect(await tab.eval(`!!document.querySelector(${JSON.stringify(STOP)})`)).toBe(false);
	}
	expect(herdrCalls()).toEqual([]);
}, 60_000);

test.skipIf(!CHROME)('the confirmation is cancelled without a key pressed, and closes when the controller changes or its turn ends', async () => {
	const sun = fixture.bound('sun', 'sun', { session_id: 's-sun' });
	const sunTurn = async (status: string) => {
		fixture.setHcom({ agents: [...HCOM_AGENTS, hcomAgent('sun', 's-sun', status)] });
		await fixture.refresh(cookie);
	};
	fixture.list([lead, gone, sun]);
	setHerdr({}, ['s-sun']);
	await sunTurn('active');
	const open = async () => {
		await tab.until(`!!document.querySelector(${JSON.stringify(STOP)})`, 'the stop');
		await tab.eval(`document.querySelector(${JSON.stringify(STOP)}).click()`);
		await tab.until(`!!document.querySelector(${JSON.stringify(CONFIRM_STOP)})`, 'the confirmation');
	};
	const confirmShown = () => tab.eval<boolean>(`!!document.querySelector(${JSON.stringify(CONFIRM_STOP)})`);
	try {
		await visit(1280, '?controller=s-lead');
		await tab.until(pageOf('lat'), "lead's page");
		await open();
		await tab.eval(click('.dock .popup', '取消'));
		await tab.until(`!document.querySelector('.dock .popup')`, 'the confirmation closed');
		expect(await tab.eval(`!!document.querySelector(${JSON.stringify(STOP)})`)).toBe(true);

		// Another controller opened: closed, and not shown for it.
		await open();
		await tab.eval(`document.querySelector('.unfolded button.person[data-controller="sun"]').click()`);
		await tab.until(`${pageOf('sun')} && !!document.querySelector(${JSON.stringify(STOP)})`, "sun's page");
		expect(await confirmShown()).toBe(false);

		// A question waiting on the user does not end its turn: the stop and the confirmation stay.
		await open();
		fixture.list([lead, gone, { ...sun, questions: [question()] }]);
		await fixture.refresh(cookie);
		await tab.until(`document.querySelector('.detail .status')?.innerText.includes('等你')`, 'sun waiting on the user');
		expect(await confirmShown()).toBe(true);
		// Its turn ends (hcom lists it listening): no stop, closed, the LAT status as it was; then a new
		// turn: the stop is back, the confirmation is not.
		await sunTurn('listening');
		await tab.until(`!document.querySelector(${JSON.stringify(STOP)})`, 'no stop once its turn ended');
		expect(await confirmShown()).toBe(false);
		expect(await tab.eval(`document.querySelector(${JSON.stringify(SEND)}).getAttribute('aria-label')`)).toBe('送出');
		expect(await tab.eval<string>(`document.querySelector('.detail .status').innerText`)).toContain('等你');
		await sunTurn('blocked');
		await tab.until(`!!document.querySelector(${JSON.stringify(STOP)})`, 'the stop again');
		expect(await confirmShown()).toBe(false);
		expect(herdrCalls()).toEqual([]);
	} finally {
		fixture.list([lead, gone]);
		fixture.setHcom({ agents: HCOM_AGENTS });
		setHerdr();
		await fixture.refresh(cookie);
	}
}, 60_000);

// The stop follows the live agent with the controller's session, not the LAT reports. Each case
// changes only what LAT or the live agent says of `lead` and puts it back.
const LEAD_CASES: { name: string; report?: boolean; ended?: boolean; lat: () => object; hcom?: string; herdr?: () => object; stop: boolean }[] = [
	{ name: 'LAT-disabled (idle) but really at work', report: true, ended: true, lat: () => [gone], stop: true },
	{ name: 'delivered (DONE report) but really at work', report: true, lat: () => [lead, gone], stop: true },
	{ name: 'waiting on a question but really at work', lat: () => [{ ...lead, questions: [question()] }, gone], stop: true },
	{ name: 'LAT-disabled but really idle', report: true, ended: true, lat: () => [gone], hcom: 'listening', stop: false },
	{ name: 'LAT says working but really idle (hcom listening)', lat: () => [lead, gone], hcom: 'listening', stop: false },
	{ name: 'LAT says working but not in Herdr', lat: () => [lead, gone], herdr: () => ({ agents: [], panes: [] }), stop: false }
];
for (const { name, report, ended, lat, hcom, herdr, stop } of LEAD_CASES) {
	test.skipIf(!CHROME)(`the stop on a controller's page: ${name} -> ${stop ? 'stop' : 'no stop'}`, async () => {
		if (report) fixture.report('s-lead', { tag: 'DONE', summary: '交付', message: '交付了。', time: minutesAgo(3), hcom_name: 'lead', workspace: lead.workspace });
		fixture.list(lat() as never);
		fixture.setHcom({ agents: [hcomAgent('lead', 's-lead', hcom ?? 'active'), ...HCOM_AGENTS.slice(1)] });
		if (herdr) setHerdr(herdr());
		await fixture.refresh(cookie);
		try {
			await visit(1280, '?controller=s-lead');
			await tab.until(`${pageOf('lat')}`, "lead's page");
			await sleep(300);
			expect(await tab.eval(`!!document.querySelector(${JSON.stringify(STOP)})`)).toBe(stop);
			// Ended in LAT, working or not: its page still offers the close.
			if (ended) expect(await tab.eval(`!!document.querySelector('.detail [data-action="close"]')`)).toBe(true);
			// An ended one that works is shown 工作中 but still woken, not sent to (LAT would refuse a send).
			if (ended && stop) {
				await type('在嗎');
				await tab.until(`document.querySelector(${JSON.stringify(SEND)})?.innerText.trim() === '喚醒'`, 'the wake button');
				await tab.eval(`document.querySelector(${JSON.stringify(OPTIONS)}).click()`);
				await tab.until(`!!document.querySelector(${JSON.stringify(POPUP)})`, 'the wake options');
				expect(await tab.eval(`document.querySelector(${JSON.stringify(POPUP)}).innerText`)).toContain('已停用 LAT（正在工作）');
				await tab.eval(`document.querySelector(${JSON.stringify(SEND)}).click()`);
				await tab.until(`document.querySelector(${JSON.stringify(BOX)}).value === ''`, 'the box emptied');
				expect(injects()).toEqual([['lead', '在嗎', '--enter']]);
				expect((await sentLog('s-lead')).find((entry) => said(entry, '在嗎'))).toMatchObject({ kind: 'wake', outcome: 'sent' });
				await tab.until(`!!document.querySelector(${JSON.stringify(STOP)})`, 'the stop again');
			}
			if (stop) {
				// With the wake options open, the stop closes them: one pop-up at a time, never overlapping.
				if (ended) {
					await tab.eval(`document.querySelector(${JSON.stringify(OPTIONS)}).click()`);
					await tab.until(`!!document.querySelector(${JSON.stringify(POPUP)})`, 'the wake options');
				}
				await tab.eval(`document.querySelector(${JSON.stringify(STOP)}).click()`);
				await tab.until(`!!document.querySelector(${JSON.stringify(CONFIRM_STOP)})`, 'the confirmation');
				expect(await tab.eval(`document.querySelectorAll('.dock .popup').length`)).toBe(1);
				expect(await tab.eval(`!!document.querySelector(${JSON.stringify(POPUP)})`)).toBe(false);
				await tab.pointerClick(CONFIRM_STOP);
				await tab.until(`document.querySelector('.dock')?.innerText.includes('已對 @lead 送出 Esc')`, 'the interrupt notice');
				// The Esc went to the pane of the session that was open, nobody else's.
				expect(herdrCalls()).toEqual([['agent', 'send-keys', 'wA:p-s-lead', 'esc']]);
				expect((await agentLog('s-lead')).map((entry: any) => [entry.action, entry.ok])).toContainEqual(['interrupt', true]);
			} else {
				expect(await tab.eval(`!!document.querySelector(${JSON.stringify(SEND)})`)).toBe(true);
			}
		} finally {
			rmSync(join(fixture.reportsDir, 's-lead.jsonl'), { force: true });
			fixture.list([lead, gone]);
			fixture.setHcom({ agents: HCOM_AGENTS });
			setHerdr();
			await fixture.refresh(cookie);
		}
	}, 60_000);
}

test.skipIf(!CHROME)("a controller's last report of today shows the time only (the date from yesterday on is in notice-time.test.ts)", async () => {
	await visit(1280, '?controller=s-luna');
	await tab.until(pageOf('moon'), "luna's page");
	const shown = await tab.eval<string>(`[...document.querySelectorAll('.detail .chip')].map((chip) => chip.innerText).find((text) => text.includes('最後回報'))`);
	// Her report is 15 minutes old: today unless midnight just passed.
	const reportedOn = new Date(LUNA_REPORTED_AT).toDateString();
	expect(shown).toMatch(reportedOn === new Date().toDateString() ? /最後回報 \d{2}:\d{2}:\d{2}$/ : /最後回報 \d+\/\d+ \d{2}:\d{2}:\d{2}$/);
}, 60_000);

// Wide: a new LAT round and an effort; a phone: the same conversation with another model.
for (const { width, newRound, kind, value, flags } of [
	{ width: 1280, newRound: true, kind: '思考強度', value: 'high', flags: ['--effort', 'high'] },
	{ width: 390, newRound: false, kind: '模型', value: 'claude-sonnet-5-5', flags: ['--model', 'claude-sonnet-5-5'] }
]) {
	test.skipIf(!CHROME)(`${width}px: a closed controller is woken with the wake's options, resuming its conversation, and the wake is in its sent log`, async () => {
		const text = `醒來 ${width}`;
		const prompt = newRound ? `/lat ${text}` : text;
		await visit(width, '?agent=s-gone');
		await tab.until(`${pageOf('dusk')} && document.querySelector(${JSON.stringify(SEND)})?.innerText.trim() === '喚醒'`, "the closed controller's page");
		if (width > 760) expect(await tab.eval(`document.querySelector('.dock .to').innerText`)).toBe('→ @gone');
		expect(await tab.eval(`document.querySelector(${JSON.stringify(OPTIONS)}).disabled`)).toBe(false);
		await type(text);
		await tab.eval(`document.querySelector(${JSON.stringify(OPTIONS)}).click()`);
		await tab.until(`!!document.querySelector(${JSON.stringify(POPUP)})`, 'the wake options');
		expect(await tab.eval<string>(`document.querySelector(${JSON.stringify(POPUP)}).innerText`)).toContain('開新一輪 LAT');
		if (newRound) await tab.eval(`document.querySelector('${POPUP} input[type=checkbox]').click()`);
		expect(await tab.eval(FITS)).toBe(true);
		// Its model or effort for this wake, from the controller's model picker beside the button,
		// opened once the board has read what it may be woken with.
		const menu = `.dock [role="menu"][aria-label="${kind}"]`;
		await tab.until(
			`(() => { const part = document.querySelector('.dock .pill-slot .part[aria-label^="${kind}："]'); if (part.getAttribute('aria-expanded') !== 'true') part.click(); return !!document.querySelector('${menu}'); })()`,
			`the ${kind} menu`
		);
		await tab.eval(`[...document.querySelectorAll('${menu} button')].find((b) => b.querySelector('small')?.innerText === ${JSON.stringify(value)}).click()`);
		await tab.eval(`document.querySelector(${JSON.stringify(SEND)}).click()`);
		await tab.until(`document.querySelector(${JSON.stringify(BOX)}).value === ''`, 'the box emptied');
		// Resumed by its session ID with what was chosen; nothing typed, nothing sent as an agent.
		expect(resumes()).toEqual([['r', 's-gone', '--terminal', 'herdr', '--no-run-here', '--go', '--hcom-prompt', prompt, ...flags]]);
		expect(injects()).toEqual([]);
		expect(await agentLog('s-gone')).toEqual([]);
		const wake = (await sentLog('s-gone')).find((entry) => said(entry, prompt));
		expect(wake).toMatchObject({ kind: 'wake', route: 'resume', newRound });
		await tab.eval(click('.detail [role="tablist"]', '送出紀錄'));
		await tab.until(`document.querySelector('#panel-sent:not([hidden])')?.innerText.includes(${JSON.stringify(text)})`, 'the wake in the sent log');
		// The attempt stays open until the resumed client shows; given up for the next test.
		await fixture.fetch('/api/wake/abandon', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ controllerId: 's-gone', wakeId: wake!.id }),
			cookie
		});
	}, 60_000);
}

// With the wake's options open the model and effort menus are on top of them, so a real click on a
// choice reaches the choice (an element's own click() would not show it).
for (const width of [1280, 390]) {
	for (const [page, search] of [['Herdr tab', '?agent=s-gone'], ['information page', '?controller=s-gone']]) {
		test.skipIf(!CHROME)(`${width}px: the ${page}'s effort menu is clickable over the open wake options`, async () => {
			await visit(width, search);
			await tab.until(`${pageOf('dusk')} && document.querySelector(${JSON.stringify(SEND)})?.innerText.trim() === '喚醒'`, "the closed controller's page");
			await tab.eval(`document.querySelector(${JSON.stringify(OPTIONS)}).click()`);
			await tab.until(`!!document.querySelector(${JSON.stringify(POPUP)})`, 'the wake options');
			const menu = `.dock [role="menu"][aria-label="思考強度"]`;
			await tab.until(
				`(() => { const part = document.querySelector('.dock .pill-slot .part[aria-label^="思考強度："]'); if (part.getAttribute('aria-expanded') !== 'true') part.click(); return !!document.querySelector('${menu}'); })()`,
				'the effort menu'
			);
			const item = `[...document.querySelectorAll('${menu} button')].find((b) => b.querySelector('small')?.innerText === 'high')`;
			await tab.eval(`${item}.setAttribute('data-test-high', '')`);
			const hit = `!!(() => { const r = document.querySelector('[data-test-high]').getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('[data-test-high]'); })()`;
			expect(await tab.eval(hit)).toBe(true);
			await tab.pointerClick('[data-test-high]');
			await tab.until(`document.querySelector('.dock .pill-slot .part[aria-label^="思考強度："]').getAttribute('aria-label').includes('high')`, 'the effort chosen');
			// The wake options stay usable.
			await tab.pointerClick(`${POPUP} input[type=checkbox]`);
			expect(await tab.eval(`document.querySelector('${POPUP} input[type=checkbox]').checked`)).toBe(true);
			expect(await tab.eval(FITS)).toBe(true);
		}, 60_000);
	}
}

test.skipIf(!CHROME)('an ended controller still running in its pane is woken by typing into it', async () => {
	await visit(1280, '?agent=s-luna');
	await tab.until(`${pageOf('moon')} && document.querySelector(${JSON.stringify(SEND)})?.innerText.trim() === '喚醒'`, "the ended controller's page");
	await type('還在嗎');
	await tab.eval(`document.querySelector(${JSON.stringify(SEND)}).click()`);
	await tab.until(`document.querySelector(${JSON.stringify(BOX)}).value === ''`, 'the box emptied');
	expect(injects()).toEqual([['luna', '還在嗎', '--enter']]);
	expect(resumes()).toEqual([]);
	expect((await sentLog('s-luna')).find((entry) => said(entry, '還在嗎'))).toMatchObject({ kind: 'wake', route: 'inject', outcome: 'sent' });
}, 60_000);

test.skipIf(!CHROME)('a resume that is still open refuses a second wake, and can be given up from the wake options', async () => {
	// The resume runs past hcom's time limit: open, its pane unknown.
	fixture.setHcom({ agents: HCOM_AGENTS, sleepMs: 2_000 });
	try {
		await visit(1280, '?agent=s-gone');
		await tab.until(`${pageOf('dusk')} && document.querySelector(${JSON.stringify(SEND)})?.innerText.trim() === '喚醒'`, "the closed controller's page");
		await type('第一次');
		await tab.eval(`document.querySelector(${JSON.stringify(SEND)}).click()`);
		await tab.until(`document.querySelector(${JSON.stringify(BOX)}).value === ''`, 'the first wake');
		await type('第二次');
		await tab.eval(`document.querySelector(${JSON.stringify(SEND)}).click()`);
		// Refused: the text stays and the options open on the give-up.
		await tab.until(`!!document.querySelector(${JSON.stringify(POPUP)})?.innerText.includes('放棄前一次接回')`, 'the offer to give up');
		expect(await boxText()).toBe('第二次');
		expect(resumes()).toHaveLength(1);
		await tab.eval(click(POPUP, '放棄前一次接回'));
		await tab.eval(click(POPUP, '確認放棄'));
		await tab.until(`document.querySelector('.dock').innerText.includes('已放棄前一次接回')`, 'given up');
		// Now the wake goes through again.
		fixture.setHcom({ agents: HCOM_AGENTS });
		await tab.eval(`document.querySelector(${JSON.stringify(SEND)}).click()`);
		await tab.until(`document.querySelector(${JSON.stringify(BOX)}).value === ''`, 'the second wake');
		expect(resumes()).toHaveLength(2);
		const open = (await sentLog('s-gone')).find((entry) => entry.kind === 'wake' && entry.open);
		if (open) {
			await fixture.fetch('/api/wake/abandon', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ controllerId: 's-gone', wakeId: open.id }),
				cookie
			});
		}
	} finally {
		fixture.setHcom({ agents: HCOM_AGENTS });
	}
}, 60_000);

test.skipIf(!CHROME)("an ordinary agent is still written to as an agent, from a draft of its own", async () => {
	await visit(1280, '?agent=s-plain');
	await tab.until(`!!document.querySelector('.detail [data-agent="s-plain"]') && !!document.querySelector(${JSON.stringify(BOX)})`, 'the agent page');
	expect(await tab.eval(`document.querySelector('.dock .to').innerText`)).toBe('→ @plain');
	await tab.until(`!!document.querySelector('.dock .pill-slot [data-pick]')`, "the agent's model picker");
	expect(await tab.eval(`!!document.querySelector(${JSON.stringify(OPTIONS)})`)).toBe(false);
	await type('給一般 Agent');
	await tab.eval(`document.querySelector(${JSON.stringify(SEND)}).click()`);
	await tab.until(`document.querySelector(${JSON.stringify(BOX)}).value === ''`, 'the box emptied');
	expect(injects()).toEqual([['plain', '給一般 Agent', '--enter']]);
	await until(async () => (await agentLog('s-plain')).length === 1, "the agent's record");
	expect(await sentLog('s-plain')).toEqual([]);
}, 60_000);

for (const width of [1280, 390]) {
	test.skipIf(!CHROME)(`${width}px: the controllers' draft is shared between the Herdr tab and the information page; an agent keeps its own`, async () => {
		await visit(width, '?agent=s-lead');
		await tab.until(`${pageOf('lat')} && !!document.querySelector(${JSON.stringify(BOX)})`, "the controller's page");
		await type('打到一半');
		// To the inbox tab, and the same controller's information page from the roster, in the board.
		if (await tab.eval(`!!document.querySelector('.topbar')`)) {
			await tab.eval(`document.querySelector('.topbar button').click()`);
			await tab.until(`!document.querySelector('.topbar')`, 'the list again');
		}
		await tab.eval(`document.querySelector('[data-middle="inbox"]').click()`);
		await tab.eval(`document.querySelector('.unfolded button.person[data-controller="lead"]').click()`);
		await tab.until(`new URLSearchParams(location.search).get('controller') === 's-lead' && ${pageOf('lat')}`, 'the information page');
		expect(await boxText()).toBe('打到一半');
		// An ordinary agent has a draft of its own.
		await tab.navigate(`${fixture.url}/?agent=s-plain`);
		await started();
		await tab.until(`!!document.querySelector('.detail [data-agent="s-plain"]')`, 'the agent page');
		expect(await boxText()).toBe('');
		await tab.navigate(`${fixture.url}/?agent=s-lead`);
		await started();
		await tab.until(pageOf('lat'), "the controller's page again");
		expect(await boxText()).toBe('打到一半');
		expect(injects()).toEqual([]);
		expect(await tab.eval(FITS)).toBe(true);
	}, 60_000);
}

test.skipIf(!CHROME)("a draft typed to a controller as an agent before is taken into the empty controllers' draft once", async () => {
	await visit(1280, '?agent=s-lead', { [AGENT_DRAFTS_KEY]: JSON.stringify({ 's-lead': '升級前的話', 's-plain': '別人的話' }) });
	await tab.until(`${pageOf('lat')} && document.querySelector(${JSON.stringify(BOX)})?.value === '升級前的話'`, 'the old draft taken in');
	await until(async () => JSON.parse((await stored(AGENT_DRAFTS_KEY)) ?? '{}')['s-lead'] === undefined, 'the old draft gone');
	expect(JSON.parse((await stored(AGENT_DRAFTS_KEY))!)).toEqual({ 's-plain': '別人的話' });
	expect(await stored(COMMAND_DRAFT_KEY)).toBe('升級前的話');
	// Read back after a reload: not taken in twice.
	await tab.navigate(`${fixture.url}/?agent=s-lead`);
	await started();
	await tab.until(pageOf('lat'), "the controller's page again");
	await sleep(300);
	expect(await boxText()).toBe('升級前的話');
	expect(injects()).toEqual([]);
	expect(resumes()).toEqual([]);
}, 60_000);

test.skipIf(!CHROME)("with text in both, the old draft goes after the controllers' draft, a blank line between, once", async () => {
	await visit(1280, '?agent=s-lead', { [COMMAND_DRAFT_KEY]: '共用的話', [AGENT_DRAFTS_KEY]: JSON.stringify({ 's-lead': '升級前的話' }) });
	await tab.until(`${pageOf('lat')} && document.querySelector(${JSON.stringify(BOX)})?.value === '共用的話\\n\\n升級前的話'`, 'both drafts joined');
	await until(async () => (await stored(AGENT_DRAFTS_KEY)) === null, 'the old draft gone');
	await tab.navigate(`${fixture.url}/?agent=s-lead`);
	await started();
	await tab.until(pageOf('lat'), "the controller's page again");
	await sleep(300);
	expect(await boxText()).toBe('共用的話\n\n升級前的話');
	expect(injects()).toEqual([]);
}, 60_000);

test.skipIf(!CHROME)("opened from the list, each controller's old draft is taken in once, after what the controllers' draft has", async () => {
	await visit(1280, '?agent=s-plain', { [AGENT_DRAFTS_KEY]: JSON.stringify({ 's-lead': '給 lead 的舊話', 's-gone': '給 gone 的舊話', 's-plain': '別人的話' }) });
	await tab.until(`!!document.querySelector('.detail [data-agent="s-plain"]') && document.querySelector(${JSON.stringify(BOX)})?.value === '別人的話'`, "the agent's own draft");
	const openFromList = async (session: string) => {
		await tab.eval(`document.querySelector('[data-middle="agents"]').click()`);
		await tab.until(`!!document.querySelector('.inbox button.agent[data-agent="${session}"]')`, `the card of ${session}`);
		await tab.eval(`document.querySelector('.inbox button.agent[data-agent="${session}"]').click()`);
	};
	await openFromList('s-lead');
	await tab.until(`${pageOf('lat')} && document.querySelector(${JSON.stringify(BOX)})?.value === '給 lead 的舊話'`, "lead's old draft taken in");
	await openFromList('s-gone');
	await tab.until(`${pageOf('dusk')} && document.querySelector(${JSON.stringify(BOX)})?.value === '給 lead 的舊話\\n\\n給 gone 的舊話'`, "gone's old draft after it");
	await until(async () => JSON.stringify(JSON.parse((await stored(AGENT_DRAFTS_KEY)) ?? '{}')) === JSON.stringify({ 's-plain': '別人的話' }), 'only the agent draft left');
	// Back and forth: nothing taken in again, and the agent keeps its own.
	await openFromList('s-lead');
	await tab.until(pageOf('lat'), "lead's page again");
	await sleep(300);
	expect(await boxText()).toBe('給 lead 的舊話\n\n給 gone 的舊話');
	await openFromList('s-plain');
	await tab.until(`!!document.querySelector('.detail [data-agent="s-plain"]')`, 'the agent page again');
	expect(await boxText()).toBe('別人的話');
	expect(injects()).toEqual([]);
	expect(resumes()).toEqual([]);
}, 60_000);
