// A controller's latest report summary shows its Markdown links to web addresses as links, in the
// information page's header and in the roster card's explanation box (hovered, and held on a touch
// screen); everything else in it stays text. Headless Chrome on the built board with fake data.
// Skipped when the host has no Chrome.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { sleep, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, shot, type Browser, type Tab } from '../browser.ts';

const ISSUE = 'https://github.com/ouob-tw/LoopAgentTeams-work/issues/426';
const SUMMARY = `交付 [#426](${ISSUE}) <b>粗</b> & \`code\` [壞](javascript:alert(1))`;
const COUNT_POPSTATE = `(() => {
	const add = window.addEventListener;
	window.popstateListeners = 0;
	window.addEventListener = function (type, ...rest) {
		if (type === 'popstate') window.popstateListeners++;
		return add.call(this, type, ...rest);
	};
})()`;
const STARTED = `window.popstateListeners >= 2`;
const CARD = `.people > .person[data-controller="luna"]`;

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;
let luna: ReturnType<Fixture['bound']>;
const tipOf = () => `#roster-tip-${luna.session_id}`;

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	cookie = await fixture.login('summary-links');
	luna = fixture.bound('alpha', 'luna');
	fixture.report(luna.session_id, { tag: 'DONE', summary: SUMMARY, hcom_name: 'luna', workspace: luna.workspace });
	fixture.list([luna]);
	await fixture.refresh(cookie);
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

async function visit(width: number, path: string) {
	await browser?.close();
	browser = await launchChrome({ scripts: [COUNT_POPSTATE] });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width < 761 });
	await tab.navigate(`${fixture.url}${path}`);
	await tab.until(STARTED, 'the board to start');
}
const middle = (selector: string) =>
	tab.eval<{ x: number; y: number }>(`(() => { const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`);
const links = (box: string) =>
	tab.eval<{ text: string; href: string; target: string; rel: string }[]>(
		`[...document.querySelectorAll(${JSON.stringify(box + ' a')})].map((a) => ({ text: a.innerText, href: a.href, target: a.target, rel: a.rel }))`
	);
const mouse = (type: string, at: { x: number; y: number }) => tab.send('Input.dispatchMouseEvent', { type, ...at });

test.skipIf(!CHROME)('the information header shows the issue link as a new-tab link and the rest as text', async () => {
	await visit(1280, `/?controller=${luna.session_id}`);
	await tab.until(`document.querySelector('.detail .profile .phase')`, 'the header');
	expect(await links('.detail .profile .phase')).toEqual([{ text: '#426', href: ISSUE, target: '_blank', rel: 'noopener noreferrer' }]);
	const text = await tab.eval<string>(`document.querySelector('.detail .profile .phase').innerText`);
	expect(text).toBe('交付 #426 <b>粗</b> & `code` [壞](javascript:alert(1))');
	expect(await tab.eval(`document.querySelector('.detail .profile .phase b')`)).toBeNull();
	await shot(tab, 'summary-links-header');
}, 60_000);

test.skipIf(!CHROME)('hovering the roster card shows the link, and the pointer can move onto the box and the link without it vanishing', async () => {
	await visit(1280, '/');
	await tab.until(`!!document.querySelector(${JSON.stringify(CARD)})`, 'the card');
	await mouse('mouseMoved', await middle(CARD));
	await tab.until(`!!document.querySelector(${JSON.stringify(tipOf())})`, 'the explanation');
	expect(await links(tipOf())).toEqual([{ text: '#426', href: ISSUE, target: '_blank', rel: 'noopener noreferrer' }]);
	expect(await tab.eval<string>(`document.querySelector(${JSON.stringify(tipOf())}).innerText`)).toContain('<b>粗</b> & `code` [壞](javascript:alert(1))');
	await shot(tab, 'summary-links-hover');

	// Across the gap between the card and the box, onto the link; the box stays.
	const link = await middle(`${tipOf()} a`);
	const card = await tab.eval<{ right: number }>(`({ right: document.querySelector(${JSON.stringify(CARD)}).getBoundingClientRect().right })`);
	const from = await middle(CARD);
	for (let step = 1; step <= 10; step++) {
		await mouse('mouseMoved', { x: from.x + ((link.x - from.x) * step) / 10, y: from.y + ((link.y - from.y) * step) / 10 });
		await sleep(30);
	}
	expect(card.right).toBeLessThan(link.x);
	await sleep(500);
	expect(await tab.eval(`!!document.querySelector(${JSON.stringify(tipOf())})`)).toBe(true);
	// A click on it opens the address in a new tab.
	const opened = tab.eval<string>(`new Promise((resolve) => { window.open = (url, target) => resolve(url + '|' + target); document.querySelector(${JSON.stringify(tipOf() + ' a')}).addEventListener('click', (e) => { e.preventDefault(); resolve(e.target.href + '|' + e.target.target); }); })`);
	await mouse('mousePressed', { ...link, button: 'left', clickCount: 1 } as never);
	await mouse('mouseReleased', { ...link, button: 'left', clickCount: 1 } as never);
	expect(await opened).toBe(`${ISSUE}|_blank`);

	// Away from both, it goes.
	await mouse('mouseMoved', { x: 900, y: 700 });
	await tab.until(`!document.querySelector(${JSON.stringify(tipOf())})`, 'the explanation gone');
}, 60_000);

test.skipIf(!CHROME)("at a phone's width a long press shows the box and its link can be tapped", async () => {
	await visit(390, '/');
	await tab.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
	await tab.navigate(`${fixture.url}/`);
	await tab.until(STARTED, 'the board to start');
	await tab.until(`!!document.querySelector(${JSON.stringify(CARD)})`, 'the tag');
	await tab.eval(`document.addEventListener('click', (e) => { const a = e.target.closest?.('a'); if (a) { e.preventDefault(); window.tapped = a.href; } }, true)`);
	const at = await middle(CARD);
	await tab.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
	await sleep(700);
	await tab.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await tab.until(`!!document.querySelector(${JSON.stringify(tipOf())})`, 'the explanation');
	expect((await links(tipOf())).map((link) => link.href)).toEqual([ISSUE]);
	const link = await middle(`${tipOf()} a`);
	const hit = await tab.eval<boolean>(`document.elementFromPoint(${link.x}, ${link.y})?.closest('a') === document.querySelector(${JSON.stringify(tipOf() + ' a')})`);
	expect(hit).toBe(true);
	await tab.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [link] });
	await tab.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await tab.until(`window.tapped === ${JSON.stringify(ISSUE)}`, 'the link tapped');
	await shot(tab, 'summary-links-phone');
}, 60_000);
