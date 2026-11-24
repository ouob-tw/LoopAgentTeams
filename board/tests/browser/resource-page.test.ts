// The 資源 tab in a real browser: headless Chrome over its DevTools protocol, on the built board
// reading a fixture /proc whose ticks the test moves on while it runs, with seven agents in the fake
// Herdr's list. At a phone's width and a wide window: the tab beside 自動化, the bars with their
// numbers and colours, five agents and the fold, new numbers while it is open and no request once
// another tab is chosen. Frames go to LAT_BOARD_SHOTS when it is set. Skipped when the host has no Chrome.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, shot, TEST_MS, type Browser, type Tab } from '../browser.ts';

const SCREEN = `({ search: location.search, middle: document.querySelector('.inbox')?.innerText ?? '' })`;
/** Nothing on the page reaches past the window's width, and nothing in the tab past its own, but a
 *  name cut short with an ellipsis (its full text in its title). */
const OVERFLOWING = `[...document.querySelectorAll('.inbox .resource, .inbox .resource *')].filter((node) => node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).textOverflow !== 'ellipsis').map((node) => node.className || node.tagName)`;
const FITS = `document.documentElement.scrollWidth <= window.innerWidth && ${OVERFLOWING}.length === 0`;

const CORES = 8;
/** Ticks per second each agent's process uses: CPU share is ticks over 100 × cores. */
const AGENTS = [
	{ session: 's-heavy', name: 'dazire-impl696-a-rather-long-agent-name', client: 'codex', rate: 300, pages: 600_000 },
	{ session: 's-two', name: 'lulova', client: 'claude', rate: 160, pages: 300_000 },
	{ session: 's-three', name: 'qa411-browser', client: 'codex', rate: 80, pages: 400_000 },
	{ session: 's-four', name: 'zohona', client: 'claude', rate: 40, pages: 120_000 },
	{ session: 's-five', name: 'tufu', client: 'claude', rate: 20, pages: 90_000 },
	{ session: 's-six', name: 'razane', client: 'claude', rate: 0, pages: 80_000 },
	{ session: 's-seven', name: 'havune', client: 'claude', rate: 0, pages: 60_000 }
];
/** The host busy at 85% of its ticks: a warning. Memory 92% used: danger. */
const BUSY = 0.85;

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;
let procDir: string;
let ticker: ReturnType<typeof setInterval> | undefined;
const started = Date.now();

/** Write the fixture /proc as it stands `seconds` after the start. */
function writeProc(seconds: number) {
	const total = Math.round(100 * CORES * (1000 + seconds));
	const busy = Math.round(total * BUSY);
	const cores = Array.from({ length: CORES }, (_, index) => `cpu${index} 1 0 0 1 0 0 0 0 0 0`).join('\n');
	writeFileSync(join(procDir, 'stat'), `cpu  ${busy} 0 0 ${total - busy} 0 0 0 0 0 0\n${cores}\nbtime 1700000000\n`);
	writeFileSync(join(procDir, 'loadavg'), `6.20 5.80 5.10 4/900 4242\n`);
	writeFileSync(join(procDir, 'meminfo'), `MemTotal:       67108864 kB\nMemAvailable:    5368709 kB\n`);
	const procs = [
		{ pid: 1, comm: 'systemd', ppid: 0, ticks: 0, pages: 3000, pane: null },
		{ pid: 2, comm: 'chrome', ppid: 1, ticks: Math.round(40 * seconds), pages: 500_000, pane: null },
		...AGENTS.flatMap((agent, index) => [
			{ pid: 100 + index * 10, comm: 'bash', ppid: 1, ticks: 0, pages: 1000, pane: `wA:p-${agent.session}` },
			{ pid: 101 + index * 10, comm: agent.client, ppid: 100 + index * 10, ticks: Math.round(agent.rate * seconds), pages: agent.pages, pane: `wA:p-${agent.session}` }
		])
	];
	for (const proc of procs) {
		mkdirSync(join(procDir, `${proc.pid}`), { recursive: true });
		writeFileSync(
			join(procDir, `${proc.pid}/stat`),
			`${proc.pid} (${proc.comm}) S ${proc.ppid} ${proc.pid} ${proc.pid} 0 -1 0 0 0 0 0 ${proc.ticks} 0 0 0 20 0 1 0 100 1000 ${proc.pages} 0 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0\n`
		);
		writeFileSync(join(procDir, `${proc.pid}/environ`), proc.pane ? `PATH=/bin\0HERDR_PANE_ID=${proc.pane}\0` : 'PATH=/bin\0');
	}
}

