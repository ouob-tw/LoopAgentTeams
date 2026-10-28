// The pd 待核准 window in a real browser: headless Chrome driven over its DevTools protocol, on the
// built board with a fake pd (tests/fake-pd.mjs), at a phone's width and a desktop's. On a desktop it
// floats over the middle column on every list, and its heading drags it and its corner resizes it,
// kept in this browser and held on screen; on a phone it is a sheet over whatever screen is shown.
// 稍後 folds it to a badge, or on a phone's content screen to a strip under the bar. 核准 is a button
// that signs with a passkey in the page (tests/browser/pd-inline-approve.test.ts), with no link to
// pd's own approval page; 拒絕 denies through the board. Skipped when the host has no Chrome.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser } from '../browser.ts';

const SCREEN = `({ search: location.search, middle: document.querySelector('.inbox')?.innerText ?? '' })`;
// The caller's and the command's lines of a card end in an ellipsis when longer; everything else wraps.
const FITS = `document.documentElement.scrollWidth <= window.innerWidth && [...document.querySelectorAll('.inbox .pd, .inbox .pd *')].every((node) => node.closest('summary') || node.scrollWidth <= node.clientWidth + 1)`;

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;

const waiting = (id: number, item: string, extra: Record<string, unknown> = {}) => ({
	id,
	waiting: 5,
	caller: 'codex',
	item,
	item_id: `item-uuid-${id}`,
	fields: ['password', 'username'],
	argv: ['npm', 'publish', '--dry-run'],
	cwd: '/home/u/a-rather-long-folder-name/for-the-project-that-asks',
	approval_url: `https://pd.example.net/?request=${id}`,
	...extra
});
// What a script reads to tell whether something is drawn: a fixed element has no offsetParent.
const SHOWN = (selector: string) => `!!document.querySelector('${selector}')?.checkVisibility()`;
// The window shown and done arriving (it slides in a few px), so its box can be measured.
const SETTLED = `!!document.querySelector('.inbox .pd')?.checkVisibility() && document.querySelector('.inbox .pd').getAnimations().length === 0`;
const RECT = `(() => { const r = document.querySelector('.inbox .pd').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })()`;
const setPd = (state: unknown) => writeFileSync(join(fixture.dir, 'pd.json'), JSON.stringify(state));

beforeAll(async () => {
	fixture = await startFixture({ env: { LAT_BOARD_PD_SECONDS: '1' } });
	cookie = await fixture.login();
}, 30_000);
afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

