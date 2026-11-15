// The picker joined to each mic, in a real browser on the built board with a fake mic that lists
// microphones: the menu lists them, the choice reaches the recording request, is shared by the
// command line and the answer boxes, survives a reload, falls back when the microphone is gone,
// and does not appear while voice input is off.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { question, startFixture, type Fixture } from '../harness.ts';
import { fakeMic, launchChrome, shot, speak, type Browser } from '../browser.ts';

let fixture: Fixture;
let cookie: string;
let browser: Browser;
const tab = () => browser.tab;

const MESSAGE = '請決定。\n\nDECIDE: Q-1 r1 · 第一題';
const BOX = `.history [data-content="q:s-mic:Q-1"] form.answer textarea`;
const MICS = [
	{ id: 'usb', label: 'USB 麥克風' },
	{ id: 'built', label: '內建麥克風' }
];
const PICK = '.mic-pick';
const ITEMS = `[...document.querySelectorAll('.mic-menu [role="menuitemradio"]')].map((item) => item.innerText.trim() + (item.getAttribute('aria-checked') === 'true' ? ' ✓' : ''))`;
const ESCAPE = `document.querySelector('.mic-menu [role="menu"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`;

beforeAll(async () => {
	fixture = await startFixture();
	fixture.setClock(Date.parse('2026-10-20T02:00:00.000Z'));
	cookie = await fixture.login('mic-picker');
	const controller = fixture.bound('voice', 'rana', { session_id: 's-mic', questions: [question({ id: 'Q-1', title: '第一題', asked_at: '2026-10-20T01:00:00.000Z' })] });
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', 's-mic.jsonl'), JSON.stringify({ kind: 'assistant', time: '2026-10-20T01:00:30.000Z', text: MESSAGE }) + '\n');
	fixture.report(controller.session_id, { tag: 'DECIDE', summary: '等你決定', message: MESSAGE, hcom_name: 'rana', workspace: controller.workspace, time: '2026-10-20T01:00:31.000Z' });
	fixture.setHelper({ output: { controllers: [controller] } });
	await fixture.refresh(cookie);
	browser = await launchChrome();
	const [name, value] = cookie.split('=');
	await tab().send('Network.setCookie', { name, value, url: fixture.url });
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

async function open(width: number, mics = MICS) {
	await tab().send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width < 761 });
	await tab().navigate(`${fixture.url}/?controller=s-mic`);
	await tab().until(`!!document.querySelector('${BOX}')`, 'the answer box');
	await tab().eval(fakeMic('好', mics));
}

test('voice input off: no picker beside any mic', async () => {
	await open(1280);
	expect(await tab().eval(`!document.querySelector('${PICK}') && !document.querySelector('button.mic')`)).toBe(true);
	await tab().eval(`localStorage.setItem('lat-board-voice', '1')`);
}, 30_000);

