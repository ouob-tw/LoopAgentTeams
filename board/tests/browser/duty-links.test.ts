// A controller's duty, expected result and delivered result show their Markdown links to web
// addresses as new-tab links in the hover explanation and the information page; the roster card
// shows only the link text. Headless Chrome on the built board with fake data.
// Skipped when the host has no Chrome.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, shot, type Browser, type Tab } from '../browser.ts';

const A = 'https://github.com/ouob-tw/LoopAgentTeams-work/issues/533';
const B = 'https://github.com/ouob-tw/LoopAgentTeams-work/issues/532';
const DUTY = `修 [#533](${A}) [壞](javascript:alert(1)) <b>粗</b>`;
const EXPECTED = `看 [#532](${B}) 完成`;
const STARTED = `window.popstateListeners >= 2`;
const COUNT_POPSTATE = `(() => {
	const add = window.addEventListener;
	window.popstateListeners = 0;
	window.addEventListener = function (type, ...rest) {
		if (type === 'popstate') window.popstateListeners++;
		return add.call(this, type, ...rest);
	};
})()`;
const CARD = `.people > .person[data-controller="luna"]`;

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;
let luna: ReturnType<Fixture['bound']>;

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	cookie = await fixture.login('duty-links');
	luna = fixture.bound('alpha', 'luna');
	fixture.list([luna]);
	writeFileSync(join(fixture.reportsDir, `${luna.session_id}.duty.json`), JSON.stringify({ text: DUTY, expected: EXPECTED, time: new Date().toISOString() }));
	await fixture.refresh(cookie);
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

async function visit(path: string) {
	await browser?.close();
	browser = await launchChrome({ scripts: [COUNT_POPSTATE] });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
	await tab.navigate(`${fixture.url}${path}`);
	await tab.until(STARTED, 'the board to start');
}
const links = (box: string) =>
	tab.eval<{ text: string; href: string; target: string }[]>(
		`[...document.querySelectorAll(${JSON.stringify(box + ' a')})].map((a) => ({ text: a.innerText, href: a.href, target: a.target }))`
	);
const text = (selector: string) => tab.eval<string>(`document.querySelector(${JSON.stringify(selector)}).innerText`);
const LINKS = [
	{ text: '#533', href: A, target: '_blank' },
	{ text: '#532', href: B, target: '_blank' }
];

test.skipIf(!CHROME)('the roster card shows the duty as text only: the link text, no link, no raw Markdown', async () => {
	await visit('/');
	await tab.until(`!!document.querySelector(${JSON.stringify(CARD)})`, 'the card');
	expect(await text(`${CARD} .duty`)).toBe('修 #533 [壞](javascript:alert(1)) <b>粗</b>');
	expect(await tab.eval(`document.querySelector(${JSON.stringify(CARD + ' a')})`)).toBeNull();
	expect(await tab.eval(`document.querySelector(${JSON.stringify(CARD + ' .duty b')})`)).toBeNull();
	await shot(tab, 'duty-links-card');
}, 60_000);

test.skipIf(!CHROME)('hovering the roster card shows the duty and expected result with their links', async () => {
	await visit('/');
	await tab.until(`!!document.querySelector(${JSON.stringify(CARD)})`, 'the card');
	const at = await tab.eval<{ x: number; y: number }>(`(() => { const box = document.querySelector(${JSON.stringify(CARD)}).getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`);
	await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at });
	const tip = `#roster-tip-${luna.session_id}`;
	await tab.until(`!!document.querySelector(${JSON.stringify(tip)})`, 'the explanation');
	expect(await links(tip)).toEqual(LINKS);
	expect(await text(tip)).toContain('[壞](javascript:alert(1)) <b>粗</b>');
	await shot(tab, 'duty-links-hover');
}, 60_000);

test.skipIf(!CHROME)('the information page header shows the duty and expected result with their links', async () => {
	await visit(`/?controller=${luna.session_id}`);
	await tab.until(`!!document.querySelector('.detail .more')`, 'the details button');
	await tab.eval(`document.querySelector('.detail .more').click()`);
	await tab.until(`!!document.querySelector('.detail .profile dd.duty')`, 'the duty');
	expect(await links('.detail .profile dd.duty')).toEqual(LINKS);
	expect(await tab.eval(`document.querySelector('.detail .profile dd.duty b')`)).toBeNull();
	await shot(tab, 'duty-links-header');
}, 60_000);

test.skipIf(!CHROME)('once delivered, the header shows the delivered result with its link', async () => {
	fixture.report(luna.session_id, { tag: 'DONE', summary: `交付 [#533](${A}) 完成`, hcom_name: 'luna', workspace: luna.workspace });
	await fixture.refresh(cookie);
	await visit(`/?controller=${luna.session_id}`);
	await tab.until(`!!document.querySelector('.detail .more')`, 'the details button');
	await tab.eval(`document.querySelector('.detail .more').click()`);
	await tab.until(`!!document.querySelector('.detail .profile dd.duty')`, 'the duty');
	expect(await text('.detail .profile dd.duty')).toContain('已交付結果');
	expect(await links('.detail .profile dd.duty')).toEqual([LINKS[0], { text: '#533', href: A, target: '_blank' }]);
}, 60_000);
