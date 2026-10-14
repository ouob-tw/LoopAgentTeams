// Reproduces a browser extension changing the page before it takes over the server's markup.
// Starts the built board on fake data (the test harness: temporary directories, fake helper),
// puts a proxy in front of it that is already logged in and adds a script at the top of <head>
// standing in for an extension's content script, opens the page in headless Chrome once per
// kind of change, and reports whether the board still came up.
//
//   bun run build && bun run repro:hydration                   every kind of change but `replace`
//   bun run repro:hydration style-after wrap                   only these
//   bun run repro:hydration --serve none                       keep serving, for any browser
//
// Exits 1 when a change breaks the board. `--serve none` is for a browser with a real extension.
//
// CHROME names the browser to run; LAT_BOARD_TEST_PORT_BASE moves the two ports (base + 12, 13);
// LAT_BOARD_REPRO_HOST is the address the proxy listens on (127.0.0.1).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PORT_BASE, question, startFixture } from '../tests/harness.ts';

/** What the stand-in extension does, to every stylesheet <link> as it is parsed unless it says otherwise. */
const CHANGES = {
	none: 'nothing (control)',
	'dark-reader': "Dark Reader's nodes: a sync <style> after every stylesheet, its own styles first in <head>, a <meta> last",
	'style-after': 'inserts a <style> after every stylesheet link',
	'style-before': 'inserts a <style> before every stylesheet link',
	wrap: 'wraps every stylesheet link in an element',
	// Only when named: with a built-in stylesheet link gone the board's scripts wait for it forever,
	// whatever the markup looks like.
	replace: 'replaces every stylesheet link with a <style> importing it',
	reinsert: 'removes every stylesheet link and puts it back',
	'move-to-head': 'moves stylesheet links found in <body> to the end of <head>',
	'head-edges': 'adds a <style> as the first and the last child of <head>',
	'body-edges': 'adds an element as the first and the last child of <body>'
} as const;
type Change = keyof typeof CHANGES;

const ACCENT = '#ff00aa';
const PROJECT = 'alpha';
const NAME = 'luna';
const TITLE = '要用哪個做法';

interface Report {
	errors: string[];
	errorPage: boolean;
	roster: boolean;
	inbox: boolean;
	responds: boolean;
	userStyleApplied: boolean;
	userStyleLast: boolean;
	touched: { head: number; body: number };
	/** Nodes a real Dark Reader left in the page; 0 without it. */
	darkReaderNodes: number;
}