beforeAll(async () => {
	procDir = mkdtempSync(join(tmpdir(), 'lat-board-proc-'));
	mkdirSync(join(procDir, 'self'), { recursive: true });
	writeFileSync(join(procDir, 'self/mounts'), '/dev/root / ext4 rw 0 0\n');
	writeProc(0);
	ticker = setInterval(() => writeProc((Date.now() - started) / 1000), 100);
	fixture = await startFixture({ env: { LAT_BOARD_PROC_ROOT: procDir } });
	cookie = await fixture.login();
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents: AGENTS.map((agent) => ({
				agent: agent.client,
				agent_session: { kind: 'id', value: agent.session },
				agent_status: 'working',
				cwd: `/home/someone/projects/${agent.session}`,
				pane_id: `wA:p-${agent.session}`,
				tab_id: `wA:t-${agent.session}`,
				workspace_id: 'wA'
			})),
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
			tabs: AGENTS.map((agent) => ({ tab_id: `wA:t-${agent.session}`, workspace_id: 'wA', label: agent.name }))
		})
	);
	await fixture.refresh(cookie);
}, 60_000);
afterEach(async () => {
	await browser?.close();
});
afterAll(async () => {
	clearInterval(ticker);
	await fixture?.cleanup();
	if (procDir) rmSync(procDir, { recursive: true, force: true });
});

/** A new Chrome on the board's 資源 tab in a window `width` wide, counting its resource requests. */
async function visit(width: number) {
	browser = await launchChrome({
		screen: SCREEN,
		scripts: [
			`window.__resourceAsks = 0; const send = window.fetch; window.fetch = (input, init) => { if (String(input).includes('/api/resources')) window.__resourceAsks++; return send(input, init); };`
		]
	});
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 761 });
	await tab.send('Page.navigate', { url: `${fixture.url}/` });
	await tab.boardStarted();
	await tab.eval(`document.querySelector('[data-middle="resource"]').click()`);
	await tab.until(`!!document.querySelector('.resource [data-part="agents"] .agents')`, 'the 資源 tab with its agents');
}

const meters = () =>
	tab.eval<{ label: string; value: string; bar: string; width: number }[]>(
		`[...document.querySelectorAll('.resource .meter')].map((row) => ({
			label: row.querySelector('.label').innerText,
			value: row.querySelector('.value').innerText.trim(),
			bar: row.querySelector('.bar').className.replace(/svelte-\\S+/g, '').trim(),
			width: Math.round(row.querySelector('.bar').getBoundingClientRect().width)
		}))`
	);
const agentRows = () => tab.eval<string[]>(`[...document.querySelectorAll('.resource .agents li')].map((row) => row.innerText.replace(/\\s+/g, ' ').trim())`);

