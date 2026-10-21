// Translating a conversation's English replies into Chinese: which texts count as English, and
// what the page and the board server send each other for it.

/** Most texts one request may ask for, and the longest one. */
export const MAX_TEXTS = 50;
export const MAX_LENGTH = 20_000;

/** One line of the answer, sent as soon as that text is ready: by its place in the request. */
export type TranslatedLine = { index: number; text: string } | { index: number; error: string };

/** What says nothing about the language: code, links and paths. */
const NOT_PROSE = [/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, /`[^`\n]+`/g, /\bhttps?:\/\/\S+/g, /\S*\/\S*/g];
const WORD = /[A-Za-z]{2,}/g;
/** Han, kana and the Chinese punctuation. */
const CJK = /[　-〿぀-ヿ㐀-鿿豈-﫿＀-￯]/g;

/** At least this many English words outside code, links and paths. */
const MIN_WORDS = 3;
/** And at most this many Chinese characters per English word. */
const MAX_CJK_PER_WORD = 0.5;

/** Whether a text is mostly English and worth translating: a Chinese text that names a few
 *  English terms is not. */
export function isEnglish(text: string): boolean {
	let prose = text;
	for (const pattern of NOT_PROSE) prose = prose.replace(pattern, ' ');
	const words = prose.match(WORD)?.length ?? 0;
	const cjk = prose.match(CJK)?.length ?? 0;
	return words >= MIN_WORDS && cjk <= words * MAX_CJK_PER_WORD;
}

/** Where one English text stands: on its way, translated, or failed and shown as it was. */
export type Translation = { status: 'pending' } | { status: 'done'; text: string } | { status: 'failed'; reason: string };

type Request = (url: string, init: RequestInit) => Promise<Response>;

/**
 * The page's translation requests. Texts asked for in one go are sent together, newest first as
 * given, `MAX_TEXTS` to a request; each comes back on its own as soon as the server has it.
 * A text is asked for once: again only after it failed and `retry` was called.
 */
export class Translations {
	readonly #known = new Map<string, Translation>();
	readonly #aborts = new Set<AbortController>();
	#queued: string[] = [];
	readonly #changed: (text: string, translation: Translation | undefined) => void;
	readonly #request: Request;
	readonly #unpaired: () => void;

	constructor(
		changed: (text: string, translation: Translation | undefined) => void,
		{ request = (url, init) => fetch(url, init), unpaired = () => location.reload() }: { request?: Request; unpaired?: () => void } = {}
	) {
		this.#changed = changed;
		this.#request = request;
		this.#unpaired = unpaired;
	}

	#set(text: string, translation: Translation | undefined): void {
		if (translation) this.#known.set(text, translation);
		else this.#known.delete(text);
		this.#changed(text, translation);
	}

	/** Ask for the texts not asked for yet; they go out together once the current task is done. */
	want(texts: string[]): void {
		const fresh = [...new Set(texts)].filter((text) => !this.#known.has(text));
		if (!fresh.length) return;
		for (const text of fresh) this.#set(text, { status: 'pending' });
		if (!this.#queued.length) queueMicrotask(() => this.#flush());
		this.#queued.push(...fresh);
	}

	/** Forget the failed ones, so the next `want` asks again. */
	retry(): void {
		for (const [text, translation] of this.#known) if (translation.status === 'failed') this.#set(text, undefined);
	}

	/** End every request on its way and forget what they were for and what failed; the
	 *  translations already in stay. */
	stop(): void {
		for (const abort of this.#aborts) abort.abort();
		this.#aborts.clear();
		this.#queued = [];
		for (const [text, translation] of this.#known) if (translation.status !== 'done') this.#set(text, undefined);
	}

	#flush(): void {
		const texts = this.#queued;
		this.#queued = [];
		for (let start = 0; start < texts.length; start += MAX_TEXTS) void this.#send(texts.slice(start, start + MAX_TEXTS));
	}

	async #send(texts: string[]): Promise<void> {
		const abort = new AbortController();
		this.#aborts.add(abort);
		const answered = new Set<number>();
		let reason = '沒有收到看板伺服器的回應';
		try {
			const response = await this.#request('/api/translate', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ texts }),
				signal: abort.signal
			});
			if (abort.signal.aborted) return;
			if (response.status === 401) return this.#unpaired();
			if (!response.ok || !response.body) {
				const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
				reason = typeof body?.error === 'string' ? body.error : `看板伺服器回應 ${response.status}`;
				return;
			}
			let rest = '';
			const take = (line: string) => {
				if (!line.trim() || abort.signal.aborted) return;
				const answer: TranslatedLine = JSON.parse(line);
				answered.add(answer.index);
				this.#set(texts[answer.index], 'text' in answer ? { status: 'done', text: answer.text } : { status: 'failed', reason: answer.error });
			};
			const decoder = new TextDecoder();
			// Read by hand: Safari cannot loop over a stream.
			const reader = response.body.getReader();
			for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
				const lines = (rest + decoder.decode(chunk.value, { stream: true })).split('\n');
				rest = lines.pop()!;
				lines.forEach(take);
			}
			take(rest);
			reason = '看板伺服器沒有回完';
		} catch {
			// Stopped, or the connection broke: the reason above.
		} finally {
			this.#aborts.delete(abort);
			// Stopped: `stop` has already forgotten them.
			if (!abort.signal.aborted) texts.forEach((text, index) => answered.has(index) || this.#set(text, { status: 'failed', reason }));
		}
	}
}
