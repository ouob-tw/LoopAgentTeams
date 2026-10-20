// The 額度 tab in a real browser: headless Chrome driven over its DevTools protocol, on the built
// board with a fake claude-swap and codex-multi-auth files in a temporary folder, with the middle
// column 360px wide and at a phone's width. Skipped when the host has no Chrome.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { DAY, PORT_BASE, sleep, startFixture, type Fixture } from './harness.ts';

const CHROME = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(
	(path) => path && existsSync(path)
);
const DEBUG_PORT = PORT_BASE + 59;
const MIN = 60_000;

/** One Chrome tab, spoken to over the DevTools protocol. */
class Tab {
	#socket: WebSocket;
	#next = 0;
	#waiting = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();
	constructor(socket: WebSocket) {
		this.#socket = socket;
		socket.addEventListener('message', (event) => {
			const message = JSON.parse(String(event.data));
			this.#waiting.get(message.id)?.(message);
			this.#waiting.delete(message.id);
		});
	}
	static async open(): Promise<Tab> {
		const deadline = Date.now() + 10_000;
		let target: { webSocketDebuggerUrl: string } | undefined;
		while (!target) {
			if (Date.now() > deadline) throw new Error('timed out waiting for Chrome to listen');
			target = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' }).then(
				(response) => response.json(),
				() => undefined
			);
			if (!target) await sleep(100);
		}
		const socket = new WebSocket(target.webSocketDebuggerUrl);
		await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
		return new Tab(socket);
	}
	send(method: string, params: object = {}): Promise<any> {
		const id = ++this.#next;
		this.#socket.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) =>
			this.#waiting.set(id, (message) => (message.error ? reject(new Error(message.error.message)) : resolve(message.result)))
		);
	}
	async eval<T = unknown>(expression: string): Promise<T> {
		const { result, exceptionDetails } = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
		if (exceptionDetails) throw new Error(`${expression}: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
		return result.value;
	}
	async until(expression: string, what = expression) {
		const deadline = Date.now() + 10_000;
		while (!(await this.eval(expression).catch(() => false))) {
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; the page shows ${JSON.stringify(await this.eval(SCREEN))}`);
			await sleep(50);
		}
	}
	close() {
		this.#socket.close();
	}
}

const SCREEN = `({ search: location.search, middle: document.querySelector('.inbox')?.innerText ?? '' })`;
/** Nothing on the page reaches past the window's width, and nothing in the middle column past its own. */
const FITS = `document.documentElement.scrollWidth <= window.innerWidth && [...document.querySelectorAll('.inbox, .inbox *')].every((node) => node.scrollWidth <= node.clientWidth + 1)`;

let fixture: Fixture;
let cookie: string;
let chrome: ChildProcess | undefined;
let profile: string;
let tab: Tab;
const iso = (time: number) => new Date(time).toISOString();
const usageWindow = (pct: number, resetsAt: number) => ({ pct, resetsAt: iso(resetsAt).replace('Z', '+00:00') });

function setClaude(now: number, activeAge = MIN) {
	writeFileSync(
		join(fixture.dir, 'cswap.json'),
		JSON.stringify({
			output: {
				schemaVersion: 1,
				activeAccountNumber: 2,
				cachedOnly: true,
				generatedAt: iso(now),
				accounts: [
					{
						number: 1,
						email: 'spare@example.com',
						active: false,
						usageStatus: 'unavailable',
						usage: null,
						lastGoodUsage: { fiveHour: usageWindow(70, now - MIN), sevenDay: usageWindow(30, now + 2 * DAY) },
						lastGoodFetchedAt: iso(now - 20 * MIN),
						plan: { id: 'pro', label: 'Pro', multiplier: 1, observedAt: iso(now - 3 * DAY - MIN) }
					},
					{
						number: 2,
						email: 'a-very-long-address-for-the-account-in-use@example-company.com',
						active: true,
						usageStatus: 'ok',
						usage: {
							fiveHour: usageWindow(40, now + 60 * MIN),
							sevenDay: usageWindow(85, now + 3 * DAY),
							scoped: [{ name: 'Fable', ...usageWindow(96, now + 2 * DAY) }]
						},
						usageFetchedAt: iso(now - activeAge),
						plan: { id: 'max_5x', label: 'Max 5x', multiplier: 5, observedAt: iso(now - 10 * MIN) }
					},
					{ number: 3, email: 'new@example.com', active: false, usageStatus: 'unavailable', usage: null, plan: { id: 'unknown', label: 'Unknown', multiplier: 1, observedAt: null } }
				]
			}
		})
	);
}
function setCodex(accounts: unknown, cache?: unknown) {
	const dir = join(fixture.dir, 'codex-multi-auth');
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'openai-codex-accounts.json'), JSON.stringify(accounts));
	if (cache !== undefined) writeFileSync(join(dir, 'quota-cache.json'), JSON.stringify(cache));
}

