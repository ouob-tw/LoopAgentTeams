// Every button on the board's main screens has the shape its kind calls for, measured from what
// Chrome draws: a button that shows only an icon or one symbol is a circle, a button of one line of
// text is a pill, and a button that is a card or a menu's row keeps the small corners, as do the
// text boxes, windows and menus. Nothing inside a pill or circle is cut, at a phone's width with the
// largest smallest-text size and on a wide screen, in both themes. Headless Chrome over its
// DevTools protocol, on the built board with fake data. Skipped when the host has no Chrome.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { withAttachments } from '../../src/lib/board/attachments.ts';
import { MIN_FONT } from '../../src/lib/board/prefs.ts';
import { NODE, question, sleep, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser } from '../browser.ts';

const injectDir = mkdtempSync(join(tmpdir(), 'lat-board-shape-inject-'));
let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;

/** Buttons that are cards or a menu's rows (several lines, or one row of a list): small corners. */
const SMALL = [
	'button.person',
	'button.agent',
	'button.main',
	'button.question',
	'button.whose',
	'button.entry',
	'button.row',
	'.picker .menu button:not(.wide)',
	'.menu [role="menuitem"]',
	'.combo li button',
	'.skills button'
];
/** Large boxes: small corners. */
const BOXES = ['textarea', 'input:not([type="checkbox"], [type="radio"], [type="file"])', 'select', 'dialog[open]', '.picker .menu', '.popup'];
/** Tabs are drawn by their underline and keep square corners. */
const TABS = ['[role="tab"]', '[data-middle]'];
/** The 待辦 view switch keeps its own corners (one frame split in three); see FOZO-UI-10. */
const OWN = ['.toggle[role="group"] button'];

type Shape = { kind: 'circle' | 'pill' | 'small' | 'box' | 'tab' | 'own' | 'multiline'; name: string; w: number; h: number; radius: number[]; drawn: boolean; cut: boolean; small: number };

/** The shape of every visible button, button-like link and large box on the page. */
const SHAPES = `(() => {
	const SMALL = ${JSON.stringify(SMALL)}, BOXES = ${JSON.stringify(BOXES)}, TABS = ${JSON.stringify(TABS)}, OWN = ${JSON.stringify(OWN)};
	const small = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--radius'));
	const seen = (element) => {
		const r = element.getBoundingClientRect();
		return r.width > 0 && r.height > 0 && getComputedStyle(element).visibility !== 'hidden';
	};
	const transparent = (colour) => colour === 'transparent' || /rgba\\(.*, 0\\)$/.test(colour);
	const read = (element, kind) => {
		const r = element.getBoundingClientRect();
		const s = getComputedStyle(element);
		const radius = ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'].map((side) => parseFloat(s[side]));
		const drawn = (parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== 'none' && !transparent(s.borderTopColor)) || !transparent(s.backgroundColor);
		// Cut: the content overflows the button, or an icon reaches outside it.
		const icons = [...element.querySelectorAll('svg')].map((svg) => svg.getBoundingClientRect());
		const cut =
			element.scrollWidth > element.clientWidth + 1 ||
			element.scrollHeight > element.clientHeight + 1 ||
			icons.some((icon) => icon.left < r.left - 0.5 || icon.right > r.right + 0.5 || icon.top < r.top - 0.5 || icon.bottom > r.bottom + 0.5);
		const classes = [...element.classList].filter((name) => !name.startsWith('svelte-')).map((name) => '.' + name).join('');
		const name = element.tagName.toLowerCase() + classes + ' ' + (element.getAttribute('aria-label') || element.innerText.trim().replace(/\\s+/g, ' ').slice(0, 30));
		return { kind, name, w: r.width, h: r.height, radius, drawn, cut, small };
	};
	const out = [];
	for (const element of document.querySelectorAll(BOXES.join(','))) if (seen(element)) out.push(read(element, 'box'));
	for (const element of document.querySelectorAll('button, a.button')) {
		if (!seen(element)) continue;
		const is = (list) => list.some((selector) => element.matches(selector));
		if (is(TABS)) out.push(read(element, 'tab'));
		else if (is(OWN)) out.push(read(element, 'own'));
		else if (is(SMALL)) out.push(read(element, 'small'));
		else if (!/[\\p{L}\\p{N}]/u.test(element.innerText)) out.push(read(element, 'circle'));
		else {
			// Its lines: the text's boxes, one more each time one starts below the ones before.
			const rects = [];
			const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				if (!node.textContent.trim()) continue;
				const range = document.createRange();
				range.selectNodeContents(node);
				rects.push(...[...range.getClientRects()].filter((rect) => rect.width > 0));
			}
			rects.sort((a, b) => a.top - b.top);
			let lines = 0, bottom = -Infinity;
			for (const rect of rects) {
				if (rect.top >= bottom - 2) lines++, (bottom = rect.bottom);
				else bottom = Math.max(bottom, rect.bottom);
			}
			out.push(read(element, lines <= 1 ? 'pill' : 'multiline'));
		}
	}
	return out;
})()`;

