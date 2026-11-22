// The hint about the typed folder sits to the right of the 「資料夾」 label, on that one line, in
// both the new-agent and the new-controller form: it appearing or going moves nothing below it, it
// never wraps or runs into the label, and the git-init box waits until typing stops.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, shot, type Browser } from '../browser.ts';

let fixture: Fixture;
let browser: Browser | undefined;
let alpha: string;
let plain: string;

const tab = () => browser!.tab;
const evaluate = <T>(expression: string) => tab().eval<T>(expression);
const until = (expression: string, what?: string) => tab().until(expression, what ?? expression);
const type = (text: string) => tab().send('Input.insertText', { text });
const FORMS = [
	{ page: '?launch', name: 'controller' },
	{ page: '?new-agent=wA', name: 'agent' }
];
const SIZES = [
	{ width: 390, height: 844, mobile: true },
	{ width: 1280, height: 800, mobile: false }
];

/** Where the fields below the folder box start, and the label line's own box. */
const BELOW = `document.querySelector('.where').getBoundingClientRect().top`;
const HEAD = `(() => { const r = document.querySelector('.folder-head').getBoundingClientRect(); return { top: r.top, height: r.height }; })()`;
const HINT = `document.querySelector('.folder-head .hint')`;
const ONE_LINE = `${HINT}.getBoundingClientRect().height <= document.querySelector('.folder-head').getBoundingClientRect().height + 0.5`;

async function open(page: string, size = SIZES[1]!, init?: string) {
	await tab().send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1 });
	const added = init ? ((await tab().send('Page.addScriptToEvaluateOnNewDocument', { source: init })) as { identifier: string }) : null;
	await tab().navigate(`${fixture.url}/${page}`);
	await tab().boardStarted();
	await until(`!!document.querySelector('#folder-box')`, 'the form');
	// Typing before the page has taken over would be wiped when it does: wait for its own default folder.
	if (!init) await until(`!!document.querySelector('#folder-box').value`, 'the page hydrated');
	else await Bun.sleep(500);
	if (added) await tab().send('Page.removeScriptToEvaluateOnNewDocument', { identifier: added.identifier });
	await evaluate(`document.querySelector('#folder-box').focus()`);
}
async function retype(text: string) {
	await evaluate(`document.querySelector('#folder-box').select()`);
	await type(text);
}
/** Type a path, wait for the hint to say `text`, then close the list. */
async function hintAfter(path: string, text: string) {
	await retype(path);
	await until(`${HINT}?.textContent.includes(${JSON.stringify(text)})`, `the hint ${text}`);
	await evaluate(`document.querySelector('#folder-box').blur()`);
}

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	const cookie = await fixture.login('folder-hint');
	const luna = fixture.bound('alpha', 'luna');
	alpha = luna.workspace;
	mkdirSync(join(alpha, '.git'), { recursive: true });
	writeFileSync(join(alpha, 'a-file'), 'x');
	plain = join(fixture.dir, 'plain-folder');
	mkdirSync(join(plain, 'inner'), { recursive: true });
	fixture.report(luna.session_id, { tag: 'DONE', summary: '好了', hcom_name: 'luna', workspace: alpha });
	fixture.list([luna]);
	writeFileSync(join(fixture.dir, 'herdr.json'), JSON.stringify({ workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }] }));
	await fixture.refresh(cookie);
	browser = await launchChrome();
	const [name, value] = cookie.split('=');
	await tab().send('Network.setCookie', { name, value, url: fixture.url });
	await tab().send('Emulation.setFocusEmulationEnabled', { enabled: true });
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

