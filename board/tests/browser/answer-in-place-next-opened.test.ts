// Answering a question card: the next card chosen while the first is on its way, and the opened question's card, stay put.
// Shares its fixture and helpers with the other answer-in-place-*.test.ts files (answer-in-place-case.ts).
import { expect, test } from 'bun:test';
import { CHROME } from '../browser.ts';
import { sleep } from '../harness.ts';
import { answer, browser, cardOf, click, evaluate, expectStayed, HIGH, open, scrollTo, send, sendAnswer, settled, useAnswerInPlace, watch } from './answer-in-place-case.ts';

useAnswerInPlace();

for (const width of [1280, 390]) {
	for (const anchoring of [true, false]) {
		test.skipIf(!CHROME)(`${width}px, a long conversation, recorded at once${anchoring ? '' : ', without scroll anchoring'}: the next card, chosen while the first is still on its way, stays put`, async () => {
			await open(`next-${width}-${anchoring}`, width, { older: 30, records: true, height: 1000, anchoring });
			// The card on top is answered first and the one below it is the next: whichever of
			// Q-1 and Q-2 the page shows on top.
			const [first, next] = await evaluate<[string, string]>(`[...document.querySelectorAll('.history .asking [data-content]')].map((card) => card.dataset.content)`);
			// The first card's top just above the screen, so what the page keeps in place by itself
			// may be in it; its second option and both send buttons on screen.
			await scrollTo(width, first, () => -30);
			// The first card's answer is held on its way until the next card is chosen, then a
			// moment to think before sending that one.
			const tab = browser!.tab;
			tab.paused = [];
			await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/answers*' }] });
			try {
				await sendAnswer(first, 1);
				await tab.until(`!!document.querySelector('.history [data-content="${first}"] button.primary:disabled')`);
				while (!tab.paused.length) await sleep(20);
				await watch(next, true);
				await click(`${cardOf(next)}.querySelector('input[type=radio]')`);
			} finally {
				await send('Fetch.disable');
				for (const requestId of tab.paused) await send('Fetch.continueRequest', { requestId }).catch(() => {});
			}
			await tab.until(`!${cardOf(first)}?.querySelector('form.answer')`);
			await sleep(1500);
			await sendAnswer(next);
			const held = await settled(next);
			expectStayed(held);
			for (const card of [first, next]) expect(await evaluate<string>(`${cardOf(card)}.innerText`)).toContain('✓');
		}, 60_000);
	}

	test.skipIf(!CHROME)(`${width}px, a short conversation, recorded at once: the opened question's card stays put when answered, after being scrolled to`, async () => {
		const key = await open(`opened-${width}`, width, { records: true, opened: 'Q-2' });
		// Scrolled to on opening, below the guide to newer messages.
		expect(await evaluate<boolean>(`!!document.querySelector('.history .placed [data-content="${key('Q-2')}"]')`)).toBe(true);
		const top = await evaluate<number>(`${cardOf(key('Q-2'))}.getBoundingClientRect().top`);
		expect(top).toBeGreaterThanOrEqual(0);
		expect(top).toBeLessThan(160);
		const held = await answer(width, key('Q-2'), HIGH);
		expectStayed(held);
	}, 60_000);
}

