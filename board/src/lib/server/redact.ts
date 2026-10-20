// What a log line may not repeat: the user's password, answers and messages from the request, and
// the device token from its cookie. Every text a line takes from a response, an exception or a
// browser report goes through `redact` first. Quoting by position (a reason that repeats only a
// few words of an answer) cannot be recognised; whole values, each of their lines, and the forms
// they take on the way (trimmed, line breaks normalised, JSON-escaped) are.
export const OMITTED = '[omitted]';

/** The request fields that hold the user's own text. */
const CONTENT_FIELDS = ['text', 'note', 'password'] as const;
/** Shorter lines of a multi-line text are too common to take out on their own. */
const MIN_LINE = 4;

function variants(value: string): string[] {
	const normalised = value.replace(/\r\n?/g, '\n');
	const lines = normalised.split('\n').map((line) => line.trim()).filter((line) => line.length >= MIN_LINE);
	return [value, value.trim(), normalised, normalised.trim(), JSON.stringify(value).slice(1, -1), ...lines];
}

/** The texts to take out for one request: its body's user text (any content type) and its token. */
export function secretsOf(body: string | null, token: string | undefined): string[] {
	let parsed: Record<string, unknown> | null = null;
	try {
		parsed = body ? JSON.parse(body) : null;
	} catch {
		// Not JSON: no field to find.
	}
	const values = CONTENT_FIELDS.map((field) => (parsed && typeof parsed === 'object' ? parsed[field] : undefined)).filter(
		(value): value is string => typeof value === 'string'
	);
	if (token) values.push(token);
	const found = new Set(values.flatMap(variants).filter((value) => value.trim()));
	// Longest first, so a value inside a longer one does not leave the rest of it behind.
	return [...found].sort((a, b) => b.length - a.length);
}

export function redact(text: string, secrets: string[]): string {
	// Node quotes an argument it cannot pass to a command after "Received", and JSON.parse quotes
	// the text it could not read, cut short with "..." when long: both may be the user's text or a
	// state file's content. A web address keeps no query or fragment, which may hold anything; a
	// stack frame's line and column stay.
	let result = text
		.replace(/(\. Received ).*$/gm, `$1${OMITTED}`)
		.replace(/"[^\n]*"(?:\.\.\.)? is not valid JSON/g, `"${OMITTED}" is not valid JSON`)
		.replace(/(\bhttps?:\/\/[^\s?#()'"]+)[?#][^\s()'"]*?((?::\d+){1,2})?(?=[)\s'"]|$)/gm, '$1$2');
	for (const secret of secrets) result = result.split(secret).join(OMITTED);
	return result;
}
