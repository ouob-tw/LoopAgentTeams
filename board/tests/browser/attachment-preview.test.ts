// Attached files previewed in a real browser, in the sent log and in the conversation: Markdown laid
// out and any other text as it is, inside a window over the page; an image at full size in the same
// window; a PDF in a tab of its own, in Chrome's viewer; anything else still downloads. Nothing in a
// file runs, a long text shows its first 200KB only, and the window closes by Esc, a click around it
// or 關閉, leaving the page where it was.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { withAttachments } from '../../src/lib/board/attachments.ts';
import { NODE, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, Tab, type Browser } from '../browser.ts';

/** A 1×1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** A PNG `width` × `height`, one colour. */
function png(width: number, height: number): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([length, body, crc]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 2, 0, 0, 0], 8);
	const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x60)]);
	const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]);
}
function crc32(bytes: Buffer): number {
	let crc = ~0;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return ~crc >>> 0;
}

/** A one-page PDF that says PREVIEW PDF. */
function pdf(): Buffer {
	const text = 'BT /F1 24 Tf 40 60 Td (PREVIEW PDF) Tj ET';
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
		`<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
	];
	let out = '%PDF-1.4\n';
	const offsets = objects.map((object, index) => {
		const offset = out.length;
		out += `${index + 1} 0 obj\n${object}\nendobj\n`;
		return offset;
	});
	const xref = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out);
}

// Probes: each would set window.pwned if it ever ran.
const PROBES = '<script>window.pwned = 1</script><img src=x onerror="window.pwned = 2"><b onclick="window.pwned = 3">粗體標籤</b>';
const MARKDOWN = `# 預覽標題\n\n- 第一點\n- 第二點\n\n${PROBES}\n\n[壞連結](javascript:window.pwned=4)\n\n${'很長的一行'.repeat(80)}\n\n\`\`\`\n${'code_without_any_break_'.repeat(30)}\n\`\`\`\n\n| ${Array.from({ length: 8 }, (_, index) => `column_heading_${index}_long`).join(' | ')} |\n|${' --- |'.repeat(8)}\n| ${'cell_value_that_is_long '.repeat(8).trim().split(' ').join(' | ')} |\n`;
/** A long name, cut to fit on the host as any long name is. */
const LONG = `${'很長的附件檔名'.repeat(12)}.md`;
/** An image far larger than a phone's screen. */
const WIDE = '<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="2000"><rect width="3000" height="2000" fill="teal"/></svg>';
/** A phone's screenshot, upright, under the long name a phone gives it. */
const SHOT = 'Screenshot_2026-10-24-12-00-00-123_com.android.chrome.png';
/** A name whose wide characters before a long extension fill a phone's title by themselves. */
const WIDE_TAIL = 'Screenshot_畫面截圖測試.svelte';
const PYTHON = 'def main():\n    if True:\n        print("縮排")\n\n\treturn  # tab\n';
const TEXT = `第一行\n  兩格縮排\n${'longwordwithoutspaces'.repeat(40)}\n`;
const TAIL = 'TAIL-MARKER-PAST-200KB';
// 204,799 ASCII bytes and a 3-byte character across the cut, then the tail.
const BIG = `${'a'.repeat(200 * 1024 - 1)}一${'b'.repeat(100_000)}${TAIL}\n`;
const BIG_MARKDOWN = `# 很長的筆記\n\n${'- 一項\n'.repeat(40_000)}${TAIL}\n`;

const injectDir = mkdtempSync(join(tmpdir(), 'lat-board-preview-inject-'));
const downloads = mkdtempSync(join(tmpdir(), 'lat-board-preview-downloads-'));
let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;
const paths: Record<string, string> = {};
let session: string;

async function upload(name: string, bytes: Buffer | string): Promise<string> {
	const body = Buffer.from(bytes);
	const started = await fixture.fetch('/api/uploads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, size: body.length }), cookie });
	const { id, path } = await started.json();
	for (let offset = 0; offset < body.length; offset += 256 * 1024) {
		const put = await fixture.fetch(`/api/uploads/${id}?offset=${offset}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: body.subarray(offset, offset + 256 * 1024), cookie });
		expect(put.status).toBe(200);
	}
	return path;
}

beforeAll(async () => {
	fixture = await startFixture({ env: { LAT_BOARD_INJECT_COMMAND: JSON.stringify([NODE, join(import.meta.dir, '../fake-inject.mjs'), injectDir]) } });
	cookie = await fixture.login('attachment-preview');
	const files: Record<string, Buffer | string> = {
		'notes.md': MARKDOWN,
		[LONG]: '# 長檔名\n',
		'big.md': BIG_MARKDOWN,
		'wide.svg': WIDE,
		'main.py': PYTHON,
		'plain.txt': TEXT,
		'page.html': PROBES,
		'big.log': BIG,
		'empty.txt': '',
		'pixel.png': PNG,
		[SHOT]: png(1080, 2400),
		[WIDE_TAIL]: '<p>畫面</p>\n',
		'report.pdf': pdf(),
		'letter.docx': 'not really a word file',
		'bundle.zip': 'PK not really a zip',
		'vanish.txt': 'soon gone',
		'vanish.png': PNG
	};
	for (const [name, bytes] of Object.entries(files)) paths[name] = await upload(name, bytes);

	const lead = fixture.bound('lat', 'lead', { session_id: 's-lead' });
	session = lead.session_id;
	fixture.list([lead]);
	fixture.setHcom({ agents: [{ name: 'lead', session_id: 's-lead', status: 'listening' }] });
	const text = withAttachments('看附件', Object.values(paths));
	const sent = await fixture.fetch('/api/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ controllerId: session, text }), cookie });
	expect(sent.status).toBe(200);
	// The same message, as the conversation holds it, with a few lines before it to scroll past.
	const filler = Array.from({ length: 40 }, (_, index) => ({ kind: 'assistant', time: null, text: `前面的回覆 ${index}` }));
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', `${session}.jsonl`), [...filler, { kind: 'user', time: null, text }, ...filler].map((line) => JSON.stringify(line)).join('\n') + '\n');
	await fixture.refresh(cookie);
}, 60_000);

afterEach(async () => {
	await browser?.close();
	browser = undefined;
});

afterAll(async () => {
	await fixture?.cleanup();
	rmSync(injectDir, { recursive: true, force: true });
	rmSync(downloads, { recursive: true, force: true });
});

/** The page's reads of attachments: URL, method, Range header, status and bytes received. */
const RECORD = `window.reads = []; const original = window.fetch; window.fetch = async (input, init) => {
	const response = await original(input, init);
	if (String(input).includes('/api/uploads/file')) {
		const bytes = init?.method === 'HEAD' ? 0 : (await response.clone().arrayBuffer()).byteLength;
		window.reads.push({ url: String(input), method: init?.method ?? 'GET', range: new Headers(init?.headers).get('range'), status: response.status, bytes });
	}
	return response;
};`;

const SENT = '#panel-sent:not([hidden])';
const TRANSCRIPT = '#panel-transcript';
const DIALOG = 'dialog.preview[open]';

/** The board in a new Chrome, `width` × `height`; `touch` makes it a phone or tablet with a touch
 *  screen, `minFont` sets the smallest text size. */
async function visit(where: 'sent' | 'transcript', width = 1280, { height = 800, touch = false, minFont }: { height?: number; touch?: boolean; minFont?: number } = {}) {
	browser = await launchChrome({
		screen: `document.querySelector('${DIALOG}')?.innerText ?? document.body.innerText`,
		scripts: minFont ? [`localStorage.setItem('lat-board-min-font', '${minFont}')`] : []
	});
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: touch || width <= 760 });
	if (touch) await tab.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
	await tab.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
	await tab.navigate(`${fixture.url}/?controller=${session}`);
	await tab.eval(RECORD);
	if (where === 'sent') await showSent();
	await tab.until(`!!document.querySelector('${scope(where)} .attached img')`, 'the attachments');
}

/** The sent log's tab, clicked until its panel shows: a click before the page is ready does nothing. */
async function showSent() {
	await tab.until(`(document.querySelector('#tab-sent')?.click(), !!document.querySelector('${SENT}'))`, 'the sent log');
}

const scope = (where: 'sent' | 'transcript') => (where === 'sent' ? SENT : `${TRANSCRIPT} li.said[data-kind="user"]`);

/** The attachment entry of a file, in the list of `where`. */
const entry = (where: 'sent' | 'transcript', name: string) =>
	`[...document.querySelectorAll('${scope(where)} .attached li')].find((li) => li.title === ${JSON.stringify(paths[name])})`;

async function openPreview(where: 'sent' | 'transcript', name: string) {
	await tab.eval(`${entry(where, name)}.querySelector('button').click()`);
	await tab.until(`!!document.querySelector('${DIALOG}')`, `the preview of ${name}`);
}

const dialogText = () => tab.eval<string>(`document.querySelector('${DIALOG} .content').innerText`);

for (const where of ['sent', 'transcript'] as const) {
	test(`${where}: Markdown is laid out and nothing in it runs; other text keeps its lines and indents`, async () => {
		await visit(where);
		await openPreview(where, 'notes.md');
		await tab.until(`!!document.querySelector('${DIALOG} .md h1')`, 'the Markdown laid out');
		expect(await tab.eval<string>(`document.querySelector('${DIALOG} h2').textContent`)).toBe('notes.md');
		expect(await tab.eval<number>(`document.querySelectorAll('${DIALOG} .md li').length`)).toBe(2);
		// Raw HTML is text, a javascript: link is not a link, and none of the probes ran.
		expect(await dialogText()).toContain('<script>window.pwned = 1');
		expect(await tab.eval<number>(`document.querySelectorAll('${DIALOG} .md :is(script, img, b, a[href^="javascript"])').length`)).toBe(0);
		await tab.eval(`document.querySelector('${DIALOG} .md').click()`);
		await tab.eval('new Promise((resolve) => setTimeout(resolve, 300))');
		expect(await tab.eval('window.pwned ?? null')).toBeNull();
		// A click inside the window leaves it open.
		expect(await tab.eval<boolean>(`!!document.querySelector('${DIALOG}')`)).toBe(true);
		await tab.eval(`document.querySelector('${DIALOG} button').click()`);
		await tab.until(`!document.querySelector('${DIALOG}')`, 'the window closed by 關閉');

		for (const [name, text] of [
			['main.py', PYTHON],
			['plain.txt', TEXT],
			['page.html', PROBES]
		]) {
			await openPreview(where, name);
			await tab.until(`!!document.querySelector('${DIALOG} pre')`, `${name} as text`);
			// The same characters, line breaks and indents as the file, in a fixed-width font.
			expect(await tab.eval<string>(`document.querySelector('${DIALOG} pre').textContent`)).toBe(text);
			expect(await tab.eval<string>(`getComputedStyle(document.querySelector('${DIALOG} pre')).whiteSpace`)).toBe('pre-wrap');
			expect(await tab.eval<string>(`getComputedStyle(document.querySelector('${DIALOG} pre')).fontFamily`)).toMatch(/mono/i);
			expect(await tab.eval<number>(`document.querySelectorAll('${DIALOG} .content :is(script, img, b)').length`)).toBe(0);
			await tab.eval(`document.querySelector('${DIALOG}').close()`);
		}
		expect(await tab.eval('window.pwned ?? null')).toBeNull();
		expect(tab.errors).toEqual([]);
	}, 60_000);

	test(`${where}: an image opens at full size in the window, not in a new tab`, async () => {
		await visit(where);
		const pages = async () => (await fetch(`http://127.0.0.1:${browser!.debugPort}/json/list`).then((response) => response.json())).filter((target: { type: string }) => target.type === 'page').length;
		const before = await pages();
		await tab.eval(`${entry(where, 'pixel.png')}.scrollIntoView()`);
		await tab.until(`${entry(where, 'pixel.png')}.querySelector('img').naturalWidth === 1`, 'the thumbnail');
		await openPreview(where, 'pixel.png');
		await tab.until(`document.querySelector('${DIALOG} .content img')?.naturalWidth === 1`, 'the image at full size');
		expect(await tab.eval<string>(`document.querySelector('${DIALOG} a[download]').getAttribute('href')`)).toBe(`/api/uploads/file?path=${encodeURIComponent(paths['pixel.png'])}`);
		expect(await pages()).toBe(before);
		// 下載 saves the file and leaves the board where it is.
		const board = await tab.eval<string>('location.href');
		await tab.eval(`document.querySelector('${DIALOG} header a[download]').click()`);
		// Under the name it was uploaded as, without the board's upload number.
		const file = join(downloads, 'pixel.png');
		const deadline = Date.now() + 10_000;
		while (!existsSync(file) && Date.now() < deadline) await Bun.sleep(100);
		expect(readFileSync(file)).toEqual(PNG);
		rmSync(file);
		expect(await tab.eval<string>('location.href')).toBe(board);
	}, 60_000);
}

test('Esc, a click around the window and 關閉 each close it, and the page stays where it was', async () => {
	await visit('transcript');
	const scroller = `(() => { let node = ${entry('transcript', 'notes.md')}; while (node && !(node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY))) node = node.parentElement; return node ?? document.scrollingElement; })()`;
	await tab.eval(`${entry('transcript', 'notes.md')}.scrollIntoView({ block: 'center' })`);
	// Thumbnails that load later move the page by themselves.
	await tab.until(`[...document.querySelectorAll('${scope('transcript')} .attached img')].every((img) => img.complete && img.naturalWidth > 0)`, 'the thumbnails loaded');
	const position = () => tab.eval<number>(`${scroller}.scrollTop`);
	expect(await position()).toBeGreaterThan(0);

	const closers: [string, () => Promise<unknown>][] = [
		['Esc', () => tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).then(() => tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }))],
		['a click around it', () => Promise.all(['mouseMoved', 'mousePressed', 'mouseReleased'].map((type) => tab.send('Input.dispatchMouseEvent', { type, x: 5, y: 400, button: 'left', clickCount: 1 })))],
		['關閉', () => tab.pointerClick(`${DIALOG} header button`)]
	];
	for (const name of ['plain.txt', 'pixel.png']) {
		for (const [how, close] of closers) {
			// Focusing the opener, as clicking it would, may bring it into view: the place to return to is after that.
			await tab.eval(`${entry('transcript', name)}.querySelector('button').focus()`);
			const at = await position();
			await openPreview('transcript', name);
			// Inside the window, a click does not close it.
			await tab.pointerClick(`${DIALOG} h2`);
			expect(await tab.eval<boolean>(`!!document.querySelector('${DIALOG}')`)).toBe(true);
			await close();
			await tab.until(`!document.querySelector('${DIALOG}')`, `${name} closed by ${how}`);
			expect(await position()).toBe(at);
			expect(await tab.eval<boolean>(`document.activeElement === ${entry('transcript', name)}.querySelector('button')`)).toBe(true);
		}
	}
	// A file opened while another is still being read shows its own content, not the other's.
	await tab.eval(`${entry('transcript', 'big.log')}.querySelector('button').click(); document.querySelector('dialog.preview[open]').close(); ${entry('transcript', 'main.py')}.querySelector('button').click()`);
	await tab.until(`document.querySelector('${DIALOG} pre')?.textContent === ${JSON.stringify(PYTHON)}`, 'main.py, not big.log');
	await Bun.sleep(500);
	expect(await tab.eval<string>(`document.querySelector('${DIALOG} pre').textContent`)).toBe(PYTHON);
	await tab.eval(`document.querySelector('${DIALOG}').close()`);
	// Another file opened after one closed shows its own content, not the last one's.
	await openPreview('transcript', 'main.py');
	await tab.until(`document.querySelector('${DIALOG} pre')?.textContent === ${JSON.stringify(PYTHON)}`, 'main.py, not plain.txt');
	await tab.eval(`document.querySelector('${DIALOG}').close()`);
	await openPreview('transcript', 'empty.txt');
	await tab.until(`!!document.querySelector('${DIALOG} pre')`, 'the empty file');
	expect(await tab.eval<string>(`document.querySelector('${DIALOG} pre').textContent`)).toBe('');
}, 60_000);

