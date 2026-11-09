// The command line's layout in a real browser: headless Chrome on the built board with fake data,
// voice input unlocked so every control is there. A wide screen keeps one row; a phone gives the box
// a row of its own and puts the controls on the row under it, the model picker first and the button
// that puts the line away at the far right. Skipped when the host has no Chrome.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { sleep, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser } from '../browser.ts';

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let page = '';

const tab = () => browser!.tab;

type Box = { left: number; right: number; top: number; bottom: number; hit: boolean } | null;
/** Where each control is drawn, null when hidden, and whether a tap at its middle reaches it. */
const PLACES = `(() => {
	const place = (selector) => {
		const element = document.querySelector('.cmd ' + selector);
		if (!element) return null;
		const r = element.getBoundingClientRect();
		if (!r.width) return null;
		const at = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
		return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, hit: element.contains(at) };
	};
	return {
		to: place('.to'),
		attach: place('.attach-slot button'),
		voice: place('.voice-slot button'),
		box: place('textarea'),
		pill: place('.pill-slot .picker'),
		options: place('.options'),
		hide: place('.hide'),
		width: innerWidth,
		fits: document.documentElement.scrollWidth <= innerWidth
	};
})()`;
type Places = Record<'to' | 'attach' | 'voice' | 'box' | 'pill' | 'options' | 'hide', Box> & { width: number; fits: boolean };

async function visit(width: number) {
	await tab().send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width < 761 });
	await tab().navigate(`${fixture.url}/${page}`);
	await tab().until(`!!document.querySelector('.cmd .voice-slot button') && !!document.querySelector('.cmd .pill-slot .picker')`, 'the command line');
	return tab().eval<Places>(PLACES);
}

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	cookie = await fixture.login('command-line-layout');
	const luna = fixture.bound('proj', 'luna');
	fixture.report(luna.session_id, { tag: 'DONE', summary: '好了', hcom_name: 'luna', workspace: luna.workspace });
	fixture.list([luna]);
	await fixture.refresh(cookie);
	page = `?controller=${luna.session_id}`;
	browser = await launchChrome();
	const [name, value] = cookie.split('=');
	await tab().send('Network.setCookie', { name, value, url: fixture.url });
	await tab().navigate(`${fixture.url}/`);
	await tab().eval(`localStorage.setItem('lat-board-voice', '1')`);
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

test.skipIf(!CHROME)('a wide screen keeps one row: recipient, paperclip, mic, box, model and effort, then the rest', async () => {
	const at = await visit(1280);
	expect(at.hide).toBeNull();
	const row = [at.to, at.attach, at.voice, at.box, at.pill, ...(at.options ? [at.options] : [])] as NonNullable<Box>[];
	for (const [index, box] of row.entries()) {
		expect(box).not.toBeNull();
		if (index) expect(box.left).toBeGreaterThanOrEqual(row[index - 1].right);
		// One row: each overlaps the box's height.
		expect(box.top).toBeLessThan(at.box!.bottom);
		expect(box.bottom).toBeGreaterThan(at.box!.top);
	}
	expect(at.fits).toBe(true);
});

for (const width of [360, 390]) {
	test.skipIf(!CHROME)(`${width}px: the box alone on top; model and effort, paperclip, mic, the rest, and put away at the far right`, async () => {
		const at = await visit(width);
		// No recipient for the open controller, and the box takes the whole row.
		expect(at.to).toBeNull();
		expect(at.box!.right - at.box!.left).toBeGreaterThan(width * 0.9);
		const row = [at.pill, at.attach, at.voice, ...(at.options ? [at.options] : []), at.hide] as NonNullable<Box>[];
		for (const [index, box] of row.entries()) {
			expect(box).not.toBeNull();
			expect(box.hit).toBe(true);
			expect(box.top).toBeGreaterThanOrEqual(at.box!.bottom);
			if (index) expect(box.left).toBeGreaterThanOrEqual(row[index - 1].right);
		}
		// One row under the box, put away at its right edge.
		expect(Math.max(...row.map((box) => box.top))).toBeLessThan(Math.min(...row.map((box) => box.bottom)));
		expect(at.hide!.right).toBeGreaterThan(width - 24);
		expect(at.fits).toBe(true);
		// Put away, then brought back.
		await tab().eval(`document.querySelector('.cmd .hide').click()`);
		const shown = (selector: string) => `!!document.querySelector('${selector}')?.getBoundingClientRect().height`;
		await tab().until(`!${shown('.cmd')} && ${shown('.reopen')}`, 'the line put away');
		await tab().eval(`document.querySelector('.reopen').click()`);
		await tab().until(shown('.cmd textarea'), 'the line back');
	});
}

