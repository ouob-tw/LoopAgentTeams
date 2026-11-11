// A report summary as the board shows it: plain text, except that Markdown inline links to a web
// address, `[text](https://…)`, become links. Anything else, including a link to another scheme,
// stays the text it was written as.

export type SummaryPart = { text: string; href?: string };

const LINK = /\[([^[\]]+)\]\(([^\s()]+)\)/g;

function webAddress(url: string): string | null {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
	} catch {
		return null;
	}
}

export function summaryParts(text: string): SummaryPart[] {
	const parts: SummaryPart[] = [];
	let from = 0;
	let plain = '';
	for (const match of text.matchAll(LINK)) {
		const href = webAddress(match[2]);
		if (href === null) continue;
		plain += text.slice(from, match.index);
		if (plain) parts.push({ text: plain });
		plain = '';
		parts.push({ text: match[1], href });
		from = match.index + match[0].length;
	}
	plain += text.slice(from);
	if (plain) parts.push({ text: plain });
	return parts;
}

// The same text without the link markup, for a place where a link cannot be clicked.
export function summaryPlain(text: string): string {
	return summaryParts(text)
		.map((part) => part.text)
		.join('');
}