test('each mic and its picker are one control in the command line and the answer box, at both widths', async () => {
	for (const width of [1280, 390]) {
		await open(width);
		await tab().until(`document.querySelectorAll('.mic-group').length >= 2`, 'the mics');
		expect(
			await tab().eval(`[...document.querySelectorAll('.mic-group')].every((group) => {
				const [mic, pick] = [...group.children].map((child) => child.getBoundingClientRect());
				return group.children.length === 2 && Math.abs(mic.top - pick.top) < 1 && Math.abs(mic.bottom - pick.bottom) < 1 && Math.abs(mic.right - pick.left) <= 1 && pick.width >= mic.width - 1 && pick.height >= mic.height - 1;
			})`)
		).toBe(true);
		// Nothing is squeezed into sideways scrolling.
		expect(await tab().eval(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
		await shot(tab(), `mic-picker-idle-${width}`, { box: BOX });
	}
}, 30_000);

test('the menu lists the system default and each mic, marks the one in use, and the choice reaches every recording and a reload', async () => {
	await open(390);
	await tab().until(`document.querySelectorAll('${PICK}').length >= 2`, 'the pickers');
	await tab().eval(`document.querySelector('.cmd ${PICK}').click()`);
	await tab().until(`document.querySelectorAll('.mic-menu [role="menuitemradio"]').length === 3`, 'the menu');
	expect(await tab().eval(ITEMS)).toEqual(['系統預設 ✓', 'USB 麥克風', '內建麥克風']);
	// Inside the window.
	expect(await tab().eval(`(() => { const r = document.querySelector('.mic-menu').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()`)).toBe(true);
	await shot(tab(), 'mic-picker-menu-390');
	await tab().eval(`[...document.querySelectorAll('.mic-menu [role="menuitemradio"]')][1].click()`);
	await tab().until(`!document.querySelector('.mic-menu')`, 'the menu closed');
	// Recording in the answer box (not the mic that was set) asks for the picked one.
	await speak(tab(), BOX);
	expect(await tab().eval(`mediaAsked.at(-1)`)).toEqual({ audio: { deviceId: { exact: 'usb' } } });
	// The choice is still there after a reload, in the other mic's menu.
	await open(390);
	await tab().eval(`document.querySelectorAll('${PICK}')[1].click()`);
	await tab().until(`document.querySelectorAll('.mic-menu [role="menuitemradio"]').length === 3`, 'the menu after reload');
	expect(await tab().eval(ITEMS)).toEqual(['系統預設', 'USB 麥克風 ✓', '內建麥克風']);
	expect(tab().errors).toEqual([]);
}, 40_000);

test('plugging a mic in or out updates the open menu', async () => {
	await open(1280);
	await tab().eval(`document.querySelector('${PICK}').click()`);
	await tab().until(`document.querySelectorAll('.mic-menu [role="menuitemradio"]').length === 3`, 'the menu');
	await tab().eval(`plugMics([{ id: 'usb', label: 'USB 麥克風' }])`);
	await tab().until(`document.querySelectorAll('.mic-menu [role="menuitemradio"]').length === 2`, 'the list after unplugging');
	expect(await tab().eval(ITEMS)).toEqual(['系統預設', 'USB 麥克風 ✓']);
	await shot(tab(), 'mic-picker-menu-1280');
}, 30_000);

test('a chosen mic that is gone: the recording uses the system default and says so', async () => {
	await open(1280, [{ id: 'built', label: '內建麥克風' }]);
	// The saved choice is still 'usb', which is not listed any more.
	await tab().eval(`document.querySelector('${PICK}').click()`);
	await tab().until(`document.querySelectorAll('.mic-menu [role="menuitemradio"]').length === 2`, 'the menu');
	expect(await tab().eval(ITEMS)).toEqual(['系統預設 ✓', '內建麥克風']);
	await tab().eval(ESCAPE);
	await speak(tab(), BOX);
	expect(await tab().eval(`mediaAsked.map((asked) => asked.audio.deviceId?.exact ?? 'default')`)).toEqual(['usb', 'default']);
	await tab().until(`document.body.innerText.includes('改用系統預設')`, 'the notice');
	await shot(tab(), 'mic-picker-fallback-1280');
}, 30_000);

// Names are hidden until the browser allows the mic: `granted` flips when a request succeeds.
const HIDE_NAMES = `(() => {
	const media = navigator.mediaDevices;
	const names = new Map(${JSON.stringify(MICS.map((mic) => [mic.id, mic.label]))});
	let granted = false;
	const ask = media.getUserMedia;
	media.getUserMedia = async (constraints) => {
		const stream = await ask(constraints);
		granted = true;
		return stream;
	};
	media.enumerateDevices = async () => [...names].map(([deviceId, label]) => ({ kind: 'audioinput', deviceId: granted ? deviceId : '', label: granted ? label : '' }));
})()`;

test('before the browser allows the mic, opening the menu asks once, then lists the names', async () => {
	await open(1280);
	await tab().eval(HIDE_NAMES);
	await tab().eval(`document.querySelector('${PICK}').click()`);
	await tab().until(`document.querySelectorAll('.mic-menu [role="menuitemradio"]').length === 3 && !document.querySelector('.mic-menu').innerText.includes('麥克風 1')`, 'the names');
	expect(await tab().eval(`mediaAsked`)).toEqual([{ audio: true }]);
	expect(await tab().eval(ITEMS)).toEqual(['系統預設', 'USB 麥克風 ✓', '內建麥克風']);
}, 30_000);

test('when the browser refuses the mic, the menu says why and still offers the system default', async () => {
	await open(1280);
	await tab().eval(HIDE_NAMES);
	await tab().eval(`navigator.mediaDevices.getUserMedia = async () => { throw Object.assign(new Error('no'), { name: 'NotAllowedError' }); }`);
	await tab().eval(`document.querySelector('${PICK}').click()`);
	await tab().until(`document.querySelector('.mic-menu .note')?.innerText.includes('被擋住')`, 'the reason');
	expect((await tab().eval<string[]>(ITEMS))[0]).toStartWith('系統預設');
	await shot(tab(), 'mic-picker-denied-1280');
}, 30_000);
