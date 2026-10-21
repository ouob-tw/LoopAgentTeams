// What the server contributes to layout and appearance: the user stylesheet, the startup script
// that restores a device's settings, and the markup the roster's explanations are made of.
// How it looks and behaves in a browser is checked by hand and by QA.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FOLDED_KEY, MIN_FONT, SCALE, THEME_KEY, WIDTHS } from '../src/lib/board/prefs.ts';
import { question, startFixture, type Fixture } from './harness.ts';

let fixture: Fixture;
let cookie: string;

beforeAll(async () => {
	fixture = await startFixture();
	cookie = await fixture.login();
});
afterAll(() => fixture.cleanup());

const page = async (path = '/', paired = true) =>
	(await fixture.fetch(path, paired ? { cookie } : {})).text();

// --- User stylesheet ---------------------------------------------------------------------------

test('without a user stylesheet the board serves an empty one, not an error', async () => {
	fixture.userStyle(null);

	const response = await fixture.fetch('/user.css', { cookie });

	expect(response.status).toBe(200);
	expect(response.headers.get('content-type')).toStartWith('text/css');
	expect(await response.text()).toBe('');
});

test('a user stylesheet is served to every paired device, and edits and removal show at the next load', async () => {
	const other = await fixture.login('second-device');
	fixture.userStyle(':root { --accent: #ff00aa; --radius: 0; }');

	for (const device of [cookie, other]) {
		const response = await fixture.fetch('/user.css', { cookie: device });
		expect(response.headers.get('content-type')).toStartWith('text/css');
		// Never cached: a reload is all it takes to see a change.
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.text()).toBe(':root { --accent: #ff00aa; --radius: 0; }');
	}

	fixture.userStyle(':root { --accent: #00ffaa; }');
	expect(await (await fixture.fetch('/user.css', { cookie: other })).text()).toBe(':root { --accent: #00ffaa; }');

	fixture.userStyle(null);
	const removed = await fixture.fetch('/user.css', { cookie });
	expect(removed.status).toBe(200);
	expect(await removed.text()).toBe('');
});

test('a user stylesheet that cannot be read is served as an empty one', async () => {
	fixture.userStyle(null);
	mkdirSync(join(fixture.dir, 'board-config/user.css'), { recursive: true });

	const response = await fixture.fetch('/user.css', { cookie });

	expect(response.status).toBe(200);
	expect(await response.text()).toBe('');
	rmSync(join(fixture.dir, 'board-config/user.css'), { recursive: true });
});

test('the board page loads the user stylesheet after every built-in style', async () => {
	const html = await page();

	const user = html.indexOf('<link rel="stylesheet" href="/user.css"');
	expect(user).toBeGreaterThan(-1);
	const builtIn = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*>|<style[\s>]/g)].filter(
		(match) => !match[0].includes('/user.css')
	);
	expect(builtIn.length).toBeGreaterThan(0);
	for (const style of builtIn) expect(style.index).toBeLessThan(user);
	// It is the last thing in the head, so the content is never painted without it.
	expect(html.slice(user)).toMatch(/^<link rel="stylesheet" href="\/user\.css" \/>\s*<\/head>/);
});

test('no stylesheet sits inside the markup the page takes over', async () => {
	// Extensions add and move nodes next to stylesheets before the page starts; inside the markup
	// the page takes over, that breaks the board (a 500 page). See scripts/hydration-repro.ts.
	for (const html of [await page(), await page('/login', false)]) {
		const body = html.slice(html.indexOf('<body'));
		expect(body).toContain('<div style="display: contents">');
		expect(body).not.toMatch(/<link\b|<style[\s>]/);
	}
});

test('an unpaired device gets neither the user stylesheet nor a reference to it', async () => {
	fixture.userStyle(':root { --accent: #ff00aa; }');

	const response = await fixture.fetch('/user.css');

	expect(response.status).toBe(303);
	expect(await response.text()).not.toContain('#ff00aa');
	expect(await page('/login', false)).not.toContain('user.css');
	fixture.userStyle(null);
});

// --- Startup script ----------------------------------------------------------------------------

/** Run the page's startup script against a stand-in for the browser. */
async function startUp(saved: Record<string, string> | 'blocked' | 'throwing') {
	const script = /<script>([\s\S]*?)<\/script>/.exec(await page('/login', false))?.[1];
	if (!script) throw new Error('the page has no inline startup script');
	const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
	const style = { setProperty: (name: string, value: string) => void (root.style[name] = value) };
	const browser = {
		document: { documentElement: { dataset: root.dataset, style } },
		get localStorage() {
			if (saved === 'blocked') throw new Error('SecurityError');
			if (saved === 'throwing') return { getItem: () => { throw new Error('SecurityError'); } };
			return { getItem: (key: string) => saved[key] ?? null };
		}
	};
	new Function('browser', `with (browser) { ${script} }`)(browser);
	return root;
}

