// Which chat message asked a panel question, from the cases shared with the Herdr side panel.
import { expect, test } from 'bun:test';
import fixture from './fixtures/question-message-match.json';
import { askingReport } from '../src/lib/board/question-message.ts';

for (const entry of fixture.cases) {
	test(entry.name, () => {
		const found = askingReport(entry.session_id, entry.question, entry.reports);
		expect(found).toBe(entry.expected === null ? null : entry.reports[entry.expected]);
	});
}