test('a text over 200KB shows its first 204,800 bytes only, says so, and downloads whole', async () => {
	await visit('sent');
	await openPreview('sent', 'big.log');
	await tab.until(`!!document.querySelector('${DIALOG} pre')`, 'the start of big.log');
	expect(await tab.eval<string>(`document.querySelector('${DIALOG} .truncated').innerText`)).toContain('只顯示開頭 200KB');
	const shown = await tab.eval<string>(`document.querySelector('${DIALOG} pre').textContent`);
	// The character the cut splits is left out, and nothing past the cut is there.
	expect(shown).toBe('a'.repeat(200 * 1024 - 1));
	expect(shown).not.toContain(TAIL);
	const reads = await tab.eval<{ url: string; method: string; range: string | null; bytes: number }[]>(`window.reads.filter((read) => read.method === 'GET')`);
	expect(reads).toEqual([{ url: `/api/uploads/file?path=${encodeURIComponent(paths['big.log'])}`, method: 'GET', range: 'bytes=0-204799', status: 206, bytes: 204_800 } as never]);

	await tab.eval(`document.querySelector('${DIALOG} .truncated a').click()`);
	const file = join(downloads, 'big.log');
	const deadline = Date.now() + 10_000;
	while (!existsSync(file) && Date.now() < deadline) await Bun.sleep(100);
	expect(readFileSync(file, 'utf8')).toBe(BIG);

	// Markdown over 200KB: its start laid out, with the same note.
	await openPreview('sent', 'big.md');
	await tab.until(`!!document.querySelector('${DIALOG} .md h1')`, 'the start of big.md laid out');
	expect(await tab.eval<string>(`document.querySelector('${DIALOG} .truncated').innerText`)).toContain('只顯示開頭 200KB');
	const items = await tab.eval<number>(`document.querySelectorAll('${DIALOG} .md li').length`);
	expect(items).toBeGreaterThan(10_000);
	expect(items).toBeLessThan(40_000);
	expect(await dialogText()).not.toContain(TAIL);
}, 60_000);

