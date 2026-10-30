// In the light theme, a finished (DONE) report in a controller's conversation is framed dark
// green whether read or not, and its 完成 label is filled dark green with white text while unread
// (like the inbox list's) and white with a black frame once read. Shown as a card (the Herdr
// tab's agent page) or as the reported message (the controller page); HELP reports and the dark
// theme are as before. Headless Chrome on the built board with fake data. Skipped when the host
// has no Chrome.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser } from '../browser.ts';

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
const evaluate = <T>(expression: string) => browser!.tab.eval<T>(expression);

const TEXTS = { unread: '甲項完成了。', read: '乙項完成了。', help: '丙項卡住了。' };
const SUMMARY = { unread: '甲完成', read: '乙完成', help: '丙求助' };

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	cookie = await fixture.login('done-label-light');
	const lead = fixture.bound('alpha', 'lead', { session_id: 's-lead' });
	fixture.list([lead]);
	const at = (seconds: number) => new Date(Date.parse('2026-10-20T01:00:00.000Z') + seconds * 1000).toISOString();
	fixture.setClock(Date.parse('2026-10-20T02:00:00.000Z'));
	const send = (tag: 'DONE' | 'HELP', name: keyof typeof TEXTS, seconds: number) =>
		fixture.report('s-lead', { tag, summary: SUMMARY[name], message: TEXTS[name], time: at(seconds), hcom_name: 'lead', workspace: lead.workspace });
	send('DONE', 'unread', 10);
	send('DONE', 'read', 20);
	send('HELP', 'help', 30);
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	const lines = [
		{ kind: 'assistant', time: at(11), text: TEXTS.unread },
		{ kind: 'assistant', time: at(21), text: TEXTS.read },
		{ kind: 'assistant', time: at(31), text: TEXTS.help }
	];
	writeFileSync(join(fixture.dir, 'transcripts', 's-lead.jsonl'), lines.map((line) => JSON.stringify(line) + '\n').join(''));
	fixture.setHcom({ agents: [{ name: 'lead', session_id: 's-lead', status: 'listening', launch_context: { pane_id: 'wA:p-s-lead' } }] });
	const agent = { agent: 'claude', agent_session: { kind: 'id', value: 's-lead' }, agent_status: 'idle', cwd: lead.workspace, pane_id: 'wA:p-s-lead', tab_id: 'wA:t-s-lead', workspace_id: 'wA' };
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents: [agent],
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
			panes: [{ pane_id: agent.pane_id, workspace_id: 'wA', cwd: agent.cwd, tab_id: agent.tab_id }],
			tabs: [{ tab_id: agent.tab_id, workspace_id: 'wA', label: '分頁-s-lead' }]
		})
	);
	await fixture.refresh(cookie);
	const snapshot = await fixture.board(cookie);
	const read = snapshot.inbox.find((item) => item.kind === 'report' && item.title === SUMMARY.read);
	expect(read).toBeDefined();
	expect((await fixture.markRead(cookie, read!.key)).status).toBe(200);
	browser = await launchChrome();
	const [name, value] = cookie.split('=');
	await browser.tab.send('Network.setCookie', { name, value, url: fixture.url });
	await browser.tab.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

type Look = {
	label: { backgroundColor: string; color: string; borderTopColor: string; borderTopWidth: string };
	frame: { borderTopColor: string; borderLeftColor: string };
	palette: { ok: string; bg: string; text: string; line: string };
};
const TRANSPARENT = 'rgba(0, 0, 0, 0)';

/** The look of the report whose text is `text`, as a card (`.report article`) or a message (`.said`). */
const lookOf = (text: string, shape: 'card' | 'message') => `(() => {
	const root = [...document.querySelectorAll(${JSON.stringify(shape === 'card' ? '.history li.report article' : '.history li.said')})].find((el) => el.innerText.includes(${JSON.stringify(text)}));
	if (!root) return null;
	const probe = (value) => { const el = document.body.appendChild(document.createElement('i')); el.style.color = value; const color = getComputedStyle(el).color; el.remove(); return color; };
	const label = getComputedStyle(root.querySelector('.label'));
	const frame = getComputedStyle(root);
	return {
		label: { backgroundColor: label.backgroundColor, color: label.color, borderTopColor: label.borderTopColor, borderTopWidth: label.borderTopWidth },
		frame: { borderTopColor: frame.borderTopColor, borderLeftColor: frame.borderLeftColor },
		palette: { ok: probe('var(--ok)'), bg: probe('var(--bg)'), text: probe('var(--text)'), line: probe('var(--line)') }
	};
})()`;

