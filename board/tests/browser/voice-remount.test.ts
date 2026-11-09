// A recording under way while the page draws its box again, in a real browser with a fake mic: a
// board ask's card moving from the top of the agent's page into the conversation once that loads,
// and the command line's controls rebuilt as a phone's width is crossed. The recording goes on, the
// mic still counts down and what was said goes into the same box. A box that really goes away stops
// its recording and lets go of the mic.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';
import { launchChrome, micOf, shot, type Browser, type Tab } from '../browser.ts';

const HOOK = join(import.meta.dir, '../../hooks/board-ask.py');

let fixture: Fixture;
let cookie: string;
const browsers: Browser[] = [];

/** A fake mic that counts the mics held open (`micLive`) and the recordings sent (`voiceSent`); the
 *  recognition service hears 紫色. */
const FAKE_MIC = `(() => {
	window.micLive = 0;
	window.voiceSent = 0;
	Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => {
		window.micLive++;
		let live = true;
		const tracks = [{ stop() { if (live) { live = false; window.micLive--; } } }];
		return { getTracks: () => tracks };
	} } });
	window.MediaRecorder = class {
		mimeType = 'audio/webm';
		start() {}
		stop() {
			this.ondataavailable?.({ data: new Blob(['x']) });
			this.onstop?.();
		}
	};
	const fetch = window.fetch;
	window.fetch = (input, init) => {
		if (!String(input).includes('/api/voice')) return fetch(input, init);
		window.voiceSent++;
		return Promise.resolve(new Response(JSON.stringify({ text: '紫色' }), { headers: { 'content-type': 'application/json' } }));
	};
})()`;

/** The conversation's pages wait until \`showTranscript()\` is called, so the cards stay at the top. */
const HOLD_TRANSCRIPT = `(() => {
	let go;
	const held = new Promise((resolve) => (go = resolve));
	window.showTranscript = () => go();
	const add = EventSource.prototype.addEventListener;
	EventSource.prototype.addEventListener = function (type, listener, options) {
		if (type !== 'transcript') return add.call(this, type, listener, options);
		return add.call(this, type, (event) => held.then(() => listener.call(this, event)), options);
	};
})()`;

/** The hook as Claude runs it for the agent of session `s-ask`, asking into the board's folder. */
function ask(questions: object[]) {
	const child = Bun.spawn(['uv', 'run', '--no-project', 'python', HOOK, 'hook'], {
		stdin: new TextEncoder().encode(
			JSON.stringify({ session_id: 's-ask', cwd: '/work', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions }, tool_use_id: 'toolu_1' })
		),
		stdout: 'pipe',
		env: { PATH: Bun.env.PATH ?? '', HOME: Bun.env.HOME ?? '', LAT_BOARD_ASKS_DIR: join(fixture.dir, 'board-asks'), HERDR_PANE_ID: 'wA:p-s-ask', LAT_BOARD_ASK_WAIT_SECONDS: '60' }
	});
	return Promise.all([child.exited, new Response(child.stdout).text()]).then(([code, stdout]) => ({ code, stdout }));
}
const QUESTION = { question: 'Pick a color?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'Choose red.' }, { label: 'Blue', description: 'Choose blue.' }] };

beforeAll(async () => {
	fixture = await startFixture();
	cookie = await fixture.login();
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents: [{ agent: 'claude', agent_session: { kind: 'id', value: 's-ask' }, agent_status: 'blocked', cwd: '/work', pane_id: 'wA:p-s-ask', tab_id: 'wA:t-s-ask', workspace_id: 'wA' }],
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
			tabs: [{ tab_id: 'wA:t-s-ask', workspace_id: 'wA', label: 'asker' }]
		})
	);
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', 's-ask.jsonl'), JSON.stringify({ kind: 'user', time: '2026-10-24T09:00:00.000Z', text: '問我幾個問題' }) + '\n');
	await fixture.refresh(cookie);
}, 30_000);
afterEach(async () => {
	for (const browser of browsers.splice(0)) await browser.close();
});
afterAll(async () => {
	await fixture?.cleanup();
});

/** A new Chrome with voice input on and the fake mic, on the asking agent's page. */
async function open(scripts: string[], { width, height, mobile }: { width: number; height: number; mobile: boolean }): Promise<Tab> {
	const browser = await launchChrome({ scripts: [`localStorage.setItem('lat-board-voice', '1')`, FAKE_MIC, ...scripts] });
	browsers.push(browser);
	const { tab } = browser;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
	await tab.send('Page.navigate', { url: `${fixture.url}/?agent=s-ask` });
	await tab.until(`JSON.stringify(history.state).includes('depth')`, 'the board to start');
	return tab;
}

/** Every mic on the page that shows a recording. */
const RECORDING = `document.querySelectorAll('button.mic[data-voice="recording"]').length`;
/** The countdown on the mic beside `box`, in seconds. */
const leftOn = (mic: string) => `(() => { const [m, s] = ${mic}.innerText.split(':'); return Number(m) * 60 + Number(s); })()`;
/** Wait until the recording on `mic` has counted down at least one second, so a countdown started
 *  again would show. */
const countedDown = (tab: Tab, mic: string) => tab.until(`${mic}?.dataset.voice === 'recording' && ${leftOn(mic)} <= 177`, 'the countdown to run', 10_000);

