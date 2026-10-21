// Reading an earlier page of the conversation from the information page: leaving the page or
// opening another controller cancels the read, request and all, and leaves nothing to show.
import { expect, test } from 'bun:test';
import { EarlierReads } from '../../src/lib/board/earlier.ts';

const page = { ok: true, page: { items: [], before: null, skipped: 0 } };
const answer = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));

test('a read still waiting when the page goes away is cancelled at the request', async () => {
	let signal: AbortSignal | undefined;
	const reads = new EarlierReads((_url, init) => {
		signal = init.signal;
		// Like a server still reading: answers only by failing once the request is aborted.
		return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
	});

	const pending = reads.read('s-1', 50);
	reads.cancel();

	expect(signal?.aborted).toBe(true);
	expect(await pending).toEqual({ kind: 'cancelled' });
});

test('a cancelled read whose answer still arrives shows nothing', async () => {
	let release = () => {};
	const reads = new EarlierReads(() => new Promise((resolve) => (release = () => resolve(new Response(JSON.stringify(page))))));

	const pending = reads.read('s-1', 50);
	reads.cancel();
	release();

	expect(await pending).toEqual({ kind: 'cancelled' });
});

test('a read that finishes gives the page, a logged-out device or a missing answer', async () => {
	const urls: string[] = [];
	const ok = new EarlierReads((url) => (urls.push(url), answer(200, page)));
	expect(await ok.read('s 1', 50)).toEqual({ kind: 'page', update: page as never });
	expect(urls).toEqual(['/api/transcript?controller=s%201&before=50']);

	expect(await new EarlierReads(() => answer(401, {}), () => {}).read('s-1', 50)).toEqual({ kind: 'unpaired' });
	expect(await new EarlierReads(() => Promise.reject(new TypeError('network'))).read('s-1', 50)).toEqual({ kind: 'failed' });
});

test('cancelling with nothing under way does nothing', () => {
	expect(() => new EarlierReads(() => answer(200, page)).cancel()).not.toThrow();
});