// More than fits: a long model name and the options button showing. The row stays one line and
// scrolls sideways, the put-away button stays at the far right, and an open menu is not cut off.
const SCROLLER = `(() => {
	let s = document.querySelector('.cmd .pill-slot .picker .part').parentElement;
	while (s && s !== document.body && s.scrollWidth <= s.clientWidth) s = s.parentElement;
	return s && s.closest('.cmd') ? s : null;
})()`;
for (const width of [360, 390]) {
	test.skipIf(!CHROME)(`${width}px: too much for the row stays one line, scrolls, keeps put away at the right, menus whole`, async () => {
		// A controller that is not running: its model picker lists the models to wake it with.
		fixture.setHcom({ agents: [] });
		await fixture.refresh(cookie);
		try {
			await visit(width);
			// Let hydration finish so it does not rebuild the line under the check.
			await sleep(400);
			await tab().eval(`(() => {
				document.querySelector('.cmd .pill-slot .picker .part').textContent = 'claude-opus-4-7-with-a-very-long-model-name';
				document.querySelector('.cmd .options').classList.remove('idle');
			})()`);
			const sample = () => tab().eval<Places & { scrolls: boolean; menu: Box }>(`(() => {
				const base = ${PLACES};
				const menu = document.querySelector('.cmd .picker .menu');
				let menuBox = null;
				if (menu) {
					const r = menu.getBoundingClientRect();
					const at = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
					menuBox = { left: r.left, right: r.right, top: r.top, bottom: r.bottom, hit: menu.contains(at) };
				}
				return { ...base, scrolls: ${SCROLLER} !== null, menu: menuBox };
			})()`);
			const start = await sample();
			const row = [start.pill, start.attach, start.voice, start.options, start.hide] as NonNullable<Box>[];
			for (const box of row) expect(box).not.toBeNull();
			// One line under the box, even though it cannot all be seen at once.
			expect(Math.max(...row.map((box) => box.top))).toBeLessThan(Math.min(...row.map((box) => box.bottom)));
			expect(Math.min(...row.map((box) => box.top))).toBeGreaterThanOrEqual(start.box!.bottom);
			expect(start.hide!.right).toBeGreaterThan(width - 24);
			expect(start.hide!.hit).toBe(true);
			expect(start.scrolls).toBe(true);
			expect(start.fits).toBe(true);
			// Scrolled to the end: the rest can be tapped, put away has not moved.
			await tab().eval(`(() => { const s = ${SCROLLER}; s.scrollLeft = s.scrollWidth; })()`);
			const end = await sample();
			expect(end.options!.hit).toBe(true);
			expect(end.options!.right).toBeLessThanOrEqual(end.hide!.left);
			expect(end.hide!.left).toBe(start.hide!.left);
			expect(end.hide!.hit).toBe(true);
			// The model menu, opened from the row, is drawn whole and can be reached.
			await tab().eval(`(() => { const s = ${SCROLLER}; s.scrollLeft = 0; })()`);
			await tab().until(`!!document.querySelector('.cmd .picker .menu') || (document.querySelector('.cmd .pill-slot .picker .part').click(), false)`, 'the model menu');
			const open = await sample();
			expect(open.menu!.left).toBeGreaterThanOrEqual(0);
			expect(open.menu!.right).toBeLessThanOrEqual(width);
			expect(open.menu!.top).toBeGreaterThanOrEqual(0);
			expect(open.menu!.bottom).toBeLessThanOrEqual(open.pill!.top);
			expect(open.menu!.hit).toBe(true);
		} finally {
			rmSync(join(fixture.dir, 'hcom.json'), { force: true });
			await fixture.refresh(cookie);
		}
	});
}

// A controller at work that Herdr does not list: no wake and no permission, so nothing to open.
for (const width of [1280, 390]) {
	test.skipIf(!CHROME)(`${width}px: a controller Herdr does not list, not woken, has nothing behind the options button`, async () => {
		const at = await visit(width);
		if (width > 760) expect(await tab().eval(`document.querySelector('.cmd .options').disabled`)).toBe(true);
		else expect(at.options).toBeNull();
		await tab().eval(`document.querySelector('.cmd .options').click()`);
		expect(await tab().eval(`!!document.querySelector('.cmd .popup')`)).toBe(false);
	});
}