test('a Word file and an archive still download, and open no window', async () => {
	await visit('sent');
	for (const name of ['letter.docx', 'bundle.zip']) {
		expect(await tab.eval<number>(`${entry('sent', name)}.querySelectorAll('a.file[download]').length`)).toBe(1);
		await tab.eval(`${entry('sent', name)}.querySelector('a.file').click()`);
		const file = join(downloads, name);
		const deadline = Date.now() + 10_000;
		while (!existsSync(file) && Date.now() < deadline) await Bun.sleep(100);
		expect(readFileSync(file, 'utf8')).toBe(readFileSync(paths[name], 'utf8'));
		expect(await tab.eval<boolean>(`!!document.querySelector('${DIALOG}')`)).toBe(false);
	}
}, 60_000);

test('a file gone between the list and opening it says so, and opens no window', async () => {
	await visit('sent');
	await tab.until(`window.reads.some((read) => read.method === 'HEAD' && read.url.includes(${JSON.stringify(encodeURIComponent(paths['vanish.txt']))}) && read.status === 200)`, 'the file there when listed');
	renameSync(paths['vanish.txt'], `${paths['vanish.txt']}.moved`);
	try {
		await tab.eval(`${entry('sent', 'vanish.txt')}.querySelector('button').click()`);
		await tab.until(`document.querySelector('${SENT}').innerText.includes(${JSON.stringify(`檔案已不在：${paths['vanish.txt']}`)})`, 'the missing file noted');
		expect(await tab.eval<boolean>(`!!document.querySelector('${DIALOG}')`)).toBe(false);
	} finally {
		renameSync(`${paths['vanish.txt']}.moved`, paths['vanish.txt']);
	}
}, 60_000);