/** Check every shape on the page; returns the names seen, by kind. */
function check(shapes: Shape[], where: string) {
	const names: Record<string, string[]> = {};
	for (const shape of shapes) {
		(names[shape.kind] ??= []).push(shape.name);
		const label = `${where}: ${shape.kind} ${shape.name} (${shape.w.toFixed(1)}×${shape.h.toFixed(1)}, radius ${shape.radius.join('/')})`;
		const shortest = Math.min(shape.w, shape.h);
		switch (shape.kind) {
			case 'circle':
				// Pill corners on a square; a frame or fill makes it visible, so it must be square too.
				expect(Math.min(...shape.radius), label).toBeGreaterThanOrEqual(shortest / 2 - 0.5);
				if (shape.drawn) expect(Math.abs(shape.w - shape.h), label).toBeLessThanOrEqual(1);
				expect(shape.cut, `${label} is cut`).toBe(false);
				break;
			case 'pill':
				expect(Math.min(...shape.radius), label).toBeGreaterThanOrEqual(shortest / 2 - 0.5);
				expect(shape.cut, `${label} is cut`).toBe(false);
				break;
			case 'small':
			case 'box':
				// A full-screen window on a phone has no corners at all.
				if (shape.kind === 'box' && shape.name.startsWith('dialog') && shape.radius.every((r) => r === 0)) break;
				expect(shape.radius, label).toEqual([shape.small, shape.small, shape.small, shape.small]);
				break;
			case 'tab':
				expect(shape.radius, label).toEqual([0, 0, 0, 0]);
				break;
			case 'multiline':
				throw new Error(`${label}: a button of several lines that is not listed as a card`);
		}
	}
	return names;
}

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture({ env: { LAT_BOARD_INJECT_COMMAND: JSON.stringify([NODE, join(import.meta.dir, '../fake-inject.mjs'), injectDir]) } });
	cookie = await fixture.login('button-shape');
	const body = Buffer.from('# 筆記\n');
	const started = await fixture.fetch('/api/uploads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'notes.md', size: body.length }), cookie });
	const { id, path } = await started.json();
	await fixture.fetch(`/api/uploads/${id}?offset=0`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body, cookie });
	const options = ['甲', '乙'].map((label, index) => ({ letter: 'AB'[index]!, label: `${label}：${'一個很長的選項說明，'.repeat(8)}`, impact: '', recommended: index === 0 }));
	const lead = fixture.bound('lat', 'lead', {
		session_id: 's-lead',
		questions: [question({ id: 'Q-1', title: '第一題', kind: 'single', options, asked_at: '2026-10-20T01:00:00.000Z' })]
	});
	fixture.list([lead]);
	fixture.setHcom({ agents: [{ name: 'lead', session_id: 's-lead', status: 'listening' }] });
	const text = withAttachments('看附件', [path]);
	const sent = await fixture.fetch('/api/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ controllerId: 's-lead', text }), cookie });
	expect(sent.status).toBe(200);
	const decide = '請決定。\n\nDECIDE: Q-1 r1 · 第一題';
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', 's-lead.jsonl'), [{ kind: 'user', time: null, text }, { kind: 'assistant', time: null, text: decide }].map((line) => JSON.stringify(line)).join('\n') + '\n');
	writeFileSync(join(fixture.dir, 'transcripts', 's-plain.jsonl'), JSON.stringify({ kind: 'assistant', time: null, text: 'Done.' }) + '\n');
	fixture.report('s-lead', { tag: 'DECIDE', summary: '等你決定', message: decide, hcom_name: 'lead', workspace: lead.workspace });
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents: [{ agent: 'codex', agent_session: { kind: 'id', value: 's-plain' }, agent_status: 'blocked', cwd: '/work', pane_id: 'wA:p-s-plain', tab_id: 'wA:t-s-plain', workspace_id: 'wA' }],
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
			tabs: [{ tab_id: 'wA:t-s-plain', workspace_id: 'wA', label: 'plain' }]
		})
	);
	await fixture.refresh(cookie);
}, 60_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
	rmSync(injectDir, { recursive: true, force: true });
});

const tab = () => browser!.tab;
const shown = (selector: string) => `!!document.querySelector('${selector}')?.getBoundingClientRect().height`;

