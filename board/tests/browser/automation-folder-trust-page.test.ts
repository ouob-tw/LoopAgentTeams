// The folder-trust warning (#703) in a real browser at 1400px and 390px. The board reads the temp
// home's `.claude.json` (the fixture's HOME), never the real one. Saving a Claude agent task whose
// folder Claude has not trusted replaces the form's fields with 已儲存, the warning naming the folder
// and the one-line fix, and only 看任務; the task page and its card in the list warn too. Once
// the folder is trusted the warning is gone on the next read, with no restart; a trusted folder's
// save goes straight to the task, no warning. Frames go to LAT_BOARD_SHOTS when it is set.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, shot, type Browser, type Tab } from '../browser.ts';

const SCREEN = `({ search: location.search, detail: document.querySelector('.detail')?.innerText.slice(0, 400) ?? '' })`;
/** Nothing reaches past the window's width, and nothing in the list, the task page or the form past its own box. */
const FITS = `document.documentElement.scrollWidth <= window.innerWidth && [...document.querySelectorAll('.automation, .automation *, .detail .task, .detail .task *, .detail form, .detail form *, .detail [data-saved], .detail [data-saved] *')].filter((node) => node.tagName !== 'INPUT' && !node.closest('.ell')).every((node) => node.scrollWidth <= node.clientWidth + 1)`;

let fixture: Fixture;
let cookie: string;
let work: string;
/** Folders trusted by an earlier test: they stay trusted, so each width's frames show only its own task's warning. */
const trusted: string[] = [];
let browser: Browser | undefined;
let tab: Tab;

/** Claude's settings in the temp home: these folders trusted, nothing else. */
const claudeTrusts = (...folders: string[]) =>
	writeFileSync(join(fixture.dir, 'home/.claude.json'), JSON.stringify({ projects: Object.fromEntries(folders.map((folder) => [folder, { hasTrustDialogAccepted: true }])) }));

beforeAll(async () => {
	fixture = await startFixture();
	cookie = await fixture.login();
}, 60_000);
afterEach(async () => {
	expect(tab?.errors ?? []).toEqual([]);
	await browser?.close();
	browser = undefined;
});
afterAll(async () => {
	await fixture?.cleanup();
});

async function visit(width: number, path: string) {
	browser = await launchChrome({ screen: SCREEN });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height: width < 761 ? 844 : 900, deviceScaleFactor: width < 761 ? 2 : 1, mobile: width < 761 });
	await tab.send('Page.navigate', { url: `${fixture.url}/login` });
	await tab.until(`document.readyState === 'complete'`, 'a page of the board');
	await tab.eval(`localStorage.setItem('lat-board-inbox-width', '400')`);
	await go(path);
}
async function go(path: string) {
	await tab.send('Page.navigate', { url: `${fixture.url}${path}` });
	await tab.boardStarted();
}
const click = (selector: string) => tab.eval(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error('no ${selector.replace(/'/g, '')}'); node.click(); })()`);
const type = (selector: string, value: string) =>
	tab.eval(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); node.value = ${JSON.stringify(value)}; node.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const text = (selector: string) => tab.eval<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`);
const has = (selector: string) => tab.eval<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`);
const fits = () => tab.eval<boolean>(FITS);

/** Fill the new-task form as a Claude or Codex agent task in `work`, and press 儲存. */
async function saveNew(name: string, client: 'claude' | 'codex') {
	await go('/?automation-edit=new');
	await tab.until(`!!document.querySelector('.detail form [name=name]')`, 'the new task form');
	await type('.detail form [name=name]', name);
	await click('.detail form [data-kind=agent]');
	await tab.until(`!!document.querySelector('.detail form [name=model]')`, 'the agent fields');
	await click(`.detail form [data-client=${client}]`);
	await type('.detail form [name=model]', client === 'claude' ? 'claude-sonnet-5-5' : 'gpt-6.1-sol');
	await type('.detail form [name=folder]', work);
	await type('.detail form [name=brief]', 'brief.md');
	await click('.detail form [name=review]');
	await click('.detail form button[type=submit]');
}