beforeAll(async () => {
	fixture = await startFixture(58, { env: { LAT_BOARD_QUOTA_SECONDS: '1' } });
	cookie = await fixture.login();
}, 30_000);
afterEach(async () => {
	if (!chrome || chrome.exitCode !== null) return;
	tab.close();
	const exited = new Promise((resolve) => chrome!.once('exit', resolve));
	chrome.kill('SIGKILL');
	await exited;
	rmSync(profile, { recursive: true, force: true });
});
afterAll(async () => {
	await fixture?.cleanup();
});

/** A new Chrome on the board's 額度 tab in a window `width` wide, the middle column 360px wide. */
async function visit(width: number) {
	profile = mkdtempSync(join(tmpdir(), 'lat-board-test-chrome-'));
	chrome = spawn(
		CHROME!,
		['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-extensions', `--user-data-dir=${profile}`, `--remote-debugging-port=${DEBUG_PORT}`, 'about:blank'],
		{ stdio: 'ignore' }
	);
	tab = await Tab.open();
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 761 });
	await tab.send('Page.navigate', { url: `${fixture.url}/login` });
	await tab.until(`document.readyState === 'complete'`, 'a page of the board');
	await tab.eval(`localStorage.setItem('lat-board-inbox-width', '360')`);
	await tab.send('Page.navigate', { url: `${fixture.url}/?tab=quota` });
	await tab.until(`JSON.stringify(history.state).includes('depth')`, 'the board to start');
	await tab.until(`!!document.querySelector('.inbox .quota .card')`, 'the 額度 tab');
}
const groupText = (client: string) => tab.eval<string>(`document.querySelector('.quota [data-client="${client}"]')?.innerText ?? ''`);
const header = (client: string) => tab.eval<string>(`document.querySelector('.quota [data-client="${client}"] header').innerText.replace(/\\s+/g, ' ')`);
const cards = (client: string) =>
	tab.eval<{ text: string; current: boolean }[]>(
		`[...document.querySelectorAll('.quota [data-client="${client}"] .card')].map((card) => ({ text: card.innerText, current: card.classList.contains('current') }))`
	);
const windows = `[...document.querySelectorAll('.quota [data-client="claude"] .card.current .window')].map((row) => ({
	text: row.innerText.replace(/\\s+/g, ' '),
	fill: row.querySelector('.fill')?.className.replace(/svelte-\\S+/g, '').trim() ?? null
}))`;

