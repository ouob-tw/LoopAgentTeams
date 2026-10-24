// The launch form's drop-downs look like its text boxes: same font, colour, background, border,
// radius and height, a theme-coloured arrow, and the same disabled look, in both themes and at
// desktop and phone width. In a real browser: headless Chrome over its DevTools protocol, on the
// built board. Skipped when the host has no Chrome.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { sleep, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser } from '../browser.ts';

let fixture: Fixture;
let browser: Browser | undefined;

const send = (method: string, params: object = {}) => browser!.tab.send(method, params);
const evaluate = <T>(expression: string) => browser!.tab.eval<T>(expression);
const until = (expression: string) => browser!.tab.until(expression, expression);

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	const cookie = await fixture.login('select-style');
	await fixture.refresh(cookie);
	browser = await launchChrome();
	const [name, value] = cookie.split('=');
	await send('Network.setCookie', { name, value, url: fixture.url });
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

const PROPS = ['fontFamily', 'fontSize', 'color', 'backgroundColor', 'borderTopColor', 'borderTopWidth', 'borderTopStyle', 'borderTopLeftRadius', 'height', 'opacity'];
/** The computed look of the first drop-down of the form, and of a text box put beside it in the same label. */
const LOOK = (disabled: boolean) => `(() => {
	const select = document.querySelector('.settings select');
	const folder = document.querySelector('#folder-box');
	const box = select.parentElement.appendChild(document.createElement('input'));
	select.disabled = ${disabled};
	box.disabled = ${disabled};
	const read = (element) => Object.fromEntries(${JSON.stringify(PROPS)}.map((name) => [name, getComputedStyle(element)[name]]));
	const own = getComputedStyle(select);
	const look = { select: read(select), box: read(box) };
	box.remove();
	select.disabled = false;
	return JSON.stringify({ ...look, folderHeight: getComputedStyle(folder).height, selectHeights: [...document.querySelectorAll('select')].map((one) => getComputedStyle(one).height), appearance: own.appearance, arrow: own.backgroundImage, option: getComputedStyle(select.options[0]).color + '|' + getComputedStyle(select.options[0]).backgroundColor });
})()`;

for (const theme of ['dark', 'light']) {
	for (const [label, width, mobile] of [['desktop', 1200, false], ['phone', 390, true]] as const) {
		test.skipIf(!CHROME)(`the form's drop-downs look like a text box: ${theme} theme, ${label} width`, async () => {
			await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile });
			await send('Page.navigate', { url: `${fixture.url}/?launch` });
			await until(`!!document.querySelector('.settings select')`);
			// Let hydration finish so it does not rebuild the form under the check.
			await sleep(500);
			await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
			for (const disabled of [false, true]) {
				const look = JSON.parse(await evaluate<string>(LOOK(disabled)));
				const { height: _selectHeight, fontSize: selectSize, ...select } = look.select;
				const { height: _boxHeight, fontSize: _boxSize, ...box } = look.box;
				expect(select).toEqual(box);
				expect(selectSize).toBe(await evaluate<string>(`getComputedStyle(document.querySelector('#folder-box')).fontSize`));
				// As tall as the folder box above it, which every drop-down of the form sits beside.
				for (const height of look.selectHeights) expect(Math.abs(parseFloat(height) - parseFloat(look.folderHeight))).toBeLessThan(2);
				expect(look.appearance).toBe('none');
				expect(look.arrow).toContain('linear-gradient');
				const [optionColor, optionBackground] = look.option.split('|');
				expect(optionBackground).not.toBe('rgba(0, 0, 0, 0)');
				expect(optionColor).not.toBe(optionBackground);
			}
			// No sideways scroll on the page.
			expect(await evaluate<boolean>(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`)).toBe(true);
			const shot = process.env.SELECT_SHOTS;
			if (shot) {
				const { data } = (await send('Page.captureScreenshot', { format: 'png' })) as { data: string };
				mkdirSync(shot, { recursive: true });
				writeFileSync(join(shot, `${theme}-${label}.png`), Buffer.from(data, 'base64'));
			}
		}, 30_000);
	}
}