for (const width of [390, 1400]) {
	test.skipIf(!CHROME)(
		`${width}px: the tab beside 自動化, bars coloured by level, five agents then the fold, new numbers while open and none after`,
		async () => {
			await visit(width);
			const shots = `resource-${width}`;
			// The tab sits last, after 自動化, and every tab button is in view without scrolling the row.
			expect(await tab.eval(`[...document.querySelectorAll('.middle-tabs button')].map((button) => button.dataset.middle)`)).toEqual(['inbox', 'agents', 'quota', 'automation', 'resource']);
			expect(await tab.eval(`(() => { const row = document.querySelector('.middle-tabs'); return row.scrollWidth <= row.clientWidth; })()`)).toBe(true);
			expect(await tab.eval(`location.search`)).toBe('?tab=resource');

			await tab.until(`[...document.querySelectorAll('.resource .agents li')][0]?.innerText.includes('%') && !document.querySelector('.resource .agents li')?.innerText.includes(' 0%')`, 'CPU counted');
			const rows = await meters();
			expect(rows.map((row) => row.label)).toEqual(['CPU', '負載', '記憶體', '/']);
			// CPU 85% warns, 92% of memory is danger, a load of 6.2 on 8 cores is fine.
			expect(rows[0].value).toBe('85%');
			expect(rows[0].bar).toBe('bar warn');
			expect(rows[1].value).toBe('6.2');
			expect(rows[1].bar).toBe('bar');
			expect(rows[2].value).toBe('59/64G');
			expect(rows[2].bar).toBe('bar danger');
			// Every bar starts and ends in the same place.
			expect(new Set(rows.map((row) => row.width)).size).toBe(1);
			// Each level has its own shape besides its colour.
			expect(await tab.eval(`[...document.querySelectorAll('.resource .value svg')].map((icon) => icon.getAttribute('aria-label'))`)).toEqual(['偏高', '過高']);

			// Five agents, the heaviest first, named; the other two behind the fold.
			let agents = await agentRows();
			expect(agents.length).toBe(5);
			expect(agents[0]).toMatch(/^dazire-impl696-a-rather-long-agent-name (3[6-9]|40)% 2\.3G$/);
			expect(agents.map((row) => row.split(' ')[0])).toEqual(['dazire-impl696-a-rather-long-agent-name', 'lulova', 'qa411-browser', 'zohona', 'tufu']);
			expect(await tab.eval(`document.querySelector('.resource .other').innerText`)).toContain('chrome');
			expect(await tab.eval(OVERFLOWING)).toEqual([]);
			expect(await tab.eval(FITS)).toBe(true);
			await shot(tab, `${shots}-1-top5`);
			const theme = await tab.eval<string>(`document.documentElement.dataset.theme`);
			await tab.eval(`document.documentElement.dataset.theme = '${theme === 'dark' ? 'light' : 'dark'}'`);
			await shot(tab, `${shots}-1-top5-other-theme`);
			await tab.eval(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);

			await tab.eval(`document.querySelector('.resource .fold').click()`);
			await tab.until(`document.querySelectorAll('.resource .agents li').length === 7`, 'every agent');
			agents = await agentRows();
			expect(agents.slice(5).map((row) => row.split(' ')[0])).toEqual(['razane', 'havune']);
			expect(await tab.eval(`document.querySelector('.resource .fold').getAttribute('aria-expanded')`)).toBe('true');
			expect(await tab.eval(FITS)).toBe(true);
			await shot(tab, `${shots}-2-all`);
			await tab.eval(`document.querySelector('.resource .fold').click()`);
			await tab.until(`document.querySelectorAll('.resource .agents li').length === 5`, 'folded again');

			// Asked again every few seconds while open.
			const asked = await tab.eval<number>(`window.__resourceAsks`);
			await tab.until(`window.__resourceAsks >= ${asked + 2}`, 'two more readings', 10_000);

			// A click on a row opens that agent.
			await tab.eval(`document.querySelector('.resource .agents li button').click()`);
			await tab.until(`location.search.includes('agent=s-heavy')`, 'the agent opened');
			if (width < 761) await tab.eval(`history.back()`);
			await tab.until(`!!document.querySelector('.resource')`, 'the tab again');

			// Another tab: no more requests.
			await tab.eval(`document.querySelector('[data-middle="quota"]').click()`);
			await tab.until(`!document.querySelector('.resource')`, 'the 額度 tab');
			const stopped = await tab.eval<number>(`window.__resourceAsks`);
			await Bun.sleep(7_000);
			expect(await tab.eval<number>(`window.__resourceAsks`)).toBe(stopped);
		},
		TEST_MS + 30_000
	);
}