/** Each screen: where it is, what to click until what shows, and the buttons it must have, by kind. */
const SCREENS: { name: string; search: string; ready: string; open?: [click: string, shows: string]; wide?: boolean; expect: Partial<Record<Shape['kind'], string[]>> }[] = [
	{ name: 'overview', search: '', ready: shown('button.person'), expect: { circle: ['設定', '重新整理', '附加檔案', '語音輸入', '送出'], small: ['button.person', 'button.main'] } },
	{ name: 'controller', search: '?controller=s-lead', ready: shown('#panel-transcript .attached button'), expect: { circle: ['翻譯成中文', '附加檔案', '送出'], pill: ['送出答覆'], small: ['button.question'] } },
	{ name: 'agent', search: '?agent=s-plain', ready: shown('[data-action="close"]'), expect: { circle: ['翻譯成中文', '中斷這一回合'], pill: ['關閉 Agent'] } },
	{
		name: 'preview',
		search: '?controller=s-lead',
		ready: shown('#panel-transcript .attached button'),
		open: ['#panel-transcript .attached button', 'dialog.preview[open]'],
		expect: { pill: ['下載', '關閉'], box: ['dialog'] }
	},
	{ name: 'settings', search: '', ready: shown('button.person'), open: ['button[aria-label="設定"]', 'dialog[open]'], expect: { circle: ['調大', '放大'], pill: ['關閉', '還原預設', '深色'] } },
	{ name: 'question', search: `?item=${encodeURIComponent('q:s-lead:Q-1')}`, ready: shown('form.answer'), expect: { pill: ['送出答覆'] } },
	{
		name: 'menu',
		search: '?controller=s-lead',
		ready: shown('.pill-slot .picker .part'),
		open: ['.pill-slot .picker .part', '.pill-slot .picker .menu'],
		expect: { small: ['button'], box: ['div'] }
	},
	// Last: the roster folded into the rail stays folded on this device.
	{ name: 'rail', search: '', ready: shown('button.person'), open: ['button[aria-label="收起主控名冊"]', 'button.entry'], wide: true, expect: { circle: ['展開主控名冊'], small: ['button.entry'] } }
];

const CONFIGS = [
	{ label: 'phone, largest smallest text', width: 390, minFont: MIN_FONT.max },
	{ label: 'wide screen', width: 1280, minFont: 0 }
];

for (const theme of ['dark', 'light'] as const) {
	for (const config of CONFIGS) {
		test.skipIf(!CHROME)(`${theme} theme, ${config.label}: icon buttons are circles, one-line buttons pills, cards and boxes keep small corners`, async () => {
			await browser?.close();
			browser = await launchChrome({
				screen: `location.search + ' ' + document.body.innerText.slice(0, 1500)`,
				scripts: [`localStorage.setItem('lat-board-theme', '${theme}')`, `localStorage.setItem('lat-board-voice', '1')`, ...(config.minFont ? [`localStorage.setItem('lat-board-min-font', '${config.minFont}')`] : [])]
			});
			const [name, value] = cookie.split('=');
			await tab().send('Network.setCookie', { name, value, url: fixture.url });
			await tab().send('Emulation.setDeviceMetricsOverride', { width: config.width, height: 900, deviceScaleFactor: 1, mobile: config.width <= 760 });
			for (const screen of SCREENS) {
				if (screen.wide && config.width <= 760) continue;
				await tab().navigate(`${fixture.url}/${screen.search}`);
				await tab().until(screen.ready, `the ${screen.name} screen`);
				// Let hydration and the first data settle so nothing is rebuilt under the check.
				await sleep(400);
				if (screen.open) {
					// Clicked until it shows, on the one drawn: a click before the page is ready does nothing.
					const [click, shows] = screen.open;
					await tab().until(`${shown(shows)} || ([...document.querySelectorAll('${click}')].find((element) => element.getBoundingClientRect().height).click(), false)`, `${screen.name}: ${shows}`);
				}
				await sleep(200);
				expect(await tab().eval<string>(`document.documentElement.dataset.theme`)).toBe(theme);
				const names = check(await tab().eval<Shape[]>(SHAPES), `${theme} ${config.width}px ${screen.name}`);
				for (const [kind, wanted] of Object.entries(screen.expect)) {
					for (const part of wanted) expect(names[kind]?.some((seen) => seen.includes(part)), `${screen.name}: a ${kind} named ${part} among ${JSON.stringify(names[kind])}`).toBe(true);
				}
				const shots = process.env.BUTTON_SHAPE_SHOTS;
				if (shots) {
					const { data } = (await tab().send('Page.captureScreenshot', { format: 'png' })) as { data: string };
					mkdirSync(shots, { recursive: true });
					writeFileSync(join(shots, `${theme}-${config.width}-${screen.name}.png`), Buffer.from(data, 'base64'));
				}
			}
			// The login page, logged out in a tab of its own.
			await browser.close();
			browser = await launchChrome({ scripts: [`localStorage.setItem('lat-board-theme', '${theme}')`, ...(config.minFont ? [`localStorage.setItem('lat-board-min-font', '${config.minFont}')`] : [])] });
			await tab().send('Emulation.setDeviceMetricsOverride', { width: config.width, height: 900, deviceScaleFactor: 1, mobile: config.width <= 760 });
			await tab().navigate(`${fixture.url}/login`);
			await tab().until(shown('button.primary'), 'the login page');
			await sleep(300);
			const names = check(await tab().eval<Shape[]>(SHAPES), `${theme} ${config.width}px login`);
			expect(names.pill).toContain('button.primary 登入');
			expect(names.box?.length).toBeGreaterThan(0);
		}, 120_000);
	}
}