test('the startup script puts back the theme, overall size, folded roster and column widths', async () => {
	const root = await startUp({
		[THEME_KEY]: 'light',
		[SCALE.key]: '120',
		[MIN_FONT.key]: '14',
		[FOLDED_KEY]: '1',
		[WIDTHS.roster.key]: '300',
		[WIDTHS.inbox.key]: '520'
	});

	expect(root.dataset).toEqual({ theme: 'light', roster: 'folded' });
	expect(root.style).toEqual({ '--ui-scale': '1.2', '--min-font': '14px', '--roster-w': '300px', '--inbox-w': '520px' });
});

test('the startup script accepts the limits of prefs.ts and nothing beyond them', async () => {
	const atLimits = await startUp({
		[SCALE.key]: String(SCALE.max),
		[WIDTHS.roster.key]: String(WIDTHS.roster.min),
		[WIDTHS.inbox.key]: String(WIDTHS.inbox.max)
	});
	expect(atLimits.style).toEqual({
		'--ui-scale': String(SCALE.max / 100),
		'--roster-w': `${WIDTHS.roster.min}px`,
		'--inbox-w': `${WIDTHS.inbox.max}px`
	});
	const lowest = await startUp({
		[SCALE.key]: String(SCALE.min),
		[WIDTHS.roster.key]: String(WIDTHS.roster.max),
		[WIDTHS.inbox.key]: String(WIDTHS.inbox.min)
	});
	expect(lowest.style).toEqual({
		'--ui-scale': String(SCALE.min / 100),
		'--roster-w': `${WIDTHS.roster.max}px`,
		'--inbox-w': `${WIDTHS.inbox.min}px`
	});

	const beyond: Record<string, string>[] = [
		{ [THEME_KEY]: 'sepia', [FOLDED_KEY]: 'yes', [SCALE.key]: 'big', [WIDTHS.roster.key]: '', [WIDTHS.inbox.key]: 'wide' },
		{ [MIN_FONT.key]: String(MIN_FONT.max + 1), [SCALE.key]: String(SCALE.max + 1), [WIDTHS.roster.key]: String(WIDTHS.roster.max + 1), [WIDTHS.inbox.key]: String(WIDTHS.inbox.max + 1) },
		{ [MIN_FONT.key]: String(MIN_FONT.min - 1), [SCALE.key]: String(SCALE.min - 1), [WIDTHS.roster.key]: String(WIDTHS.roster.min - 1), [WIDTHS.inbox.key]: String(WIDTHS.inbox.min - 1) }
	];
	for (const saved of beyond) {
		const root = await startUp(saved);
		expect(root.dataset).toEqual({ theme: 'dark' });
		expect(root.style).toEqual({});
	}
});

test('with nothing saved the startup script leaves the defaults', async () => {
	const root = await startUp({});

	expect(root.dataset).toEqual({ theme: 'dark' });
	expect(root.style).toEqual({});
});

test.each(['blocked', 'throwing'] as const)('with browser storage %s the startup script changes nothing and does not fail', async (storage) => {
	const root = await startUp(storage);

	expect(root.dataset).toEqual({});
	expect(root.style).toEqual({});
});

// --- Roster markup -----------------------------------------------------------------------------

const LONG_NAME = 'luna-lat-handoff-nova-next-miro-fix42-vega';

test('a long controller name is whole on the card and in the rail explanation', async () => {
	const long = fixture.bound('alpha', LONG_NAME, { questions: [question({ id: 'Q-1' }), question({ id: 'Q-2' })] });
	fixture.report(long.session_id, { tag: 'NO REPLY', summary: '實作第二張票', hcom_name: LONG_NAME, workspace: long.workspace });
	fixture.list([long]);
	await fixture.refresh(cookie);

	const html = await page();

	// The roster card and phone tag: project and full name, then the phase; hovering or a long
	// press explains it whole, as the folded rail's mark is explained.
	expect(html).toMatch(new RegExp(`<button[^>]*class="person[^>]*>[^]*?alpha[^]*?@${LONG_NAME}[^]*?實作第二張票`));
	// The folded rail's mark says whose it is, its status and how many questions wait.
	expect(html).toMatch(new RegExp(`<button[^>]*class="entry[^>]*aria-label="alpha @${LONG_NAME}：等你，待決 2 題"`));
});

test('the page offers the settings entry, the fold control and both column handles', async () => {
	const html = await page();

	expect(html).toContain('aria-label="設定"');
	expect(html).toContain('aria-label="收起主控名冊"');
	expect(html).toContain('aria-label="展開主控名冊"');
	expect(html.match(/role="separator"/g)).toHaveLength(2);
	// The settings dialog offers both themes and the overall size with a way back to the default.
	for (const text of ['深色', '淺色（高對比）', 'aria-label="縮小"', 'aria-label="放大"', '還原預設']) expect(html).toContain(text);
	// And a floor for the text size, off until it is raised.
	for (const text of ['最小字體', 'aria-label="調小"', 'aria-label="調大"']) expect(html).toContain(text);
});