/** Runs in the page, first thing in <head>. Self-contained: it is sent as source text. */
function contentScript(change: Change, expect: { accent: string; project: string; name: string; title: string }) {
	const errors: string[] = [];
	const text = (value: unknown) => String((value as Error | undefined)?.stack ?? value);
	window.addEventListener('error', (event) => errors.push(text(event.error ?? event.message)));
	window.addEventListener('unhandledrejection', (event) => errors.push(text(event.reason)));
	const consoleError = console.error;
	console.error = (...args: unknown[]) => {
		errors.push(args.map(text).join(' '));
		consoleError.apply(console, args);
	};

	const touched = { head: 0, body: 0 };
	const seen = new WeakSet<Element>();
	const added = (tag: string, className = '') => {
		const node = document.createElement(tag);
		node.dataset.extension = '';
		node.className = className;
		if (tag === 'style') node.textContent = '/* extension */';
		return node;
	};
	function touch(link: HTMLElement) {
		if (change === 'none' || change.endsWith('-edges') || seen.has(link)) return;
		seen.add(link);
		const inBody = link.closest('body') !== null;
		if (change === 'move-to-head' && !inBody) return;
		touched[inBody ? 'body' : 'head']++;
		if (change === 'style-after') link.after(added('style'));
		if (change === 'dark-reader') {
			const sync = added('style', 'darkreader darkreader--sync');
			sync.setAttribute('media', 'screen');
			link.after(sync);
		}
		if (change === 'style-before') link.before(added('style'));
		if (change === 'wrap') {
			const wrapper = added('span');
			link.replaceWith(wrapper);
			wrapper.append(link);
		}
		if (change === 'replace') {
			const style = added('style');
			const href = (link as HTMLLinkElement).href;
			style.dataset.href = href;
			style.textContent = `@import url(${JSON.stringify(href)});`;
			link.replaceWith(style);
		}
		if (change === 'reinsert') {
			const next = link.nextSibling;
			const parent = link.parentNode!;
			link.remove();
			parent.insertBefore(link, next);
		}
		if (change === 'move-to-head') document.head.append(link);
	}
	const edges = { head: false, bodyStart: false, bodyEnd: false };
	function sweep() {
		if (change === 'dark-reader') {
			// Its sync style follows <style> elements too, not only links.
			for (const style of document.querySelectorAll<HTMLElement>('style:not([data-extension])')) touch(style);
			if (document.head && !edges.head) {
				edges.head = true;
				const names = ['fallback', 'user-agent', 'text', 'invert', 'inline', 'override', 'variables', 'root-vars'];
				document.head.prepend(...names.map((name) => added('style', `darkreader darkreader--${name}`)));
				const meta = added('meta') as HTMLMetaElement;
				meta.name = 'darkreader';
				document.head.append(meta);
			}
		}
		for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]')) touch(link);
		if (change === 'head-edges' && document.body && !edges.head) {
			edges.head = true;
			touched.head += 2;
			document.head.prepend(added('style'));
			document.head.append(added('style'));
		}
		if (change === 'body-edges' && document.body && !edges.bodyStart) {
			edges.bodyStart = true;
			touched.body++;
			document.body.prepend(added('div'));
		}
		if (change === 'body-edges' && document.readyState !== 'loading' && !edges.bodyEnd) {
			edges.bodyEnd = true;
			touched.body++;
			document.body.append(added('div'));
		}
	}
	new MutationObserver(sweep).observe(document, { childList: true, subtree: true });
	document.addEventListener('DOMContentLoaded', sweep);

	addEventListener('load', () => {
		// Long enough for the page to take over, or to fail and show the error page.
		setTimeout(() => {
			const shown = document.body.innerText;
			document.querySelector<HTMLButtonElement>('[aria-label="收起主控名冊"]')?.click();
			const sheets = [...document.querySelectorAll<HTMLElement>('link[rel~="stylesheet"], style')].filter(
				(node) => (!('extension' in node.dataset) || 'href' in node.dataset) && !node.classList.contains('darkreader')
			);
			const source = (node: HTMLElement | undefined) => node?.dataset.href ?? (node as HTMLLinkElement | undefined)?.href ?? '';
			const report: Report = {
				errors,
				errorPage: shown.includes('Internal Error'),
				roster: shown.includes(expect.project) && shown.includes(expect.name),
				inbox: shown.includes(expect.title),
				responds: document.documentElement.dataset.roster === 'folded',
				userStyleApplied: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === expect.accent,
				userStyleLast: sheets.length > 1 && new URL(source(sheets.at(-1)), location.href).pathname === '/user.css',
				touched,
				darkReaderNodes: document.querySelectorAll('.darkreader:not([data-extension])').length
			};
			void fetch('/__repro/report', { method: 'POST', body: JSON.stringify(report) });
		}, 1500);
	});
}

const ok = (report: Report) =>
	report.errors.length === 0 &&
	!report.errorPage &&
	report.roster &&
	report.inbox &&
	report.responds &&
	report.userStyleApplied &&
	report.userStyleLast;

function findChrome(): string {
	const candidates = [
		process.env.CHROME,
		'/usr/bin/google-chrome',
		'/usr/bin/chromium',
		'/usr/bin/chromium-browser',
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
	];
	const found = candidates.find((path) => path && existsSync(path));
	if (!found) throw new Error('no Chrome found: set CHROME to a Chrome or Chromium binary, or use --serve');
	return found;
}