test('an image gone after its thumbnail loaded says so when clicked, instead of showing the copy the page still holds', async () => {
	await visit('sent');
	await tab.eval(`${entry('sent', 'vanish.png')}.scrollIntoView()`);
	await tab.until(`${entry('sent', 'vanish.png')}.querySelector('img').naturalWidth === 1`, 'the thumbnail loaded');
	renameSync(paths['vanish.png'], `${paths['vanish.png']}.moved`);
	try {
		await tab.eval(`${entry('sent', 'vanish.png')}.querySelector('button').click()`);
		await tab.until(`document.querySelector('${SENT}').innerText.includes(${JSON.stringify(`檔案已不在：${paths['vanish.png']}`)})`, 'the missing image noted');
		expect(await tab.eval<boolean>(`!!document.querySelector('${DIALOG}')`)).toBe(false);
	} finally {
		renameSync(`${paths['vanish.png']}.moved`, paths['vanish.png']);
	}
}, 60_000);

test('at 390px the window fills the screen and nothing scrolls sideways', async () => {
	await visit('transcript', 390);
	for (const name of ['notes.md', LONG, 'plain.txt', 'wide.svg']) {
		await openPreview('transcript', name);
		await tab.until(`!!document.querySelector('${DIALOG} :is(.md, pre, .content img)')`, name);
		const layout = await tab.eval<{ width: number; height: number; left: number; top: number; viewport: number; tall: number; page: number; content: number; contentWidth: number; sideways: string[]; buttons: boolean }>(`(() => {
			const dialog = document.querySelector('${DIALOG}').getBoundingClientRect();
			const content = document.querySelector('${DIALOG} .content');
			const inView = (element) => { const r = element.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.width > 0; };
			return { width: dialog.width, height: dialog.height, left: dialog.left, top: dialog.top, viewport: innerWidth, tall: innerHeight, page: document.scrollingElement.scrollWidth, content: content.scrollWidth, contentWidth: content.clientWidth, sideways: [content, ...content.querySelectorAll('*')].filter((element) => element.clientWidth && element.scrollWidth > element.clientWidth).map((element) => element.tagName), buttons: [...document.querySelectorAll('${DIALOG} header :is(a, button)')].every(inView) };
		})()`);
		expect(layout.viewport).toBe(390);
		expect(layout).toMatchObject({ width: 390, height: layout.tall, left: 0, top: 0, page: 390, buttons: true, sideways: [] });
		expect(layout.content).toBeLessThanOrEqual(layout.contentWidth);
		await tab.eval(`document.querySelector('${DIALOG}').close()`);
	}
}, 60_000);

