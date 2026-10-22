// Markdown as the board shows it: raw HTML in the text is escaped, never run, and links whose
// scheme is not safe are dropped by markdown-it's own check. Single line breaks stay line breaks.
import MarkdownIt from 'markdown-it';
import cjkFriendly from 'markdown-it-cjk-friendly';

// Emphasis next to CJK punctuation or text (`**目前行為：**頁面`) closes as the writer meant.
// Images are off: text from a controller must not make the browser fetch other hosts.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true }).disable('image').use(cjkFriendly);

// Plain text with its web addresses made links and nothing else, for one-line titles: a `*` or
// `_` in a summary stays as it is.
const links = new MarkdownIt('zero', { linkify: true }).enable('linkify');

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

/** One line of plain text as HTML, its web addresses as links. */
export const renderLinks = (text: string) => links.renderInline(text);
