// The model and effort picker under the box has the small corners of the board's other buttons, its
// frame and every part inside, not a pill's round ends; a chosen model's and effort's names are not
// cut at a phone's width with the largest smallest-text size. The buttons and boxes around it keep
// the corners they had. Both themes, on a phone and a wide screen, for a closed controller's picker
// (names picked to wake it with) and an agent's. Headless Chrome over its DevTools protocol, on the
// built board with fake data. Skipped when the host has no Chrome.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { MIN_FONT } from '../../src/lib/board/prefs.ts';
import { sleep, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser } from '../browser.ts';

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
const tab = () => browser!.tab;

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	cookie = await fixture.login('picker-shape');
	const lead = fixture.bound('lat', 'lead', { session_id: 's-lead' });
	fixture.list([lead]);
	// Closed: its picker offers the models and efforts to wake it with.
	fixture.setHcom({ agents: [] });
	fixture.report('s-lead', { tag: 'DONE', summary: '好了', hcom_name: 'lead', workspace: lead.workspace });
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', 's-plain.jsonl'), JSON.stringify({ kind: 'assistant', time: null, text: 'Done.' }) + '\n');
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents: [{ agent: 'codex', agent_session: { kind: 'id', value: 's-plain' }, agent_status: 'idle', cwd: '/work', pane_id: 'wA:p-s-plain', tab_id: 'wA:t-s-plain', workspace_id: 'wA' }],
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
			tabs: [{ tab_id: 'wA:t-s-plain', workspace_id: 'wA', label: 'plain' }]
		})
	);
	await fixture.refresh(cookie);
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

type Corner = { name: string; w: number; h: number; radius: number[] };
/** The four corners and size of each element the selector finds, drawn ones only. */
const corners = (selector: string) => `[...document.querySelectorAll(${JSON.stringify(selector)})].filter((element) => element.getBoundingClientRect().height).map((element) => {
	const r = element.getBoundingClientRect();
	const s = getComputedStyle(element);
	return { name: element.className + ' ' + (element.getAttribute('aria-label') ?? element.textContent.trim()), w: r.width, h: r.height, radius: ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'].map((side) => parseFloat(s[side])) };
})`;
const SMALL = `parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--radius'))`;

/** Buttons and boxes around the picker and the corners they had before it changed. The send button
 *  is a square only with its arrow, not while it says 喚醒 to a closed controller. */
const KEPT: [selector: string, radius: string][] = [
	['.cmd .attach-slot button', 'var(--radius)'],
	['.cmd .voice-slot button', 'var(--radius)'],
	['.cmd textarea', 'var(--radius)'],
	['.cmd .send.square', 'calc(var(--radius) - 2px)'],
	['.cmd .send:not(.square)', 'var(--radius)'],
	['button.translate', '6px'],
	['[role="tab"]', '0px']
];

for (const theme of ['dark', 'light'] as const) {
	for (const [label, width, minFont] of [
		['phone, largest smallest text', 390, MIN_FONT.max],
		['wide screen', 1280, 0]
	] as const) {
		test.skipIf(!CHROME)(`${theme} theme, ${label}: the picker has small corners and whole names, the rest keeps its corners`, async () => {
			await browser?.close();
			browser = await launchChrome({
				screen: `location.search + ' ' + document.body.innerText.slice(0, 1500)`,
				scripts: [`localStorage.setItem('lat-board-theme', '${theme}')`, `localStorage.setItem('lat-board-voice', '1')`, ...(minFont ? [`localStorage.setItem('lat-board-min-font', '${minFont}')`] : [])]
			});
			const [name, value] = cookie.split('=');
			await tab().send('Network.setCookie', { name, value, url: fixture.url });
			await tab().send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width <= 760 });
			for (const search of ['?controller=s-lead', '?agent=s-plain']) {
				await tab().navigate(`${fixture.url}/${search}`);
				await tab().until(`!!document.querySelector('.pill-slot .picker .part')?.getBoundingClientRect().height && !!document.querySelector('[role="tab"]')`, `the picker on ${search}`);
				// Let hydration finish so it does not rebuild the line under the check.
				await sleep(400);
				// On the controller's page, pick a model and an effort so the parts hold real names.
				for (const part of search.startsWith('?controller') ? [0, 1] : []) {
					await tab().until(
						`!!document.querySelector('.pill-slot .picker .menu') || (document.querySelectorAll('.pill-slot .picker .part')[${part}].click(), false)`,
						`the menu of part ${part}`
					);
					await tab().eval(`[...document.querySelectorAll('.pill-slot .picker .menu [role="menuitemradio"]')].at(-1).click()`);
					await tab().until(`!document.querySelector('.pill-slot .picker .menu')`, 'the menu closed');
				}
				await sleep(200);
				expect(await tab().eval<string>(`document.documentElement.dataset.theme`)).toBe(theme);
				const small = await tab().eval<number>(SMALL);
				const picker = await tab().eval<Corner[]>(corners('.pill-slot .picker, .pill-slot .picker button'));
				// The frame and the two parts at least.
				expect(picker.length).toBeGreaterThanOrEqual(3);
				for (const one of picker) {
					const what = `${theme} ${width}px ${search} ${one.name} (${one.w.toFixed(1)}×${one.h.toFixed(1)})`;
					expect(one.radius, what).toEqual([small, small, small, small]);
					// Small, not round ends: the corners stop well short of half its height.
					expect(small, what).toBeLessThan(one.h / 2);
				}
				// The names in full: nothing cut off by the part's width or height.
				const parts = await tab().eval<{ text: string; cut: boolean }[]>(
					`[...document.querySelectorAll('.pill-slot .picker .part')].map((part) => ({ text: part.textContent, cut: part.scrollWidth > part.clientWidth + 1 || part.scrollHeight > part.clientHeight + 1 }))`
				);
				for (const part of parts) expect(part.cut, `${theme} ${width}px ${search} "${part.text}" is cut`).toBe(false);
				if (search.startsWith('?controller')) expect(parts.map((part) => part.text.trim()).join(' ')).not.toBe('模型 強度');
				for (const [selector, radius] of KEPT) {
					const want = await tab().eval<number>(
						`(() => { const probe = document.body.appendChild(document.createElement('div')); probe.style.borderRadius = ${JSON.stringify(radius)}; const value = parseFloat(getComputedStyle(probe).borderTopLeftRadius); probe.remove(); return value; })()`
					);
					const found = await tab().eval<Corner[]>(corners(selector));
					if (!selector.startsWith('.cmd .send')) expect(found.length, `${search}: ${selector}`).toBeGreaterThan(0);
					for (const one of found) expect(one.radius, `${theme} ${width}px ${search} ${selector}`).toEqual([want, want, want, want]);
				}
				const shots = process.env.PICKER_SHAPE_SHOTS;
				if (shots) {
					const { data } = (await tab().send('Page.captureScreenshot', { format: 'png' })) as { data: string };
					mkdirSync(shots, { recursive: true });
					writeFileSync(join(shots, `${theme}-${width}-${search.slice(1, search.indexOf('='))}.png`), Buffer.from(data, 'base64'));
				}
			}
		}, 60_000);
	}
}
