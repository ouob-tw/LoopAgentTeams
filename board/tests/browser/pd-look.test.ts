// 查看對話 on a pd request's card, in a real browser: headless Chrome driven over its DevTools
// protocol, on the built board with a fake pd (tests/fake-pd.mjs) and conversations the fake
// helper pages through. The caller's conversation opens at the `pd run` that made the request,
// marked, and marked 可能不準 too when pd did not vouch for the caller; with no such step near the
// request's time it opens at the newest part and says so; a caller the board does not know has no
// button. Skipped when the host has no Chrome.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser } from '../browser.ts';

const SCREEN = `({ search: location.search, pd: document.querySelector('.inbox .pd')?.innerText ?? '' })`;

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
const now = Date.now();
const iso = (ago: number) => new Date(now - ago * 1000).toISOString();

const checked = (name: string, client: string, verified: boolean) => ({
	name, client, group: null, orchestrator: true, source: 'auto', pid: verified ? 4242 : null, start_time: verified ? 98765 : null, program: verified ? client : null, verified, notice: '程序樹查證，非防竄改'
});
const request = (id: number, waiting: number, caller: string, extra: Record<string, unknown> = {}) => ({
	id, waiting, remaining: 600, caller, item: `item ${id}`, item_id: `item-${id}`, fields: ['password'], argv: ['python3', '/home/u/tools/npm_login.py'], cwd: '/home/u/project', ...extra
});
const setPd = (pending: unknown[]) => writeFileSync(join(fixture.dir, 'pd.json'), JSON.stringify({ pending }));
const talk = (session: string, items: Record<string, unknown>[]) =>
	writeFileSync(join(fixture.dir, 'transcripts', `${session}.jsonl`), items.map((item) => JSON.stringify(item) + '\n').join(''));
const tool = (ago: number, name: string, detail: string) => ({ kind: 'tool', time: iso(ago), name, label: '執行指令', detail, error: false });

beforeAll(async () => {
	fixture = await startFixture({ env: { LAT_BOARD_PD_SECONDS: '1' } });
	const luna = fixture.bound('lat', 'luna', { session_id: 's-luna' });
	const rana = fixture.bound('shop', 'rana', { session_id: 's-rana', client: 'codex' });
	fixture.list([luna, rana]);
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	talk('s-luna', [
		{ kind: 'user', text: '登入 npm', time: iso(600) },
		tool(100, 'Bash', 'ls /home/u/tools'),
		tool(90, 'Bash', 'pd run --item npm-s1 -- python3 /home/u/tools/npm_login.py'),
		{ kind: 'assistant', text: '等你核准 pd 請求。', time: iso(30) }
	]);
	talk('s-rana', [{ kind: 'user', text: '查一下帳號', time: iso(300) }, tool(60, 'exec', 'pd …'), { kind: 'assistant', text: '等核准。', time: iso(20) }]);
	cookie = await fixture.login();
}, 30_000);
afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

test.skipIf(!CHROME)('查看對話 opens the caller\'s conversation at its pd run, marks an unvouched one 可能不準, and falls back to the newest part', async () => {
	setPd([request(3, 90, 'luna', { caller_info: checked('luna', 'claude', true) }), request(4, 60, 'rana', { caller_info: checked('rana', 'codex', false) }), request(5, 10, 'codex')]);
	browser = await launchChrome({ screen: SCREEN });
	const tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
	await tab.navigate(`${fixture.url}/`);
	await tab.until(`document.querySelectorAll('.inbox .pd .card').length === 3`, 'the pd cards');
	const look = (id: number) => `.pd [data-pd-request="${id}"] button.look`;
	// Only for callers the board knows; an unvouched one says the step may not be the right one.
	expect(await tab.eval(`[3, 4, 5].map((id) => !!document.querySelector('.pd [data-pd-request="' + id + '"] button.look'))`)).toEqual([true, true, false]);
	expect(await tab.eval(`document.querySelector('${look(4)}').title`)).toBe('可能不準：pd 沒有查證呼叫者');

	const HIT = `(() => { const hit = document.querySelector('section.detail [data-pd-hit]'); if (!hit) return null; const r = hit.getBoundingClientRect(); return { text: hit.textContent, inView: r.top >= 0 && r.bottom <= innerHeight }; })()`;
	await tab.pointerClick(look(3));
	await tab.until(`location.search.includes('controller=') && !!document.querySelector('section.detail [data-pd-hit]')`, 'luna\'s pd run marked');
	expect(await tab.eval(HIT)).toEqual({ text: expect.stringMatching(/執行指令：pd run --item npm-s1 -- python3 \/home\/u\/tools\/npm_login\.py$/), inView: true });

	await tab.pointerClick(look(4));
	await tab.until(`!!document.querySelector('section.detail [data-pd-hit] .unsure')`, 'rana\'s pd run marked 可能不準');
	expect(await tab.eval<{ text: string }>(HIT)).toMatchObject({ text: expect.stringContaining('pd …可能不準'), inView: true });

	// Made long before any pd run in the conversation: the newest part, and a word why.
	setPd([request(6, 3000, 'luna', { caller_info: checked('luna', 'claude', true) })]);
	await tab.until(`!!document.querySelector('${look(6)}')`, 'the card for #6');
	await tab.pointerClick(look(6));
	await tab.until(`[...document.querySelectorAll('.toast')].some((toast) => toast.innerText.includes('對話裡找不到這次 pd 請求的那一步，先顯示最新的部分。'))`, 'the notice');
	expect(await tab.eval(`!!document.querySelector('section.detail [data-pd-hit]')`)).toBe(false);
	expect(tab.errors).toEqual([]);
}, 30_000);
