// Answering a question card: a key that is not for choosing ends keeping the card; a lone card at the top of a conversation stays put.
// Shares its fixture and helpers with the other answer-in-place-*.test.ts files (answer-in-place-case.ts).
import { expect, test } from 'bun:test';
import { CHROME } from '../browser.ts';
import { sleep } from '../harness.ts';
import { browser, cardOf, evaluate, expectStayed, HIGH, open, scrollerAt, scrollTo, send, sendAnswer, settled, useAnswerInPlace, watch } from './answer-in-place-case.ts';

useAnswerInPlace();

for (const width of [1280, 390]) {
	test.skipIf(!CHROME)(`${width}px: a key that is not for choosing or typing ends keeping the card, so the page scrolls with it`, async () => {
		const key = await open(`keys-${width}`, width, { older: 30 });
		await scrollTo(width, key('Q-1'), HIGH);
		const tab = browser!.tab;
		const scroller = scrollerAt(width);
		tab.paused = [];
		await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/answers*' }] });
		try {
			await sendAnswer(key('Q-1'));
			while (!tab.paused.length) await sleep(20);
			// While the answer is on its way, a key on the card itself (not an option or text box)
			// and the page scrolled as that key would.
			await evaluate(`${cardOf(key('Q-1'))}.querySelector('header').dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }))`);
			const before = await evaluate<number>(`${scroller}.scrollTop`);
			await evaluate(`${scroller}.scrollTop += 300`);
			await sleep(500);
			expect(Math.round((await evaluate<number>(`${scroller}.scrollTop`)) - before)).toBe(300);
		} finally {
			await send('Fetch.disable');
			for (const requestId of tab.paused) await send('Fetch.continueRequest', { requestId }).catch(() => {});
		}
	}, 60_000);
}


for (const width of [1280, 390]) {
	for (const [length, older] of [['short', 0], ['long', 30]] as const) {
		for (const anchoring of [true, false]) {
			const name = `${width}px, a ${length} conversation at its top${anchoring ? '' : ', without scroll anchoring'}`;
			test.skipIf(!CHROME)(`${name}: a lone card stays put though the bar above goes with its answer`, async () => {
				const key = await open(`top-${width}-${length}-${anchoring}`, width, { older, records: true, height: 1200, anchoring, alone: true });
				const scroller = scrollerAt(width);
				await evaluate(`${scroller}.scrollTop = 0`);
				expect(await evaluate<number>(`document.querySelectorAll('.questions .question').length`)).toBe(1);
				await watch(key('Q-1'));
				await sendAnswer(key('Q-1'));
				const held = await settled(key('Q-1'));
				// The bar went with the recorded answer.
				expect(await evaluate<number>(`document.querySelectorAll('.questions .question').length`)).toBe(0);
				expectStayed(held);
				if (length === 'short') return;
				// Scrolled down past the room made for it, as a person does: the room goes, and nothing
				// on screen moves for it.
				const head = `document.querySelector('.history .head')`;
				const past = await evaluate<number>(`${head}.getBoundingClientRect().bottom + 100`);
				expect(past).toBeGreaterThan(100);
				const top = await evaluate<number>(`${cardOf(key('Q-1'))}.getBoundingClientRect().top`);
				await evaluate(`window.dispatchEvent(new WheelEvent('wheel')); ${scroller}.scrollBy(0, ${past})`);
				await sleep(300);
				expect(await evaluate<number>(`${head}?.offsetHeight ?? 0`)).toBe(0);
				expect(Math.abs((await evaluate<number>(`${cardOf(key('Q-1'))}.getBoundingClientRect().top`)) - (top - past))).toBeLessThan(2);
			}, 60_000);
		}
	}
}

