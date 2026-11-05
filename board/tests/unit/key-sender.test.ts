// The 按鍵列's sending on one page: order kept, presses during a request sent together next, and after
// a failure nothing sent until the 恢復畫面 for that request, whichever of it and the answer comes first.
import { expect, test } from 'bun:test';
import { KeySender, type KeysAnswer } from '../../src/lib/board/key-sender.ts';
import type { KeyInput, ScreenUpdate } from '../../src/lib/board/screen.ts';

const screen = (recovered: string[] = [], text = 'same'): ScreenUpdate => ({ ok: true, text, recovered });

/** A sender whose requests wait until the test answers them; asking for a 恢復畫面 gets through
 *  unless `link.reachable` is set false. */
function harness({ retryMs }: { retryMs?: number } = {}) {
	const posts: { inputs: KeyInput[]; recovery: string; answer: (value: KeysAnswer) => void }[] = [];
	const failures: (string | null)[] = [];
	const asked: string[] = [];
	const link = { reachable: true };
	let next = 0;
	const sender = new KeySender({
		post: (inputs, recovery) => new Promise((answer) => posts.push({ inputs, recovery, answer })),
		askRecovery: async (recovery) => (asked.push(recovery), link.reachable),
		retryMs,
		failed: (reason) => void failures.push(reason),
		changed: () => {},
		newId: () => `r${++next}`
	});
	return { sender, posts, failures, asked, link };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('presses go in order; those made while a request is under way go together in the next', async () => {
	const { sender, posts } = harness();
	sender.press({ key: 'down' });
	sender.press({ key: 'down' });
	sender.press({ text: '1' });
	expect(posts.map((post) => post.inputs)).toEqual([[{ key: 'down' }]]);
	posts[0].answer({ kind: 'answered', ok: true, reason: null });
	await tick();
	expect(posts.map((post) => post.inputs)).toEqual([[{ key: 'down' }], [{ key: 'down' }, { text: '1' }]]);
});

test('a failure empties the queue and refuses presses until its 恢復畫面, even one with an unchanged screen', async () => {
	const { sender, posts, failures } = harness();
	sender.press({ key: 'up' });
	sender.press({ key: 'enter' });
	posts[0].answer({ kind: 'answered', ok: false, reason: 'Herdr 沒有送出' });
	await tick();
	expect(failures).toEqual(['Herdr 沒有送出']);
	// The queued Enter is dropped, never sent.
	expect(posts).toHaveLength(1);
	expect(sender.waiting).toBe(true);
	expect(sender.press({ key: 'esc' })).toBe(false);
	// A cached or other update does not count; nor does one for another request.
	sender.screen(screen());
	sender.screen(screen(['other']));
	expect(sender.waiting).toBe(true);
	// The 恢復畫面, the screen just as before.
	sender.screen(screen([posts[0].recovery]));
	expect(sender.waiting).toBe(false);
	expect(sender.press({ key: 'esc' })).toBe(true);
	expect(posts.at(-1)!.inputs).toEqual([{ key: 'esc' }]);
});

test('a 恢復畫面 that comes before the failed answer still lets sending go on', async () => {
	const { sender, posts } = harness();
	sender.press({ key: 'enter' });
	// The server pushed the 恢復畫面 before its answer reached the page.
	sender.screen(screen([posts[0].recovery]));
	posts[0].answer({ kind: 'answered', ok: false, reason: '逾時' });
	await tick();
	expect(sender.waiting).toBe(false);
});

test('a request whose answer never comes asks the server for its 恢復畫面 and waits for it', async () => {
	const { sender, posts, asked, failures } = harness();
	sender.press({ key: 'enter' });
	posts[0].answer({ kind: 'network' });
	await tick();
	expect(asked).toEqual([posts[0].recovery]);
	expect(failures).toEqual([null]);
	expect(sender.waiting).toBe(true);
	sender.screen(screen([posts[0].recovery]));
	expect(sender.waiting).toBe(false);
});

test('asking for the 恢復畫面 is tried again until the server takes it, and not after', async () => {
	const { sender, posts, asked, link } = harness({ retryMs: 20 });
	link.reachable = false;
	sender.press({ key: 'esc' });
	posts[0].answer({ kind: 'network' });
	await tick();
	expect(asked).toEqual([posts[0].recovery]);
	await new Promise((resolve) => setTimeout(resolve, 70));
	expect(asked.length).toBeGreaterThan(2);
	expect(sender.waiting).toBe(true);
	// The connection is back: the next try gets through and the asking stops; the wait goes on until
	// the 恢復畫面, and an ordinary screen meanwhile does not end it.
	link.reachable = true;
	await new Promise((resolve) => setTimeout(resolve, 40));
	const taken = asked.length;
	await new Promise((resolve) => setTimeout(resolve, 70));
	expect(asked).toHaveLength(taken);
	sender.screen(screen());
	expect(sender.waiting).toBe(true);
	sender.screen(screen([posts[0].recovery]));
	expect(sender.waiting).toBe(false);
	expect(posts).toHaveLength(1);
});

test('a failure while the recovery request of an earlier one is still under way is asked for too', async () => {
	const posts: { recovery: string; answer: (value: KeysAnswer) => void }[] = [];
	const asks: { recovery: string; answer: (taken: boolean) => void }[] = [];
	let next = 0;
	const sender = new KeySender({
		post: (_inputs, recovery) => new Promise((answer) => posts.push({ recovery, answer })),
		askRecovery: (recovery) => new Promise((answer) => asks.push({ recovery, answer })),
		failed: () => {},
		changed: () => {},
		newId: () => `r${++next}`
	});
	sender.press({ key: 'esc' });
	posts[0].answer({ kind: 'network' });
	await tick();
	expect(asks.map((ask) => ask.recovery)).toEqual(['r1']);
	// Its 恢復畫面 comes while the request for it has not answered yet; the next press fails too.
	sender.screen(screen(['r1']));
	sender.press({ key: 'enter' });
	posts[1].answer({ kind: 'network' });
	await tick();
	asks[0].answer(true);
	await tick();
	expect(asks.map((ask) => ask.recovery)).toEqual(['r1', 'r2']);
});