/**
 * Chrome as the user runs it, with its process sandbox on: the PDF viewer draws nothing in a Chrome
 * started with --no-sandbox, as the other browser tests start it.
 */
async function sandboxedChrome(): Promise<{ debugPort: number; tab: Tab; close: () => void }> {
	const profile = mkdtempSync(join(tmpdir(), 'lat-board-test-chrome-'));
	const chrome = spawn(CHROME, ['--headless=new', '--no-first-run', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore', detached: true });
	const close = () => {
		try {
			process.kill(-chrome.pid!, 'SIGKILL');
		} catch {}
		rmSync(profile, { recursive: true, force: true });
	};
	try {
		const file = join(profile, 'DevToolsActivePort');
		const deadline = Date.now() + 10_000;
		while (!(existsSync(file) && readFileSync(file, 'utf8').includes('\n'))) {
			if (Date.now() > deadline || chrome.exitCode !== null) throw new Error('Chrome with its sandbox did not start');
			await Bun.sleep(50);
		}
		const debugPort = Number(readFileSync(file, 'utf8').split('\n')[0]);
		return { debugPort, tab: await Tab.open(debugPort), close };
	} catch (error) {
		close();
		throw error;
	}
}

test('a PDF opens in a new tab and Chrome’s viewer shows its page', async () => {
	const chrome = await sandboxedChrome();
	try {
		tab = chrome.tab;
		const [name, value] = cookie.split('=');
		await tab.send('Network.setCookie', { name, value, url: fixture.url });
		await tab.navigate(`${fixture.url}/?controller=${session}`);
		await showSent();
		await tab.until(`!!${entry('sent', 'report.pdf')}?.querySelector('a.file[target="_blank"]')`, 'the PDF link');
		// A click of the user's: a page's own click() opens no tab.
		await tab.eval(`${entry('sent', 'report.pdf')}.querySelector('a.file').id = 'pdf-link'`);
		await tab.eval(`document.querySelector('#pdf-link').scrollIntoView({ block: 'center' })`);
		await tab.pointerClick('#pdf-link');
		const url = `${fixture.url}/api/uploads/file?path=${encodeURIComponent(paths['report.pdf'])}`;
		const targets = () => fetch(`http://127.0.0.1:${chrome.debugPort}/json/list`).then((response) => response.json() as Promise<{ type: string; url: string; webSocketDebuggerUrl: string }[]>);
		let state = '';
		const deadline = Date.now() + 20_000;
		while (state !== 'success' && Date.now() < deadline) {
			await Bun.sleep(250);
			const list = await targets();
			const viewer = list.find((target) => target.type === 'webview' && target.url.startsWith('chrome-extension://'));
			if (!list.some((target) => target.type === 'page' && target.url === url) || !viewer) continue;
			const socket = new WebSocket(viewer.webSocketDebuggerUrl);
			await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
			const inside = new Tab(socket);
			state = await inside.eval<string>(`document.querySelector('pdf-viewer')?.loadState_ ?? ''`).catch(() => '');
			inside.close();
		}
		// The board's own tab is still the board.
		expect(await tab.eval<boolean>(`!!document.querySelector('#tab-sent')`)).toBe(true);
		expect(state, JSON.stringify((await targets()).map((target) => [target.type, target.url]))).toBe('success');
	} finally {
		chrome.close();
	}
}, 60_000);

/** The title's parts: its text, how many lines it takes, whether its start is cut short, how wide
 *  its start shows, whether its extension is whole and clear of the buttons, and whether the
 *  buttons are in the window. */
const TITLE = `(() => {
	const h2 = document.querySelector('${DIALOG} h2');
	const start = h2.querySelector('.start');
	const extension = h2.querySelector('.extension').getBoundingClientRect();
	const download = document.querySelector('${DIALOG} header a[download]');
	const range = document.createRange();
	range.selectNodeContents(h2);
	const inView = (element) => { const r = element.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.width > 0; };
	return {
		text: h2.textContent,
		extension: h2.querySelector('.extension').textContent,
		lines: new Set([...range.getClientRects()].filter((rect) => rect.width).map((rect) => Math.round(rect.top))).size,
		cut: start.scrollWidth > start.clientWidth,
		startShown: start.getBoundingClientRect().width,
		extensionShown: extension.left >= h2.getBoundingClientRect().left && extension.right <= h2.getBoundingClientRect().right + 0.5 && extension.right <= download.getBoundingClientRect().left,
		download: download.getAttribute('download'),
		buttons: [...document.querySelectorAll('${DIALOG} header :is(a, button)')].every(inView)
	};
})()`;
type Title = { text: string; extension: string; lines: number; cut: boolean; startShown: number; extensionShown: boolean; download: string; buttons: boolean };

test('at 390px with the largest text the title is one line: the uploaded name, its start cut short, its extension kept', async () => {
	await visit('transcript', 390, { touch: true, minFont: 24 });
	await openPreview('transcript', SHOT);
	const long = await tab.eval<Title>(TITLE);
	expect(long).toMatchObject({ text: SHOT, extension: '.png', lines: 1, cut: true, extensionShown: true, download: SHOT, buttons: true });
	// The start keeps its first characters, and some of the characters before the extension show.
	expect(long.startShown).toBeGreaterThanOrEqual(2.9 * 24);
	expect(await tab.eval<number>(`document.querySelector('${DIALOG} h2 .tail').clientWidth`)).toBeGreaterThan(24);
	expect(await tab.eval<string>(`document.querySelector('${DIALOG} h2').title`)).toBe(paths[SHOT]);
	await tab.eval(`document.querySelector('${DIALOG}').close()`);
	// Wide characters before a long extension: the start keeps its first characters and the
	// extension stays whole, clear of the buttons; the characters between give way.
	await openPreview('transcript', WIDE_TAIL);
	const wide = await tab.eval<Title>(TITLE);
	expect(wide).toMatchObject({ text: WIDE_TAIL, extension: '.svelte', lines: 1, cut: true, extensionShown: true, buttons: true });
	expect(wide.startShown).toBeGreaterThanOrEqual(2.9 * 24);
	await tab.eval(`document.querySelector('${DIALOG}').close()`);
	// A short name whole, with no … in it.
	await openPreview('transcript', 'pixel.png');
	expect(await tab.eval(TITLE)).toMatchObject({ text: 'pixel.png', lines: 1, cut: false, download: 'pixel.png', buttons: true });
}, 60_000);

/** Where the image is in the window, and its proportions. */
const IMAGE = `(() => {
	const content = document.querySelector('${DIALOG} .content');
	const img = content.querySelector('img');
	const box = content.getBoundingClientRect();
	const r = img.getBoundingClientRect();
	return {
		inside: r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5,
		ratio: r.width / r.height,
		natural: img.naturalWidth / img.naturalHeight,
		width: r.width,
		left: r.left,
		top: r.top,
		scrolls: content.scrollHeight > content.clientHeight || content.scrollWidth > content.clientWidth
	};
})()`;
type Shape = { inside: boolean; ratio: number; natural: number; width: number; left: number; top: number; scrolls: boolean };

async function openShot() {
	await openPreview('transcript', SHOT);
	await tab.until(`document.querySelector('${DIALOG} .content img')?.naturalWidth === 1080`, 'the screenshot');
	return tab.eval<Shape>(IMAGE);
}

for (const [device, width, height] of [
	['a phone upright', 390, 800],
	['a tablet on its side', 1180, 820]
] as const) {
	test(`on ${device} an upright screenshot opens whole in the window, its proportions kept`, async () => {
		await visit('transcript', width, { height, touch: true });
		const shape = await openShot();
		expect(shape).toMatchObject({ inside: true, scrolls: false });
		expect(shape.ratio).toBeCloseTo(shape.natural, 2);
	}, 60_000);
}

/** Fingers on the touch screen, each a point; none lifts them all. */
const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: [number, number][]) =>
	tab.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });

test('on a touch screen two fingers enlarge the image and one then moves it', async () => {
	await visit('transcript', 390, { touch: true });
	const before = await openShot();
	const middle = { x: before.left + before.width / 2, y: before.top + 200 };
	// Two fingers spread apart.
	await touch('touchStart', [[middle.x - 20, middle.y], [middle.x + 20, middle.y]]);
	for (let step = 1; step <= 10; step++) await touch('touchMove', [[middle.x - 20 - step * 8, middle.y], [middle.x + 20 + step * 8, middle.y]]);
	await touch('touchEnd', []);
	const zoomed = await tab.eval<Shape>(IMAGE);
	expect(zoomed.width / before.width).toBeGreaterThan(2.5);
	expect(zoomed.ratio).toBeCloseTo(before.natural, 2);
	// One finger moves it to see another part.
	await touch('touchStart', [[middle.x, middle.y]]);
	for (let step = 1; step <= 5; step++) await touch('touchMove', [[middle.x + step * 10, middle.y + step * 10]]);
	await touch('touchEnd', []);
	const moved = await tab.eval<Shape>(IMAGE);
	expect(moved.left - zoomed.left).toBeCloseTo(50, 0);
	expect(moved.top - zoomed.top).toBeCloseTo(50, 0);
	expect(moved.width).toBeCloseTo(zoomed.width, 0);
	// Opened again, the image is whole.
	await tab.eval(`document.querySelector('${DIALOG}').close()`);
	expect(await openShot()).toMatchObject({ inside: true, width: before.width });
}, 60_000);