/** Whether the report's label is filled with the palette colour `name`. */
const isLabel = (text: string, shape: 'card' | 'message', name: 'ok' | 'bg') => `(() => { const look = ${lookOf(text, shape)}; return !!look && look.label.backgroundColor === look.palette.${name}; })()`;

const open = async (url: string, theme: string, shape: 'card' | 'message') => {
	await browser!.tab.navigate(`${fixture.url}${url}`);
	await evaluate(`localStorage.setItem('lat-board-theme', ${JSON.stringify(theme)})`);
	await browser!.tab.navigate(`${fixture.url}${url}`);
	await browser!.tab.until(`!!(${lookOf(TEXTS.read, shape)})`, `the ${shape}s`);
};

const filled = (look: Look) => {
	expect(look.label.backgroundColor).toBe(look.palette.ok);
	expect(look.label.color).toBe(look.palette.bg);
};
const outlined = (look: Look) => {
	expect(look.label.backgroundColor).toBe(look.palette.bg);
	expect(look.label.color).toBe(look.palette.text);
	expect(look.label.borderTopColor).toBe(look.palette.text);
};

for (const shape of ['card', 'message'] as const) {
	const url = shape === 'card' ? '/?agent=s-lead' : '/?controller=s-lead';

	test.skipIf(!CHROME)(`light theme, ${shape}: an unread DONE label is filled dark green, a read one white with a black frame, both framed dark green`, async () => {
		await open(url, 'light', shape);
		const unread = (await evaluate<Look>(lookOf(TEXTS.unread, shape)))!;
		filled(unread);
		expect(unread.frame.borderTopColor).toBe(unread.palette.ok);
		expect(unread.frame.borderLeftColor).toBe(unread.palette.ok);
		const read = (await evaluate<Look>(lookOf(TEXTS.read, shape)))!;
		outlined(read);
		expect(read.frame.borderTopColor).toBe(read.palette.ok);
		expect(read.frame.borderLeftColor).toBe(read.palette.ok);
		// The inbox list gives the same unread report the same fill.
		const listed = await evaluate<{ background: string; color: string }>(
			`(() => { const label = document.querySelector('.row.fresh .kind[data-kind="report"]'); const style = getComputedStyle(label); return { background: style.backgroundColor, color: style.color }; })()`
		);
		expect({ background: unread.label.backgroundColor, color: unread.label.color }).toEqual(listed);
	}, 30_000);

	test.skipIf(!CHROME)(`light theme, ${shape}: marking a report read or unread while it is open changes its label at once and not its frame`, async () => {
		await open(url, 'light', shape);
		const key = (await fixture.board(cookie)).inbox.find((item) => item.kind === 'report' && item.title === SUMMARY.unread)!.key;
		expect((await fixture.markRead(cookie, key)).status).toBe(200);
		// Whatever happens next, the report goes back to unread for the tests after this one.
		try {
			await browser!.tab.until(`${isLabel(TEXTS.unread, shape, 'bg')}`, 'the label outlined');
			const read = (await evaluate<Look>(lookOf(TEXTS.unread, shape)))!;
			outlined(read);
			expect(read.frame.borderTopColor).toBe(read.palette.ok);
			expect((await fixture.markUnread(cookie, key)).status).toBe(200);
			await browser!.tab.until(isLabel(TEXTS.unread, shape, 'ok'), 'the label filled');
			filled((await evaluate<Look>(lookOf(TEXTS.unread, shape)))!);
		} finally {
			await fixture.markUnread(cookie, key);
		}
	}, 30_000);

	test.skipIf(!CHROME)(`dark theme, ${shape}: the label and frame are as before and do not depend on read`, async () => {
		await open(url, 'dark', shape);
		const unread = (await evaluate<Look>(lookOf(TEXTS.unread, shape)))!;
		const read = (await evaluate<Look>(lookOf(TEXTS.read, shape)))!;
		expect(unread).toEqual(read);
		if (shape === 'card') {
			expect(unread.label.backgroundColor).toBe(TRANSPARENT);
			expect(unread.label.borderTopColor).toBe(unread.palette.line);
			expect(unread.frame.borderTopColor).toBe(unread.palette.line);
			expect(unread.frame.borderLeftColor).toBe(unread.palette.ok);
		} else {
			filled(unread);
			expect(unread.frame.borderTopColor).not.toBe(unread.palette.ok);
		}
	}, 30_000);
}

test.skipIf(!CHROME)('light theme: a HELP report is not changed (the reported message keeps its black frame and white label)', async () => {
	await open('/?controller=s-lead', 'light', 'message');
	const look = (await evaluate<Look>(lookOf(TEXTS.help, 'message')))!;
	outlined(look);
	expect(look.frame.borderTopColor).toBe(look.palette.text);
}, 30_000);