const args = process.argv.slice(2);
const serve = args.includes('--serve');
const chosen = args.filter((arg) => arg !== '--serve');
const unknown = chosen.filter((name) => !(name in CHANGES));
if (unknown.length || (serve && chosen.length !== 1)) {
	console.error(`usage: hydration-repro.ts [change...] | --serve <change>\nchanges:`);
	for (const [name, what] of Object.entries(CHANGES)) console.error(`  ${name.padEnd(14)}${what}`);
	process.exit(2);
}
const changes = (chosen.length ? chosen : Object.keys(CHANGES).filter((name) => name !== 'replace')) as Change[];

const fixture = await startFixture(12);
const cookie = await fixture.login('hydration-repro');
const bound = fixture.bound(PROJECT, NAME, { questions: [question({ id: 'Q-1', title: TITLE })] });
fixture.report(bound.session_id, { tag: 'NO REPLY', summary: '實作第二張票', hcom_name: NAME, workspace: bound.workspace });
fixture.list([bound]);
fixture.userStyle(`:root { --accent: ${ACCENT}; }`);
await fixture.refresh(cookie);

let change: Change = changes[0];
let received: (report: Report) => void = () => {};
const proxy = Bun.serve({
	hostname: process.env.LAT_BOARD_REPRO_HOST ?? '127.0.0.1',
	port: PORT_BASE + 13,
	idleTimeout: 0,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === '/__repro/report') {
			received(await request.json());
			return new Response(null, { status: 204 });
		}
		const headers = new Headers(request.headers);
		headers.set('cookie', cookie);
		headers.delete('host');
		headers.delete('accept-encoding');
		const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
		const upstream = await fetch(fixture.url + url.pathname + url.search, { method: request.method, headers, body, redirect: 'manual' });
		const answer = new Headers(upstream.headers);
		answer.delete('content-length');
		answer.delete('content-encoding');
		if (!upstream.headers.get('content-type')?.startsWith('text/html')) {
			return new Response(upstream.body, { status: upstream.status, headers: answer });
		}
		const expect = { accent: ACCENT, project: PROJECT, name: NAME, title: TITLE };
		const script = `<script>(${contentScript})(${JSON.stringify(change)}, ${JSON.stringify(expect)})</script>`;
		return new Response((await upstream.text()).replace('<head>', `<head>${script}`), { status: upstream.status, headers: answer });
	}
});
const address = `http://${proxy.hostname}:${proxy.port}/`;

async function visit(): Promise<Report | null> {
	const profile = mkdtempSync(join(tmpdir(), 'lat-board-repro-chrome-'));
	const chrome = spawn(
		findChrome(),
		['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`, '--window-size=1280,900', address],
		{ stdio: 'ignore' }
	);
	const exited = new Promise<null>((resolve) => chrome.once('exit', () => resolve(null)));
	let giveUp: ReturnType<typeof setTimeout>;
	const reported = new Promise<Report | null>((resolve) => {
		received = resolve;
		giveUp = setTimeout(() => resolve(null), 30_000);
	});
	// A browser that quits by itself never reports.
	const report = await Promise.race([reported, exited]);
	clearTimeout(giveUp!);
	chrome.kill('SIGKILL');
	await exited;
	rmSync(profile, { recursive: true, force: true });
	return report;
}

let failed = 0;
try {
	if (serve) {
		console.log(`${change}: ${CHANGES[change]}\nopen ${address} (already logged in); Ctrl+C stops`);
		received = (report) => console.log(ok(report) ? 'ok' : 'BROKEN', JSON.stringify(report, null, 2));
		await new Promise((resolve) => process.once('SIGINT', resolve));
	} else {
		for (change of changes) {
			const report = await visit();
			const fine = report !== null && ok(report);
			if (!fine) failed++;
			console.log(`${fine ? 'ok    ' : 'BROKEN'}  ${change.padEnd(14)}${CHANGES[change]}`);
			if (report === null) console.log('        the page never reported back');
			else if (!fine || change !== 'none') {
				const { errors, ...rest } = report;
				console.log(`        ${JSON.stringify(rest)}`);
				for (const error of errors) console.log(`        error: ${error.split('\n').slice(0, 3).join(' | ')}`);
			}
		}
	}
} finally {
	void proxy.stop(true);
	await fixture.cleanup();
}
process.exit(failed ? 1 : 0);