test('a card moving into the conversation keeps its recording; a box that goes away stops it and lets go of the mic', async () => {
	const answered = ask([QUESTION]);
	const tab = await open([HOLD_TRANSCRIPT], { width: 1280, height: 900, mobile: false });
	// Until the conversation is read the card is at the top of the page.
	const top = `.detail .history > [data-ask][data-state="waiting"]`;
	await tab.until(`document.querySelector('${top}')`, 'the card at the top');
	const other = (card: string) => `[...document.querySelectorAll('${card} [data-question="0"] label')].find((entry) => entry.innerText.split('\\n')[0] === '其他').querySelector('input').click()`;
	await tab.eval(other(top));
	const before = `${top} [data-question="0"] textarea`;
	await tab.until(`document.querySelector('${before}')`, 'the 其他 box');
	await tab.eval(`(() => { const box = document.querySelector('${before}'); box.value = '要的'; box.dispatchEvent(new Event('input', { bubbles: true })); box.setSelectionRange(1, 1); })()`);
	await tab.eval(`${micOf(before)}.setAttribute('data-first', '')`);
	await tab.eval(`${micOf(before)}.click()`);
	await countedDown(tab, micOf(before));
	const left = await tab.eval<number>(leftOn(micOf(before)));
	await shot(tab, 'remount-card-before', { box: before });

	await tab.eval(`showTranscript()`);
	const placed = `.detail li.ask [data-ask][data-state="waiting"]`;
	const after = `${placed} [data-question="0"] textarea`;
	await tab.until(`document.querySelector('${after}') && !document.querySelector('${before}')`, 'the card in the conversation');
	await shot(tab, 'remount-card-after', { box: after });
	// Drawn anew, still recording, the countdown not started again, one mic held open.
	expect(await tab.eval(`'first' in ${micOf(after)}.dataset`)).toBe(false);
	expect(await tab.eval(`${micOf(after)}.dataset.voice`)).toBe('recording');
	expect(await tab.eval<number>(leftOn(micOf(after)))).toBeLessThanOrEqual(left);
	expect(await tab.eval<number>(RECORDING)).toBe(1);
	expect(await tab.eval<number>(`micLive`)).toBe(1);
	await tab.eval(`${micOf(after)}.click()`);
	// The box drawn anew has its cursor at the end.
	await tab.until(`document.querySelector('${after}').value === '要的紫色'`, 'the speech in the same box');
	expect(await tab.eval<number>(`micLive`)).toBe(0);

	// Recording again, then the box goes away (Red chosen instead of 其他): the mic is let go of and
	// nothing is sent.
	await tab.eval(`${micOf(after)}.click()`);
	await tab.until(`${micOf(after)}.dataset.voice === 'recording'`, 'recording again');
	const sent = await tab.eval<number>(`voiceSent`);
	await tab.eval(`[...document.querySelectorAll('${placed} [data-question="0"] label')].find((entry) => entry.innerText.split('\\n')[0] === 'Red').querySelector('input').click()`);
	await tab.until(`!document.querySelector('${after}') && micLive === 0`, 'the mic let go of');
	expect(await tab.eval<number>(RECORDING)).toBe(0);
	await Bun.sleep(200);
	expect(await tab.eval<number>(`voiceSent`)).toBe(sent);

	await tab.eval(`document.querySelector('${placed} form button').click()`);
	expect(JSON.parse((await answered).stdout).hookSpecificOutput.updatedInput.answers).toEqual({ 'Pick a color?': 'Red' });
	expect(tab.errors).toEqual([]);
}, 60_000);

test('a phone crossing 760px and back keeps the command line\'s recording; what was said goes into the command line', async () => {
	const phone = { width: 390, height: 844, mobile: true };
	const tab = await open([], phone);
	const mic = `document.querySelector('.cmd .voice-slot button.mic')`;
	const box = `document.querySelector('.cmd textarea')`;
	await tab.until(`${mic} && ${mic}.closest('.controls') && !${mic}.disabled`, 'the mic in the phone\'s row of controls');
	await tab.eval(`${mic}.setAttribute('data-first', '')`);
	await tab.eval(`${mic}.click()`);
	await countedDown(tab, mic);
	const left = await tab.eval<number>(leftOn(mic));
	await shot(tab, 'remount-phone-before');

	await tab.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 844, deviceScaleFactor: 1, mobile: false });
	await tab.until(`${mic}.closest('.field-row')`, 'the mic beside the box on a wide screen');
	await shot(tab, 'remount-wide');
	expect(await tab.eval(`'first' in ${mic}.dataset`)).toBe(false);
	expect(await tab.eval(`${mic}.dataset.voice`)).toBe('recording');
	expect(await tab.eval<number>(leftOn(mic))).toBeLessThanOrEqual(left);
	expect(await tab.eval<number>(RECORDING)).toBe(1);

	await tab.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
	await tab.until(`${mic}.closest('.controls')`, 'the mic back in the phone\'s row');
	await shot(tab, 'remount-phone-after');
	expect(await tab.eval(`${mic}.dataset.voice`)).toBe('recording');
	expect(await tab.eval<number>(leftOn(mic))).toBeLessThanOrEqual(left);
	expect(await tab.eval<number>(RECORDING)).toBe(1);
	expect(await tab.eval<number>(`micLive`)).toBe(1);

	await tab.eval(`${mic}.click()`);
	await tab.until(`${box}.value === '紫色'`, 'the speech in the command line');
	expect(await tab.eval<number>(`micLive`)).toBe(0);
	expect(tab.errors).toEqual([]);
}, 60_000);
