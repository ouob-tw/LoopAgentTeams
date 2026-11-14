// The two-step login page in a real browser (headless Chrome, the built board), wide and at a
// phone's width: password then TOTP code, a wrong code, a second step that ran out, and a board
// with no second step set. Every control stays whole inside the window. With LAT_BOARD_SHOTS set,
// each state is saved as a frame.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { PASSWORD, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, shot, type Browser, type Tab } from '../browser.ts';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const STEP_MS = 30_000;
const SIZES = [
	{ width: 1280, height: 800 },
	{ width: 390, height: 844 }
];

let browser: Browser | undefined;
let tab: Tab;
afterEach(async () => {
	await browser?.close();
	browser = undefined;
});

async function open(fixture: Fixture, size: { width: number; height: number }, scripts: string[] = []) {
	browser = await launchChrome({ scripts });
	tab = browser.tab;
	tab.screen = `document.querySelector('main')?.innerText`;
	await tab.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: size.width < 761 });
	await tab.navigate(`${fixture.url}/login`);
	// SvelteKit writes its history entry once it has taken over the page: only then does a click run the page's code.
	await tab.until(`document.querySelector('main h1') !== null && JSON.stringify(history.state ?? {}).includes('sveltekit:')`, 'the login page to start');
}

async function typeInto(selector: string, text: string) {
	await tab.eval(`(() => { const box = document.querySelector(${JSON.stringify(selector)}); box.focus(); box.select(); })()`);
	await tab.send('Input.insertText', { text });
}

/** Whatever is wrong with the layout: a page wider than the window, a control not wholly inside
 *  it, or text cut inside its own box. Empty when it is right. */
const LAYOUT_PROBLEMS = `(() => {
	const problems = [];
	const width = document.documentElement.clientWidth;
	if (document.documentElement.scrollWidth > width) problems.push('page wider than the window: ' + document.documentElement.scrollWidth + ' > ' + width);
	for (const element of document.querySelectorAll('main button, main input, main label, main p, main li, main pre')) {
		const r = element.getBoundingClientRect();
		if (!r.width) continue;
		const name = element.tagName + ' ' + (element.textContent || element.id).trim().slice(0, 20);
		if (r.left < 0 || r.right > width + 0.5 || r.top < 0) problems.push(name + ' outside the window');
		if (element.tagName !== 'INPUT' && element.scrollWidth > element.clientWidth + 1) problems.push(name + ' cut off');
	}
	return problems;
})()`;

/** The steps as the page marks them: which is current and which is done. */
const STEPS = `[...document.querySelectorAll('.steps li')].map((li) => (li.getAttribute('aria-current') === 'step' ? 'current' : li.classList.contains('done') ? 'done' : 'todo') + ' ' + li.textContent.trim())`;
const FAILURE = `(document.querySelector('.failed')?.textContent.trim() ?? '')`;

