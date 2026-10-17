// Markdown as the board shows it: raw HTML in the text is escaped, never run, and links whose
// scheme is not safe are dropped by markdown-it's own check. Single line breaks stay line breaks.
import MarkdownIt from 'markdown-it';

// Images are off: text from a controller must not make the browser fetch other hosts.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true }).disable('image');

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

/** One line of plain text as HTML, its web addresses as links. */
export const renderLinks = (text: string) => links.renderInline(text);
