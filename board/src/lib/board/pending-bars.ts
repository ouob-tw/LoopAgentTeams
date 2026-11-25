// Which of a controller's questions get a 待決 bar under its card, and why one is back. A question
// is shown while it waits for an answer; once an answer is sent it goes, and comes back only when
// something went wrong with that answer.
import type { AnswerOutcome, Submitted } from './answering.svelte.ts';
import { STATUS_LABEL, isInactive, type Controller, type InboxQuestion } from './types.ts';

export interface PendingBar {
	item: InboxQuestion;
	/** What went wrong with the answer sent for it; null for a question simply waiting. */
	problem: string | null;
}

/** Why an answer sent from this page did not go in, for the outcomes that leave the question open. */
const REFUSED: Partial<Record<AnswerOutcome['status'], string>> = {
	question_changed: '答覆被退回：題目已改版，請重新作答',
	invalid_answer: '答覆被退回：格式不符，請重新作答',
	ended: '沒有送出：主控已停用或關閉'
};

export function pendingBars(
	status: Controller['status'],
	questions: InboxQuestion[],
	page: { submitted: Record<string, Submitted>; outcomes: Record<string, AnswerOutcome> }
): PendingBar[] {
	return questions.flatMap((item): PendingBar[] => {
		const sent = page.submitted[item.key];
		if (item.unsent) {
			// Sent from this page and the board has not caught up yet; a new version asked again is open.
			if (sent && sent.revision === item.question.revision) return [];
			const refused = REFUSED[page.outcomes[item.key]?.status ?? 'submitted'];
			return [{ item, problem: refused ?? null }];
		}
		if (item.notifyFailed || sent?.notifyFailed) return [{ item, problem: '已送出，但通知主控失敗' }];
		if (isInactive(status)) return [{ item, problem: `已送出，但主控${STATUS_LABEL[status]}，還沒記錄` }];
		return [];
	});
}