describe('a board with a TOTP secret', () => {
	let fixture: Fixture;
	let time = T0;
	beforeAll(async () => {
		fixture = await startFixture();
		fixture.setClock(time);
	});
	afterAll(() => fixture?.cleanup());

	for (const size of SIZES) {
		test.skipIf(!CHROME)(`password, a wrong code, then the right code logs in (${size.width})`, async () => {
			fixture.setClock((time += STEP_MS));
			await open(fixture, size);
			expect(await tab.eval(STEPS)).toEqual(['current 1密碼', 'todo 2驗證碼']);
			expect(await tab.eval(LAYOUT_PROBLEMS)).toEqual([]);
			await shot(tab, `${size.width}-1-password`);

			await typeInto('#password', PASSWORD);
			await tab.pointerClick('form button.primary');
			await tab.until(`document.querySelector('#code') !== null`, 'the code step');
			expect(await tab.eval(`document.activeElement?.id`)).toBe('code');
			expect(await tab.eval(STEPS)).toEqual(['done 密碼', 'current 2驗證碼']);
			expect(await tab.eval(`document.querySelector('#code').getAttribute('autocomplete')`)).toBe('one-time-code');
			expect(await tab.eval(LAYOUT_PROBLEMS)).toEqual([]);
			await shot(tab, `${size.width}-2-code`);

			await typeInto('#code', fixture.totpCode(-5 * STEP_MS));
			await tab.pointerClick('form button.primary');
			await tab.until(`${FAILURE}.includes('驗證碼不正確')`, 'the wrong code message');
			// Still on the code step, the box emptied for the next try.
			expect(await tab.eval(`document.querySelector('#code').value`)).toBe('');
			expect(await tab.eval(LAYOUT_PROBLEMS)).toEqual([]);
			await shot(tab, `${size.width}-3-wrong-code`);

			await typeInto('#code', fixture.totpCode());
			await tab.pointerClick('form button.primary');
			await tab.until(`location.pathname === '/' && JSON.stringify(history.state).includes('depth')`, 'the board');
			expect(tab.errors).toEqual([]);
		});

		test.skipIf(!CHROME)(`a code sent after 5 minutes sends the browser back to the password (${size.width})`, async () => {
			fixture.setClock((time += STEP_MS));
			await open(fixture, size);
			await typeInto('#password', PASSWORD);
			await tab.pointerClick('form button.primary');
			await tab.until(`document.querySelector('#code') !== null`, 'the code step');

			fixture.setClock((time += 5 * 60 * 1000));
			await typeInto('#code', fixture.totpCode());
			await tab.pointerClick('form button.primary');
			await tab.until(`document.querySelector('#password') !== null && ${FAILURE}.includes('超過 5 分鐘')`, 'the password step again');
			expect(await tab.eval(STEPS)).toEqual(['current 1密碼', 'todo 2驗證碼']);
			expect(await tab.eval(`document.activeElement?.id`)).toBe('password');
			expect(await tab.eval(LAYOUT_PROBLEMS)).toEqual([]);
			await shot(tab, `${size.width}-4-timed-out`);
			expect(tab.errors).toEqual([]);
		});

		test.skipIf(!CHROME)(`the page itself goes back to the password when its 5 minutes run out (${size.width})`, async () => {
			fixture.setClock((time += STEP_MS));
			// Timers of a minute or more fire at once: the 5 minutes pass without waiting for them.
			await open(fixture, size, ['(() => { const set = window.setTimeout; window.setTimeout = (run, ms, ...rest) => set(run, ms >= 60000 ? 300 : ms, ...rest); })()']);
			await typeInto('#password', PASSWORD);
			await tab.pointerClick('form button.primary');
			await tab.until(`document.querySelector('#password') !== null && ${FAILURE}.includes('超過 5 分鐘')`, 'the password step again');
			expect(await tab.eval(STEPS)).toEqual(['current 1密碼', 'todo 2驗證碼']);
			expect(tab.errors).toEqual([]);
		});

		test.skipIf(!CHROME)(`"重新輸入密碼" goes back to the first step (${size.width})`, async () => {
			fixture.setClock((time += STEP_MS));
			await open(fixture, size);
			await typeInto('#password', PASSWORD);
			await tab.pointerClick('form button.primary');
			await tab.until(`document.querySelector('#code') !== null`, 'the code step');
			await tab.pointerClick('button.back');
			await tab.until(`document.querySelector('#password') !== null`, 'the password step');
			expect(await tab.eval(FAILURE)).toBe('');
		});
	}
});

describe('a board with no second step set', () => {
	let fixture: Fixture;
	beforeAll(async () => {
		fixture = await startFixture({ totp: null });
	});
	afterAll(() => fixture?.cleanup());

	for (const size of SIZES) {
		test.skipIf(!CHROME)(`the login page names the host command and offers no password box (${size.width})`, async () => {
			await open(fixture, size);
			expect(await tab.eval(`document.querySelector('main pre')?.textContent`)).toBe('bun run board totp');
			expect(await tab.eval(`document.querySelector('main p')?.textContent`)).toContain('請在主機的看板資料夾（board/）執行');
			expect(await tab.eval(`document.querySelector('input') === null`)).toBe(true);
			expect(await tab.eval(LAYOUT_PROBLEMS)).toEqual([]);
			await shot(tab, `${size.width}-5-no-second-step`);
			expect(tab.errors).toEqual([]);
		});
	}
});