test.skipIf(!CHROME)('requests come up as a sheet on a phone, with their time; 拒絕 denies; over a content screen 稍後 leaves a strip that opens it again; then a quiet line', async () => {
	const argv = ['/usr/bin/python3', '/home/u/tools/npm_login.py', '--registry', 'https://registry.npmjs.org'];
	// #4 comes with pd's check of its caller; #3 from a pd without it, by its declared name only.
	const checked = { name: 'dahe-t09-vafu', client: 'codex', group: 'dahe-t09', orchestrator: false, source: 'auto', pid: 4242, start_time: 98765, program: null, verified: false, notice: '程序樹查證，非防竄改' };
	setPd({ pending: [waiting(3, 'npm token', { remaining: 95, argv }), waiting(4, 'GitHub token', { caller: 'dahe-t09-vafu', caller_info: checked })] });
	browser = await launchChrome({ screen: SCREEN });
	const tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 900, deviceScaleFactor: 1, mobile: true });
	await tab.send('Page.navigate', { url: `${fixture.url}/` });
	await tab.until(`document.querySelectorAll('.inbox .pd .card').length === 2 && ${SETTLED}`, 'the pd cards');
	// A sheet the screen's width, resting on the command line, over the list; it does not move.
	expect(await tab.eval(`(() => {
		const sheet = document.querySelector('.inbox .pd').getBoundingClientRect();
		const dock = parseFloat(getComputedStyle(document.querySelector('.page')).getPropertyValue('--dock-h'));
		return sheet.left === 0 && Math.abs(sheet.width - innerWidth) <= 1 && Math.abs(sheet.bottom - (innerHeight - dock)) <= 1 && sheet.top > 0;
	})()`)).toBe(true);
	expect(await tab.eval(`!document.querySelector('.pd .grip') && !document.querySelector('.pd header.handle')`)).toBe(true);

	const card = (id: number) => `document.querySelector('.pd [data-pd-request="${id}"]')`;
	// Folded: the item, number, time and buttons, the caller on a line, and the command shortened on the next.
	const folded = await tab.eval<string>(`${card(3)}.innerText`);
	for (const text of ['npm token', '#3', 'python3 npm_login.py --registry …', '核准', '拒絕']) expect(folded).toContain(text);
	expect(await tab.eval<string>(`${card(3)}.querySelector('summary').textContent`)).toContain('codex（自稱） python3 npm_login.py --registry …');
	for (const text of ['/usr/bin/python3', '/home/u/a-rather-long-folder-name', '對方自稱']) expect(folded).not.toContain(text);
	expect(await tab.eval(`(() => {
		const [caller, command] = ['.caller', 'summary code'].map((part) => ${card(3)}.querySelector(part).getBoundingClientRect());
		return caller.height < 30 && command.height < 30 && command.top >= caller.bottom;
	})()`)).toBe(true);
	// A tap opens the whole command, the folder and the caller.
	await tab.pointerClick('.pd [data-pd-request="3"] summary');
	await tab.until(`${card(3)}.querySelector('details').open`, 'the details open');
	const first = await tab.eval<string>(`${card(3)}.innerText`);
	for (const text of ['password、username', argv.join(' '), '/home/u/a-rather-long-folder-name/for-the-project-that-asks', 'codex（對方自稱，未驗證）']) expect(first).toContain(text);
	// pd's check of the caller on the line, and what it is worth once opened.
	expect(await tab.eval<string>(`${card(4)}.querySelector('summary .who').textContent + ${card(4)}.querySelector('summary .mark').textContent`)).toBe('dahe-t09-vafu（codex，群組 dahe-t09）未通過查證');
	// Too long for a phone's line: the caller's name is cut short, its mark and the command stay whole.
	expect(await tab.eval(`(() => {
		const line = ${card(4)}.querySelector('summary');
		const whole = (part) => part.scrollWidth <= part.clientWidth + 1 && part.getBoundingClientRect().right <= line.getBoundingClientRect().right + 1;
		const who = line.querySelector('.who');
		return who.scrollWidth > who.clientWidth && whole(line.querySelector('.mark')) && whole(line.querySelector('code'));
	})()`)).toBe(true);
	expect(await tab.eval<string>(`${card(4)}.innerText`)).not.toContain('程序樹查證');
	// Below the sheet's fold: scrolled to, as a user would.
	await tab.eval(`document.querySelector('.pd [data-pd-request="4"] summary').scrollIntoView({ block: 'nearest' })`);
	await tab.pointerClick('.pd [data-pd-request="4"] summary');
	await tab.until(`${card(4)}.querySelector('details').open`, 'the details of #4 open');
	expect(await tab.eval<string>(`${card(4)}.innerText`)).toContain('dahe-t09-vafu（codex，群組 dahe-t09）未通過查證（程序樹查證，非防竄改）');
	expect(await tab.eval<string>(`${card(3)}.querySelector('.time').innerText`)).toMatch(/^剩 1:3\d$/);
	// A pd that gives no time left: how long it has waited instead.
	expect(await tab.eval<string>(`${card(4)}.querySelector('.time').innerText`)).toMatch(/^已等待 0:0\d$/);
	// Approval is here only: no link to pd's own page. This address is not under ouob.net, so the
	// window says once where the passkey works.
	expect(await tab.eval(`document.querySelectorAll('.pd a').length`)).toBe(0);
	expect(await tab.eval<string>(`document.querySelector('.pd .nopasskey').innerText`)).toBe('這個網址不能用 passkey 核准，請從 https://lat.ouob.net 開看板。');
	// Nothing on the section asks for a code.
	expect(await tab.eval(`document.querySelectorAll('.pd input, .pd form').length`)).toBe(0);
	expect(await tab.eval(`${card(3)}.querySelector('button.approve').innerText`)).toBe('核准');
	expect(await tab.eval(FITS)).toBe(true);

	await tab.eval(`${card(3)}.querySelector('button.deny').click()`);
	await tab.until(`document.querySelectorAll('.inbox .pd .card').length === 1`, 'the denied card gone');
	expect(JSON.parse(readFileSync(join(fixture.dir, 'pd.json'), 'utf8')).pending.map((request: { id: number }) => request.id)).toEqual([4]);
	expect(await tab.eval<string>(`document.body.innerText`)).toContain('已拒絕 pd 請求 #3（npm token）');

	// Over a content screen too, which hides the column; the window's title counts the requests.
	await tab.navigate(`${fixture.url}/?controller=gone`);
	await tab.until(`${SHOWN('.inbox .pd')} && ${SHOWN('section.detail')}`, 'the sheet over the content screen');
	expect(await tab.eval(`!!document.querySelector('.pd-banner')`)).toBe(false);
	// Set once the page has started, which may be just after the window shows.
	await tab.until(`document.title === '(1) LAT 看板'`, 'the count in the title');
	// 稍後 leaves a strip under the bar saying how many wait, covering none of the content.
	await tab.pointerClick('.pd button.later');
	await tab.until(`!document.querySelector('.inbox .pd') && ${SHOWN('.pd-banner')} && document.activeElement === document.querySelector('.pd-banner')`, 'the banner, focused');
	expect(await tab.eval<string>(`document.querySelector('.pd-banner').innerText`)).toMatch(/^pd 待核准\s+1\s+查看 ›$/);
	expect(await tab.eval(`document.querySelector('.topbar').nextElementSibling.getBoundingClientRect().top >= document.querySelector('.pd-banner').getBoundingClientRect().bottom - 1`)).toBe(true);
	// A new request opens the sheet again.
	setPd({ pending: [...JSON.parse(readFileSync(join(fixture.dir, 'pd.json'), 'utf8')).pending, waiting(5, 'npm s2')] });
	await tab.until(`${SHOWN('.inbox .pd [data-pd-request="5"]')} && !document.querySelector('.pd-banner')`, 'the sheet open for #5');
	expect(await tab.eval(`document.title`)).toBe('(2) LAT 看板');
	// The strip's tap opens it too, on the same screen.
	await tab.pointerClick('.pd button.later');
	await tab.until(SHOWN('.pd-banner'), 'the banner');
	await tab.pointerClick('.pd-banner');
	await tab.until(`document.activeElement === document.querySelector('.inbox .pd') && ${SHOWN('section.detail')}`, 'the sheet open again, focused');

	setPd({ pending: [] });
	// Nothing waiting: neither the window nor its badge.
	await tab.until(`!document.querySelector('.inbox .pd, .pd-badge')`, 'no pd window when nothing waits');
	expect(await tab.eval(`document.querySelector('.inbox > .middle-tabs').previousElementSibling`)).toBe(null);
	expect(await tab.eval(`document.title`)).toBe('LAT 看板');
	setPd({ pending: [], unavailable: true });
	await tab.until(`document.querySelector('.inbox .pd-off')?.innerText === 'pd 待核准：連不上 pd 服務'`, 'the quiet unavailable line');
	expect(await tab.eval(`!!document.querySelector('.inbox .pd')`)).toBe(false);
}, 30_000);