/** The board's own scrolling part around the conversation. */
const SCROLLER = `(() => { let node = ${entry('transcript', SHOT)}; while (node && !(node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY))) node = node.parentElement; return node ?? document.scrollingElement; })()`;

/** A finger's swipe up at the middle of the part of `selector` in the window, as a phone scrolls. */
async function swipe(selector: string, distance = -300) {
	const { x, y } = await tab.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); const top = Math.max(r.top, 0); const bottom = Math.min(r.bottom, innerHeight); return { x: r.x + r.width / 2, y: (top + bottom) / 2 }; })()`);
	await touch('touchStart', [[x, y]]);
	for (let step = 1; step <= 10; step++) await touch('touchMove', [[x, y + (distance * step) / 10]]);
	await touch('touchEnd', []);
	await Bun.sleep(300);
}

test('on a phone the page behind the window never scrolls, and is where it was when the window closes', async () => {
	await visit('transcript', 390, { touch: true });
	await tab.eval(`${entry('transcript', SHOT)}.scrollIntoView({ block: 'center' })`);
	await tab.until(`[...document.querySelectorAll('${scope('transcript')} .attached img')].every((img) => img.complete && img.naturalWidth > 0)`, 'the thumbnails loaded');
	const position = () => tab.eval<{ board: number; page: number }>(`({ board: ${SCROLLER}.scrollTop, page: document.scrollingElement.scrollTop })`);
	// The same swipe on the board itself does scroll it.
	const before = await position();
	await swipe(TRANSCRIPT, 300);
	// Until the fling has stopped.
	let at = await position();
	for (let last = null as typeof at | null; JSON.stringify(last) !== JSON.stringify(at); ) {
		last = at;
		await Bun.sleep(300);
		at = await position();
	}
	expect(at.board).toBeLessThan(before.board - 100);

	// A swipe on the title, and on an image shown whole.
	await openShot();
	await swipe(`${DIALOG} header`);
	await swipe(`${DIALOG} header`, 300);
	await swipe(`${DIALOG} .content img`);
	await swipe(`${DIALOG} .content img`, 300);
	expect(await position()).toEqual(at);
	await tab.pointerClick(`${DIALOG} header button`);
	await tab.until(`!document.querySelector('${DIALOG}')`, 'the window closed');
	expect(await position()).toEqual(at);

	// A long text scrolls inside the window; past its end, a swipe moves nothing behind it.
	await openPreview('transcript', 'big.log');
	await tab.until(`!!document.querySelector('${DIALOG} pre')`, 'big.log');
	await swipe(`${DIALOG} .content`);
	expect(await tab.eval<number>(`document.querySelector('${DIALOG} .content').scrollTop`)).toBeGreaterThan(100);
	await tab.eval(`(() => { const content = document.querySelector('${DIALOG} .content'); content.scrollTop = content.scrollHeight; })()`);
	await swipe(`${DIALOG} .content`);
	await swipe(`${DIALOG} header`);
	expect(await position()).toEqual(at);
	await tab.eval(`document.querySelector('${DIALOG}').close()`);
	expect(await position()).toEqual(at);
}, 60_000);
