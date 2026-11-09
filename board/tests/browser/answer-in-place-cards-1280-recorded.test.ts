// Answering a question card: each of two cards of one message stays put at 1280px, recorded at once.
// Shares its fixture and helpers with the other answer-in-place-*.test.ts files (answer-in-place-case.ts).
import { expect, test } from 'bun:test';
import { CHROME } from '../browser.ts';
import { answer, cardOf, evaluate, expectStayed, HIGH, LOW, open, useAnswerInPlace } from './answer-in-place-case.ts';

useAnswerInPlace();

for (const width of [1280]) {
	for (const [length, older] of [['long', 30], ['short', 0]] as const) {
		for (const records of [true]) {
			for (const anchoring of [true, false]) {
				const name = `${width}px, a ${length} conversation${records ? ', recorded at once' : ''}${anchoring ? '' : ', without scroll anchoring'}`;
				test.skipIf(!CHROME)(`${name}: each of two cards of one message stays put when answered`, async () => {
					const key = await open(`in-place-${width}-${length}-${records}-${anchoring}`, width, { older, records, anchoring });
					for (const [id, place] of [['Q-1', HIGH], ['Q-2', LOW]] as const) {
						const held = await answer(width, key(id), place);
						expectStayed(held, id);
						expect(await evaluate<string>(`${cardOf(key(id))}.innerText`)).toContain('✓');
					}
					expect(await evaluate<number>(`document.querySelectorAll('.history .asking [data-content]').length`)).toBe(2);
				}, 60_000);
			}
		}
	}
}