for (const width of [1280, 360]) {
	test.skipIf(!CHROME)(`${width}px: the accounts in use first and framed, every window with its bar, percent and reset, plans three ways`, async () => {
		setClaude(Date.now());
		setCodex({ version: 4, accounts: [] });
		await visit(width);
		await tab.until(`document.querySelectorAll('.quota [data-client="claude"] .card').length === 3`, 'the Claude cards');
		expect(await tab.eval(`document.querySelector('[data-middle="quota"]').getAttribute('aria-pressed')`)).toBe('true');
		if (width > 760) expect(await tab.eval(`Math.round(document.querySelector('.inbox').getBoundingClientRect().width)`)).toBeLessThanOrEqual(362);

		const claude = await cards('claude');
		expect(claude.map((card) => card.current)).toEqual([true, false, false]);
		expect(claude[0].text).toContain('使用中');
		expect(claude[0].text).toContain('a-very-long-address-for-the-account-in-use@example-company.com');
		expect(claude[0].text).toContain('Max 5x');
		// The group header: the account in use's reading, fresh.
		expect(await header('claude')).toBe('Claude 1 分鐘前更新');
		const rows = await tab.eval<{ text: string; fill: string | null }[]>(windows);
		expect(rows.length).toBe(3);
		expect(rows[0].text).toMatch(/^5 小時 40% \d\d:\d\d 重置$/);
		expect(rows[1].text).toMatch(/^7 天 85% \d+\/\d+ \d\d:\d\d 重置$/);
		expect(rows[2].text).toMatch(/^Fable 96% \d+\/\d+ \d\d:\d\d 重置$/);
		expect(rows.map((row) => row.fill)).toEqual(['fill', 'fill warn', 'fill danger']);

		// The other account: its own age, stale; a reset gone by waits for new data; its plan only recorded.
		expect(claude[1].text).toContain('spare@example.com');
		expect(claude[1].text).toContain('20 分鐘前更新・資料可能過舊');
		expect(claude[1].text).toContain('70%');
		expect(claude[1].text).toContain('等待新資料');
		expect(
			await tab.eval(`(() => { const plan = document.querySelectorAll('.quota [data-client="claude"] .card')[1].querySelector('.plan'); return [plan.innerText, plan.classList.contains('recorded'), plan.title]; })()`)
		).toEqual(['Pro', true, '上次使用時記錄（3 天前）']);
		expect(claude[2].text).toContain('方案未知');
		expect(claude[2].text).toContain('沒有紀錄');
		expect(claude[2].text).not.toContain('0%');

		// A source that cannot be read says why, and the other group is shown as ever.
		expect(await groupText('codex')).toContain('讀不出額度：Codex 帳號檔版本不符（是 4，看板認得 3）');
		// No quota on the roster, folded or not.
		expect(await tab.eval(`document.querySelector('.roster').innerText`)).not.toMatch(/額度|%/);
		expect(await tab.eval(FITS)).toBe(true);
	}, 30_000);
}

test.skipIf(!CHROME)('an old reading turns its group header yellow; no Codex usage reads 沒有紀錄', async () => {
	const now = Date.now();
	setClaude(now, 4 * MIN);
	setCodex(
		{ version: 3, activeIndex: 1, accounts: [{ accountId: 'acct-a', email: 'one@example.com' }, { accountId: 'acct-b', email: 'two@example.com' }] },
		{ version: 1, byAccountId: { 'acct-b': { updatedAt: now - 16 * MIN, status: 200, model: 'm', planType: 'plus', primary: { usedPercent: 10, windowMinutes: 300, resetAtMs: now + 60 * MIN }, secondary: {} } }, byEmail: {} }
	);
	await visit(1280);
	await tab.until(`document.querySelectorAll('.quota [data-client="codex"] .card').length === 2`, 'the Codex cards');
	expect(await header('claude')).toBe('Claude 4 分鐘前更新・資料可能過舊');
	expect(await tab.eval(`getComputedStyle(document.querySelector('.quota [data-client="claude"] .updated')).color`)).toBe(
		await tab.eval(`getComputedStyle(document.documentElement).getPropertyValue('--warn').trim() && (() => { const probe = document.createElement('span'); probe.style.color = 'var(--warn)'; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; })()`)
	);
	expect(await header('codex')).toBe('Codex 16 分鐘前更新・資料可能過舊');
	const codex = await cards('codex');
	expect(codex[0].current).toBe(true);
	expect(codex[0].text).toContain('two@example.com');
	// A plan from a reading over an hour old would be faded; this one is fresh enough to show plainly.
	expect(codex[0].text).toContain('Plus');
	expect(codex[1].text).toContain('one@example.com');
	expect(codex[1].text).toContain('沒有紀錄');
	expect(codex[1].text).toContain('方案未知');
}, 30_000);