for (const width of [1400, 390]) {
	test.skipIf(!CHROME)(`${width}px: an untrusted folder warns on the form, the task page and its card until it is trusted`, async () => {
		// A long folder, as real ones are: it wraps inside the warning, never past it.
		work = join(fixture.dir, `work-${width}/.local/state/lat/security-check`);
		mkdirSync(work, { recursive: true });
		writeFileSync(join(work, 'brief.md'), '# 主機資安檢查\n');
		claudeTrusts(join(fixture.dir, 'elsewhere'), ...trusted);
		await visit(width, '/?tab=automation');
		const name = `主機資安檢查 ${width}`;
		await saveNew(name, 'claude');
		await tab.until(`!!document.querySelector('.detail [data-saved] [data-folder-untrusted=claude]')`, 'the warning on the form');
		const warning = await text('.detail [data-saved] [data-folder-untrusted]');
		expect(warning).toContain('Claude 還沒信任這個資料夾，執行會卡在它的詢問畫面');
		expect(warning).toContain(`修法：在 ${work} 開一次 Claude，選信任這個資料夾。`);
		expect(await text('.detail [data-saved] .saved')).toBe('已儲存。');
		// Saved once: the fields and 儲存 are gone, so nothing typed now is lost and the task is not added twice.
		expect(await has('.detail form')).toBe(false);
		expect(await text('.detail [data-saved] .actions button.primary')).toBe('看任務');
		// The whole folder shows: no line is cut off inside the warning.
		expect(await tab.eval<boolean>(`(() => { const box = document.querySelector('.detail [data-saved] [data-folder-untrusted]'); return [...box.querySelectorAll('*')].every((node) => node.getBoundingClientRect().right <= box.getBoundingClientRect().right + 0.5); })()`)).toBe(true);
		// The warning does not cover 看任務.
		expect(await tab.eval<boolean>(`(() => { const a = document.querySelector('.detail [data-saved] [data-folder-untrusted]').getBoundingClientRect(); const b = document.querySelector('.detail [data-saved] .actions button.primary').getBoundingClientRect(); return a.bottom <= b.top; })()`)).toBe(true);
		expect(await fits()).toBe(true);
		await shot(tab, `${width}-1-form-warning`, { box: '.detail [data-saved] [data-folder-untrusted]' });
		await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
		await shot(tab, `${width}-1-form-warning-dark`, { box: '.detail [data-saved] [data-folder-untrusted]' });
		await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

		await click('.detail [data-saved] .actions button.primary');
		await tab.until(`!!document.querySelector('.detail .task [data-folder-untrusted=claude]')`, 'the warning on the task page');
		expect(await text('.detail .task [data-folder-untrusted]')).toContain(`修法：在 ${work} 開一次 Claude`);
		expect(await fits()).toBe(true);
		await shot(tab, `${width}-2-task-warning`);

		await go('/?tab=automation');
		await tab.until(`!!document.querySelector('.automation [data-folder-untrusted=claude]')`, 'the warning on the card');
		expect(await text('.automation [data-folder-untrusted]')).toBe('資料夾未被 Claude 信任，執行會卡住\n修法：在任務資料夾開一次 Claude，選信任。');
		expect(await tab.eval<number>(`[...document.querySelectorAll('.automation .card')].filter((card) => card.querySelector('[data-folder-untrusted]')).length`)).toBe(1);
		expect(await fits()).toBe(true);
		await shot(tab, `${width}-3-card-warning`, { box: '.automation [data-folder-untrusted]' });

		// Trusted now: the next read of the list has no warning, with the board still running.
		trusted.push(work);
		claudeTrusts(...trusted);
		await go('/?tab=automation');
		await tab.until(`!!document.querySelector('.automation .card')`, 'the list');
		expect(await has('[data-folder-untrusted]')).toBe(false);
		await shot(tab, `${width}-4-card-trusted`);

		// A trusted folder's save goes straight to the task page, with no warning.
		await saveNew(`${name} 已信任`, 'claude');
		await tab.until(`!!document.querySelector('.detail .task')`, 'the task page');
		expect(await has('[data-folder-untrusted]')).toBe(false);
		await shot(tab, `${width}-5-task-trusted`);
	}, 60_000);
}
