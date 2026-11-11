// A report or question title with a Markdown web link: the card's heading shows it as a link in a
// new tab, the inbox row and the pending bar (both clickable) show only its text. Headless Chrome
// on the built board with fake data. Skipped when the host has no Chrome.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { question, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, shot, type Browser, type Tab } from '../browser.ts';

const ISSUE = 'https://github.com/ouob-tw/LoopAgentTeams-work/issues/533';
const BARE = 'https://example.com/bare';
const REPORT_TITLE = `交付 [#533](${ISSUE}) 看 ${BARE} <b>粗</b> & [壞](javascript:alert(1))`;
const QUESTION_TITLE = `要不要合併 [#534](${ISSUE})`;
const SHOWN = '交付 #533 看 https://example.com/bare <b>粗</b> & [壞](javascript:alert(1))';
const COUNT_POPSTATE = `(() => {
	const add = window.addEventListener;
	window.popstateListeners = 0;
	window.addEventListener = function (type, ...rest) {
		if (type === 'popstate') window.popstateListeners++;
		return add.call(this, type, ...rest);
	};
})()`;
const STARTED = `window.popstateListeners >= 2`;

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;
let luna: ReturnType<Fixture['bound']>;

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	cookie = await fixture.login('title-links');
	luna = fixture.bound('alpha', 'luna', { questions: [question({ id: 'Q-1', title: QUESTION_TITLE })] });
	fixture.report(luna.session_id, { tag: 'DONE', summary: REPORT_TITLE, hcom_name: 'luna', workspace: luna.workspace });
	fixture.list([luna]);
	await fixture.refresh(cookie);
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

async function visit(width: number) {
	await browser?.close();
	browser = await launchChrome({ scripts: [COUNT_POPSTATE] });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 761 });
	await tab.navigate(`${fixture.url}/?controller=${luna.session_id}`);
	await tab.until(STARTED, 'the board to start');
}
const links = (box: string) =>
	tab.eval<{ text: string; href: string; target: string; rel: string }[]>(
		`[...document.querySelectorAll(${JSON.stringify(box + ' a')})].map((a) => ({ text: a.innerText, href: a.href, target: a.target, rel: a.rel }))`
	);
const text = (selector: string) => tab.eval<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`);

test.skipIf(!CHROME)('the inbox row and the pending bar show only the link text; the card heading shows the links', async () => {
	await visit(1280);
	await tab.until(`!!document.querySelector('.row[data-item] .title')`, 'the inbox');
	const rows = await tab.eval<string[]>(`[...document.querySelectorAll('.row[data-item] .title')].map((el) => el.innerText)`);
	expect(rows).toContain(SHOWN);
	expect(rows.join('\n')).toContain('要不要合併 #534');
	// The roster card's one line of the latest report is clickable too.
	expect(await text('.people .person .phase')).toBe(SHOWN);
	await tab.until(`!!document.querySelector('.questions .question .title')`, 'the pending bar');
	expect(await text('.questions .question .title')).toBe('▲ 待決：要不要合併 #534');
	expect(await links('.row[data-item] .title')).toEqual([]);
	expect(await links('.questions .question .title')).toEqual([]);

	await tab.eval(`[...document.querySelectorAll('.row[data-item] .main')].find((b) => b.innerText.includes('#533 看')).click()`);
	await tab.until(`!!document.querySelector('.content h2 a')`, 'the card heading');
	const heading = `[...document.querySelectorAll('.content h2')].find((h) => h.innerText === ${JSON.stringify(SHOWN)})`;
	expect(await tab.eval<boolean>(`!!${heading}`)).toBe(true);
	expect(await tab.eval(`[...${heading}.querySelectorAll('a')].map((a) => ({ text: a.innerText, href: a.href, target: a.target, rel: a.rel }))`)).toEqual([
		{ text: '#533', href: ISSUE, target: '_blank', rel: 'noopener noreferrer' },
		{ text: BARE, href: BARE, target: '_blank', rel: 'noopener noreferrer' }
	]);
	expect(await tab.eval(`${heading}.querySelector('b')`)).toBeNull();
	await shot(tab, 'title-links');
}, 60_000);
