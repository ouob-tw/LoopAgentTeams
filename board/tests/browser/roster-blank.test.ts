// Clicking the blank of the roster, folded or unfolded, changes nothing; the fold and unfold buttons
// still work. In a real browser: headless Chrome driven over its DevTools protocol, on the built
// board with fake data. Skipped when the host has no Chrome.
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
	const cookie = await fixture.login('roster-blank');
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

/** A point on the roster's own surface, below its marks or cards and clear of the controls at its foot. */
const BLANK = `(() => {
	const column = document.querySelector('.roster').getBoundingClientRect();
	const x = column.left + 3;
	for (let y = column.top + 8; y < column.bottom; y += 2) {
		const el = document.elementFromPoint(x, y);
		if (el && el.closest('.roster') && !el.closest('button, a, .entry, .person, .resize')) return { x, y };
	}
	return null;
})()`;

async function clickBlank() {
	const point = await evaluate<{ x: number; y: number } | null>(BLANK);
	expect(point).not.toBeNull();
	for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
		await send('Input.dispatchMouseEvent', { type, x: point!.x, y: point!.y, button: 'left', clickCount: 1 });
	}
	// Let a click handler, had there been one, run.
	await evaluate(`new Promise((resolve) => setTimeout(resolve, 200))`);
}

const state = () => evaluate<string | undefined>(`document.documentElement.dataset.roster`);
const saved = () => evaluate<string | null>(`localStorage.getItem(${JSON.stringify(FOLDED_KEY)})`);

test.skipIf(!CHROME)('clicking the blank of the folded rail does not unfold it, and the unfold button still does', async () => {
	await visit(true);
	await until(`document.querySelectorAll('.rail .entry').length >= 3 && document.querySelector('.rail .entry').getBoundingClientRect().width >= 30`);
	expect(await state()).toBe('folded');
	await clickBlank();
	expect(await state()).toBe('folded');
	expect(await saved()).toBe('1');
	await browser!.tab.pointerClick('.rail .grip');
	await until(`document.documentElement.dataset.roster !== 'folded'`);
});

test.skipIf(!CHROME)('clicking the blank of the unfolded roster does not fold it, and the fold button still does', async () => {
	await visit(false);
	await until(`document.querySelectorAll('.people .person').length >= 3 && document.querySelector('.people .person').getBoundingClientRect().width >= 100`);
	expect(await state()).not.toBe('folded');
	await clickBlank();
	expect(await state()).not.toBe('folded');
	expect(await saved()).toBe('0');
	await browser!.tab.pointerClick('.tool.fold');
	await until(`document.documentElement.dataset.roster === 'folded'`);
});