for (const { page, name } of FORMS) {
	for (const size of SIZES) {
		test.skipIf(!CHROME)(`${name} form at ${size.width}px: each hint shows beside the label on one line and moves nothing below`, async () => {
			await open(page, size);
			await evaluate(`document.querySelector('#folder-box').blur()`);
			// Nothing said yet: the fields below start here, and the label line has this box.
			const head = await evaluate<{ top: number; height: number }>(HEAD);
			const below = await evaluate<number>(BELOW);
			expect(await evaluate(`!!${HINT}`)).toBe(false);

			const cases = [
				{ path: 'relative/path', text: '完整路徑', failed: true, shot: 'error' },
				{ path: `${alpha}/a-file`, text: '這不是資料夾', failed: true, shot: 'not-folder' },
				{ path: `${alpha}/not-there-yet`, text: '不能建立', failed: true, shot: 'cannot-create' },
				{ path: join(fixture.dir, 'home', 'new-place'), text: '還不存在', failed: false, shot: 'create' }
			];
			for (const one of cases) {
				await evaluate(`document.querySelector('#folder-box').focus()`);
				await hintAfter(one.path, one.text);
				const shown = await evaluate<{ failed: boolean; sameLine: boolean; clear: boolean; title: string }>(`(() => {
					const hint = ${HINT}, label = document.querySelector('.folder-head label');
					const h = hint.getBoundingClientRect(), l = label.getBoundingClientRect();
					return {
						failed: hint.classList.contains('failed'),
						sameLine: Math.abs((h.top + h.bottom) / 2 - (l.top + l.bottom) / 2) < l.height,
						clear: h.left >= l.right - 0.5,
						title: hint.title
					};
				})()`);
				expect(shown.failed).toBe(one.failed);
				expect(shown.sameLine).toBe(true);
				expect(shown.clear).toBe(true);
				expect(shown.title).toContain(one.text);
				// A failure is announced, and every hint is tied to the box it is about.
				expect(await evaluate(`${HINT}.getAttribute('role')`)).toBe(one.failed ? 'alert' : null);
				expect(await evaluate(`document.querySelector('#folder-box').getAttribute('aria-describedby') === ${HINT}.id`)).toBe(true);
				// One line: no taller than the label line; the line and the field below stay put.
				expect(await evaluate<boolean>(ONE_LINE)).toBe(true);
				// Long or short, the hint stays inside the form's right edge.
				expect(await evaluate<boolean>(`${HINT}.getBoundingClientRect().right <= document.querySelector('.folder').getBoundingClientRect().right + 0.5`)).toBe(true);
				expect(await evaluate(HEAD)).toEqual(head);
				expect(await evaluate<number>(BELOW)).toBe(below);
				await shot(tab(), `${name}-${size.width}-${one.shot}`);
			}
			// Back to a folder with nothing to say: the hint goes and the field below does not move.
			await evaluate(`document.querySelector('#folder-box').focus()`);
			await retype(alpha);
			await until(`!${HINT}`, 'the hint gone');
			await evaluate(`document.querySelector('#folder-box').blur()`);
			expect(await evaluate<number>(BELOW)).toBe(below);
			expect(tab().errors).toEqual([]);
		});
	}

	test.skipIf(!CHROME)(`${name} form: a folder whose state cannot be read says so beside the label and moves nothing`, async () => {
		await open(
			page,
			SIZES[0],
			`(() => {
				const real = window.fetch;
				window.fetch = (input, init) => (String(new URL(String(input), location.href).searchParams.get('q')).endsWith('/unreadable') ? Promise.reject(new TypeError('offline')) : real(input, init));
			})()`
		);
		await evaluate(`document.querySelector('#folder-box').blur()`);
		const below = await evaluate<number>(BELOW);
		await evaluate(`document.querySelector('#folder-box').focus()`);
		await hintAfter(`${alpha}/unreadable`, '讀不到狀態');
		expect(await evaluate<number>(BELOW)).toBe(below);
		expect(await evaluate<boolean>(ONE_LINE)).toBe(true);
		await shot(tab(), `${name}-390-unreadable`);
	});

	test.skipIf(!CHROME)(`${name} form: a project list that cannot be read is an alert beside the label, nothing below moves`, async () => {
		const failing = `(() => {
			const real = window.fetch;
			window.fetch = (input, init) => (new URL(String(input), location.href).pathname === '/api/launches' ? Promise.reject(new TypeError('offline')) : real(input, init));
		})()`;
		for (const size of SIZES) {
			await open(page, size);
			const head = await evaluate<{ height: number }>(HEAD);
			await open(page, size, failing);
			await until(`${HINT}?.textContent.includes('專案清單讀取失敗')`, 'the failed project list');
			expect(await evaluate(`${HINT}.getAttribute('role')`)).toBe('alert');
			expect(await evaluate(`${HINT}.classList.contains('failed')`)).toBe(true);
			expect(await evaluate<boolean>(ONE_LINE)).toBe(true);
			// The same label line as with no hint at all.
			expect((await evaluate<{ height: number }>(HEAD)).height).toBe(head.height);
			await evaluate(`document.querySelector('#folder-box').blur()`);
			await shot(tab(), `${name}-${size.width}-list-failed`);
		}
	});
}

test.skipIf(!CHROME)('the git-init box does not blink in while a path is typed, and shows once typing stops', async () => {
	await open('?launch');
	await evaluate(`(() => {
		window.seen = 0;
		new MutationObserver(() => { if (document.querySelector('.init')) window.seen++; }).observe(document.querySelector('.folder'), { childList: true, subtree: true });
	})()`);
	await retype(plain);
	// A letter at a time, with gaps longer than the search delay so each answer comes in between.
	for (const letter of '/inn') {
		await type(letter);
		await Bun.sleep(200);
	}
	expect(await evaluate(`window.seen`)).toBe(0);
	await type('er');
	await until(`!!document.querySelector('.init')`, 'the git-init box once typing stopped');
	await evaluate(`document.querySelector('#folder-box').blur()`);
	await shot(tab(), 'controller-1280-git-init');
});

test.skipIf(!CHROME)('the git-init box, once shown, goes away at the next keystroke and comes back after a pause', async () => {
	await open('?launch');
	await retype(`${plain}/inner`);
	await until(`!!document.querySelector('.init')`, 'the git-init box');
	await type('x');
	expect(await evaluate(`!!document.querySelector('.init')`)).toBe(false);
	await retype(`${plain}/inner`);
	await until(`!!document.querySelector('.init')`, 'the git-init box again');
});
