// Markdown as the board shows it: raw HTML in the text is escaped, never run, and links whose
// scheme is not safe are dropped by markdown-it's own check. Single line breaks stay line breaks.
import MarkdownIt from 'markdown-it';
import cjkFriendly from 'markdown-it-cjk-friendly';
import { summaryParts } from './summary-links.ts';

// Emphasis next to CJK punctuation or text (`**目前行為：**頁面`) closes as the writer meant.
// Images are off: text from a controller must not make the browser fetch other hosts.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true }).disable('image').use(cjkFriendly);

// Plain text with its web addresses made links and nothing else, for one-line titles: a `*` or
// `_` in a summary stays as it is.
const links = new MarkdownIt('zero', { linkify: true }).enable('linkify');

// A table column is as wide as its longest cell needs to fit in about three lines, never under five
// characters: each cell carries that as `--col`, which the page's CSS turns into a minimum width, and a
// table wider than its box scrolls sideways. Widths are in em: a wide (CJK) character is 1, others 0.55.
const MIN_COLUMN = 5; // em; the same minimum as `--col`'s fallback in app.css
const LINES = 3;
// Room for the padding and for lines that end early where a punctuation mark may not start a line.
const SLACK = 2;
const textWidth = (text: string) => {
	let width = 0;
	for (const char of text) width += /[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(char) ? 1 : 0.55;
	return width;
};
md.core.ruler.push('table_column_width', (state) => {
	const tokens = state.tokens;
	for (let start = 0; start < tokens.length; start++) {
		if (tokens[start].type !== 'table_open') continue;
		const cells: { open: (typeof tokens)[number]; column: number }[] = [];
		const widest: number[] = [];
		let column = 0;
		let index = start + 1;
		for (; tokens[index].type !== 'table_close'; index++) {
			const token = tokens[index];
			if (token.type === 'tr_open') column = 0;
			else if (token.type === 'th_open' || token.type === 'td_open') {
				const text = (tokens[index + 1].children ?? []).map((child) => (child.type === 'text' || child.type === 'code_inline' ? child.content : '')).join('');
				cells.push({ open: token, column });
				widest[column] = Math.max(widest[column] ?? 0, textWidth(text));
				column++;
			}
		}
		for (const { open, column } of cells) open.attrSet('style', `--col:${Math.max(MIN_COLUMN, Math.ceil((widest[column] / LINES + SLACK) * 10) / 10)}em`);
		start = index;
	}
});

// Links open in a new tab, so following one does not leave the board.
for (const instance of [md, links]) {
	const renderLink =
		instance.renderer.rules.link_open ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
	instance.renderer.rules.link_open = (tokens, index, options, env, self) => {
		tokens[index].attrSet('target', '_blank');
		tokens[index].attrSet('rel', 'noopener noreferrer');
		return renderLink(tokens, index, options, env, self);
	};
}

export const renderMarkdown = (text: string) => md.render(text);

/** Each text's HTML by its key, rendered once: a conversation's push renders only the texts that
 *  are new or changed, not every one loaded before. */
export class RenderedMarkdown {
	readonly #known = new Map<number, { text: string; html: string }>();
	readonly #render: (text: string) => string;

	constructor(render = renderMarkdown) {
		this.#render = render;
	}

	html(key: number, text: string): string {
		const known = this.#known.get(key);
		if (known?.text === text) return known.html;
		const html = this.#render(text);
		this.#known.set(key, { text, html });
		return html;
	}

	/** Forget every text: another conversation's keys mean other texts. */
	clear(): void {
		this.#known.clear();
	}
}

/** The lines of each code block as it would be shown, fenced or indented, inside lists and quotes
 *  too: `[first, end)`, counted from 0, in order. */
export function codeBlockLines(text: string): [number, number][] {
	return md
		.parse(text, {})
		.filter((token) => (token.type === 'fence' || token.type === 'code_block') && token.map)
		.map((token) => token.map as [number, number]);
}

// Titles come back unchanged on every push, so each is rendered once.
const titles = new Map<string, string>();
const TITLES_KEPT = 500;

/** A title where it can hold links: its Markdown links to web addresses as links with their text,
 *  its bare web addresses as links, everything else as text. */
export function renderTitle(text: string): string {
	const known = titles.get(text);
	if (known !== undefined) return known;
	const html = summaryParts(text)
		.map((part) =>
			part.href
				? `<a href="${md.utils.escapeHtml(part.href)}" target="_blank" rel="noopener noreferrer">${md.utils.escapeHtml(part.text)}</a>`
				: links.renderInline(part.text)
		)
		.join('');
	if (titles.size >= TITLES_KEPT) titles.clear();
	titles.set(text, html);
	return html;
}
