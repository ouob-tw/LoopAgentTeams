// A 390px phone at 150% zoom is 260 CSS px wide: the answer card's boxes take the whole card width
// with the mic under them, no sideways scrolling, and a long controller name is cut with an
// ellipsis before the buttons at the top right.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { question, startFixture, type Fixture } from '../harness.ts';
import { fakeMic, launchChrome, type Browser } from '../browser.ts';

let fixture: Fixture;
let browser: Browser;
const tab = () => browser.tab;

beforeAll(async () => {
	fixture = await startFixture();
	fixture.setClock(Date.parse('2026-10-20T02:00:00.000Z'));
	const cookie = await fixture.login('mobile-150');
	const options = [
		{ letter: 'A', label: '合併', impact: '一致。', recommended: true },
		{ letter: 'B', label: '先不合併', impact: '等下一輪。', recommended: false }
	];
	const controller = fixture.bound('LoopAgentTeams-with-a-very-long-project-name', 'rana', {
		session_id: 's-150',
		questions: [question({ id: 'Q-1', title: '怎麼併入？', kind: 'single', options, asked_at: '2026-10-20T01:00:00.000Z' })]
	});
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', 's-150.jsonl'), JSON.stringify({ kind: 'assistant', time: '2026-10-20T01:00:30.000Z', text: '請確認。' }) + '\n');
	fixture.report(controller.session_id, { tag: 'DECIDE', summary: '等你決定', message: '請確認。', hcom_name: 'rana', workspace: controller.workspace, time: '2026-10-20T01:00:31.000Z' });
	fixture.setHelper({ output: { controllers: [controller] } });
	await fixture.refresh(cookie);
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

for (const width of [260, 390]) {
	test(`${width}px: 其他 and 備註 fill the card, the mic sits under them; the long name stops before the buttons`, async () => {
		await tab().send('Emulation.setDeviceMetricsOverride', { width, height: 700, deviceScaleFactor: 1, mobile: true });
		await tab().navigate(`${fixture.url}/?controller=s-150`);
		await tab().until(`!!document.querySelector('.topbar .whose strong')`, 'the top bar');
		await tab().eval(fakeMic('好', []));
		// The name is cut with an ellipsis and ends before the buttons.
		expect(
			await tab().eval(`(() => {
				const name = document.querySelector('.topbar .whose').getBoundingClientRect();
				const strong = document.querySelector('.topbar .whose strong');
				const tools = document.querySelector('.topbar .tools').getBoundingClientRect();
				return strong.scrollWidth > strong.clientWidth && getComputedStyle(strong).textOverflow === 'ellipsis' && name.right <= tools.left;
			})()`)
		).toBe(true);
		await tab().eval(`document.querySelector('form.answer') || [...document.querySelectorAll('a,button')].find((element) => element.textContent.includes('作答'))?.click()`);
		await tab().until(`!!document.querySelector('form.answer')`, 'the answer form');
		await tab().eval(`[...document.querySelectorAll('label')].find((label) => label.textContent.trim() === '其他')?.querySelector('input')?.click()`);
		await tab().until(`!!document.querySelector('textarea[aria-label="其他的內容"]')`, 'the 其他 box');
		const fit = await tab().eval<{ widths: number[]; low: boolean[]; fits: boolean }>(`(() => {
			const boxes = [...document.querySelectorAll('textarea:not([aria-label^="指令列"])')];
			return {
				widths: boxes.map((box) => Math.round(box.parentElement.getBoundingClientRect().width - box.getBoundingClientRect().width)),
				low: boxes.map((box) => box.parentElement.querySelector('.mic').getBoundingClientRect().top >= box.getBoundingClientRect().bottom),
				fits: document.documentElement.scrollWidth <= innerWidth
			};
		})()`);
		expect(fit.widths.length).toBe(2);
		// Each box is as wide as the space its field gives it (a hair for borders), mic below it.
		for (const gap of fit.widths) expect(Math.abs(gap)).toBeLessThanOrEqual(1);
		expect(fit.low).toEqual([true, true]);
		expect(fit.fits).toBe(true);
	}, 30_000);
}