test.skipIf(!CHROME)('on a desktop the window floats over the middle column on every list, moves and resizes, keeps its place and stays on screen; 稍後 folds it to a badge, a new request opens it', async () => {
	const tab = browser!.tab;
	await tab.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
	setPd({ pending: [waiting(6, 'npm token')] });
	await tab.navigate(`${fixture.url}/`);
	await tab.until(`!!document.querySelector('.inbox .pd [data-pd-request="6"]') && ${SETTLED}`, 'the window');

	// At first over the middle column, from its top to the command line, on top of what is there.
	const DEFAULT = `(() => {
		const column = document.querySelector('section.inbox').getBoundingClientRect();
		const window = document.querySelector('.inbox .pd').getBoundingClientRect();
		const near = (a, b) => Math.abs(a - b) <= 2;
		return near(window.left, column.left + 8) && near(window.top, column.top + 8) && near(window.width, Math.max(360, column.width - 16)) && near(window.bottom, column.bottom - 8)
			&& document.elementFromPoint(window.left + window.width / 2, window.top + window.height / 2)?.closest('.pd') !== null
			&& !document.querySelector('.inbox .pd').getAttribute('style');
	})()`;
	expect(await tab.eval(DEFAULT)).toBe(true);
	// The same on the other lists, which the page switches behind it.
	for (const middle of ['agents', 'quota', 'inbox']) {
		await tab.eval(`document.querySelector('[data-middle="${middle}"]').click()`);
		await tab.until(`document.querySelector('[data-middle="${middle}"]').getAttribute('aria-pressed') === 'true'`, `the ${middle} list`);
		expect(await tab.eval(DEFAULT)).toBe(true);
	}

	// Its heading drags it and its corner resizes it; both are kept in this browser.
	const drag = async (selector: string, dx: number, dy: number) => {
		const { x, y } = await tab.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector('${selector}').getBoundingClientRect(); return { x: r.left + 6, y: r.top + r.height / 2 }; })()`);
		await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
		await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
		for (const step of [0.5, 1]) await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + dx * step, y: y + dy * step, button: 'left', buttons: 1 });
		await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button: 'left', buttons: 0, clickCount: 1 });
	};
	const start = await tab.eval<{ x: number; y: number; w: number; h: number }>(RECT);
	expect(await tab.eval(`getComputedStyle(document.querySelector('.pd header')).cursor`)).toBe('grab');
	await drag('.pd header h2', 200, 60);
	expect(await tab.eval(RECT)).toEqual({ ...start, x: start.x + 200, y: start.y + 60 });
	await drag('.pd .grip', 80, -100);
	const moved = { x: start.x + 200, y: start.y + 60, w: start.w + 80, h: start.h - 100 };
	expect(await tab.eval(RECT)).toEqual(moved);
	expect(JSON.parse(await tab.eval<string>(`localStorage.getItem('lat-board-pd-window')`))).toEqual(moved);
	await tab.navigate(`${fixture.url}/`);
	await tab.until(SETTLED, 'the window after a reload');
	expect(await tab.eval(RECT)).toEqual(moved);
	// A place off screen, or smaller than the window can be, is pulled back on screen at its smallest size.
	await tab.eval(`localStorage.setItem('lat-board-pd-window', JSON.stringify({ x: 5000, y: -300, w: 100, h: 50 }))`);
	await tab.navigate(`${fixture.url}/`);
	await tab.until(SETTLED, 'the window after a reload');
	expect(await tab.eval(RECT)).toEqual({ x: 1280 - 360, y: 0, w: 360, h: 200 });
	// 復位 puts it back over the column and forgets the place.
	await tab.pointerClick('.pd button.reset');
	await tab.until(`!document.querySelector('.pd button.reset') && localStorage.getItem('lat-board-pd-window') === null`, 'the default place back');
	expect(await tab.eval(DEFAULT)).toBe(true);

	// 稍後 folds it to a badge above the tabs, which opens it again.
	await tab.pointerClick('.pd button.later');
	await tab.until(`!document.querySelector('.inbox .pd') && document.querySelector('.inbox .pd-badge')?.innerText === 'pd 待核准 1' && document.activeElement === document.querySelector('.pd-badge')`, 'the badge, focused');
	expect(await tab.eval(`document.querySelector('.pd-badge').nextElementSibling.classList.contains('middle-tabs')`)).toBe(true);
	await tab.pointerClick('.pd-badge');
	await tab.until(`document.activeElement === document.querySelector('.inbox .pd') && !document.querySelector('.pd-badge')`, 'the window open again, focused');

	// Folded, a new request opens it.
	await tab.pointerClick('.pd button.later');
	await tab.until(`!!document.querySelector('.pd-badge')`, 'the badge');
	setPd({ pending: [waiting(6, 'npm token'), waiting(7, 'GitHub token')] });
	await tab.until(`!!document.querySelector('.inbox .pd [data-pd-request="7"]')`, 'the window open for #7');

	// A content screen leaves the column, badge and all, on screen: no banner once folded either.
	await tab.navigate(`${fixture.url}/?controller=gone`);
	await tab.until(SHOWN('.inbox .pd'), 'the window beside the content screen');
	await tab.pointerClick('.pd button.later');
	await tab.until(SHOWN('.pd-badge'), 'the badge');
	expect(await tab.eval(SHOWN('.pd-banner'))).toBe(false);

	setPd({ pending: [] });
	await tab.until(`!document.querySelector('.inbox .pd, .pd-badge')`, 'no pd window when nothing waits');
	expect(tab.errors).toEqual([]);
}, 30_000);
