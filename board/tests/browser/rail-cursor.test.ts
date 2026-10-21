// The blank of the roster shows the expand or collapse cursor, so the pointer must never cross it
// between two neighbouring marks or cards. In a real browser: headless Chrome driven over its
// DevTools protocol, on the built board with fake data. Skipped when the host has no Chrome.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { FOLDED_KEY } from '../../src/lib/board/prefs.ts';
import { question, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser } from '../browser.ts';

let fixture: Fixture;
let browser: Browser | undefined;

const send = (method: string, params: object = {}) => browser!.tab.send(method, params);
const evaluate = <T>(expression: string) => browser!.tab.eval<T>(expression);
const until = (expression: string) => browser!.tab.until(expression);

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	const cookie = await fixture.login('rail-cursor');
	// One controller waiting for the user, then two at work: two runs, with a line between them.
	const [luna, sol, vega] = ['luna', 'sol', 'vega'].map((name) => fixture.bound('alpha', name, name === 'luna' ? { questions: [question()] } : {}));
	fixture.report(luna.session_id, { tag: 'HELP', summary: '需要你看一下', hcom_name: 'luna', workspace: luna.workspace });
	fixture.list([luna, sol, vega]);
	await fixture.refresh(cookie);
	browser = await launchChrome();
	const [name, value] = cookie.split('=');
	await send('Network.setCookie', { name, value, url: fixture.url });
	await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

/** The board with its roster folded or unfolded, as the device's saved setting says. */
async function visit(folded: boolean) {
	await send('Page.navigate', { url: `${fixture.url}/user.css` });
	await until(`location.pathname === '/user.css'`);
	await evaluate(`localStorage.setItem(${JSON.stringify(FOLDED_KEY)}, ${folded ? "'1'" : "'0'"})`);
	await send('Page.navigate', { url: fixture.url });
}

/** What is under each point of the line between the centres of the `from`th and `to`th
 *  `selector`s: the pointer going from one to the other must be over nothing but those two. */
const under = (selector: string, from = 0, to = 1) => `(() => {
	const all = [...document.querySelectorAll(${JSON.stringify(selector)})];
	const [a, b] = [all[${from}], all[${to}]];
	const [top, bottom] = [a, b].map((el) => el.getBoundingClientRect());
	const x = (top.left + top.right) / 2;
	const seen = new Set();
	for (let y = (top.top + top.bottom) / 2; y <= (bottom.top + bottom.bottom) / 2; y += 0.5) {
		const hit = document.elementFromPoint(x, y)?.closest(${JSON.stringify(selector)});
		seen.add(hit === a ? 'first' : hit === b ? 'second' : 'blank');
	}
	return [...seen].sort();
})()`;

/** Which items `selector` matches the pointer is over at each point of the line through the middle
 *  of every item, from the left edge of the roster to the right edge: the item itself, or, in
 *  the last 5px, the handle that resizes the column and has a cursor of its own. */
const across = (selector: string) => `(() => {
	const column = document.querySelector('.roster').getBoundingClientRect();
	const scrollbar = document.querySelector('.roster').offsetWidth - document.querySelector('.roster').clientWidth;
	const left = column.left + 1;
	const right = column.right - scrollbar - 5;
	const blank = [];
	document.querySelectorAll(${JSON.stringify(selector)}).forEach((item, index) => {
		const box = item.getBoundingClientRect();
		const y = (box.top + box.bottom) / 2;
		for (let x = left; x <= right; x += 1) {
			if (document.elementFromPoint(x, y)?.closest(${JSON.stringify(selector)}) !== item) blank.push(index + '@' + x);
		}
	});
	return blank;
})()`;

test.skipIf(!CHROME)('moving between marks of the folded rail never crosses the blank, within a run or across the line between runs', async () => {
	await visit(true);
	await until(`document.querySelectorAll('.rail .entry').length >= 3 && document.querySelector('.rail .entry').getBoundingClientRect().width >= 30`);
	expect(await evaluate(`document.querySelectorAll('.rail .sep').length`)).toBe(1);

	expect(await evaluate(under('.rail .entry', 0, 1))).toEqual(['first', 'second']);
	expect(await evaluate(under('.rail .entry', 1, 2))).toEqual(['first', 'second']);
	// Beside a mark, out to both edges of the rail, is that mark too.
	expect(await evaluate(across('.rail .entry'))).toEqual([]);
	// The column behind the rail's scrollbar and below its first screen has the rail's colour, not the page's.
	expect(await evaluate(`getComputedStyle(document.querySelector('.roster')).backgroundColor`)).toBe(
		await evaluate(`getComputedStyle(document.querySelector('.rail')).backgroundColor`)
	);
});

test.skipIf(!CHROME)('moving between cards of the unfolded roster never crosses the blank, within a run or across the line between runs', async () => {
	await visit(false);
	await until(`document.querySelectorAll('.people .person').length >= 3 && document.querySelector('.people .person').getBoundingClientRect().width >= 100`);
	expect(await evaluate(`document.querySelectorAll('.people .sep').length`)).toBe(1);

	expect(await evaluate(under('.people .person', 0, 1))).toEqual(['first', 'second']);
	expect(await evaluate(under('.people .person', 1, 2))).toEqual(['first', 'second']);
	// Beside a card, out to both edges of the roster's column, is that card too.
	expect(await evaluate(across('.people .person'))).toEqual([]);
});
