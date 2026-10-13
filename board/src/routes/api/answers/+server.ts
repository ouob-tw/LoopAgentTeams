import { json } from '@sveltejs/kit';
import type { AnswerRequest } from '#lib/board/answers.ts';
import { submitAnswer } from '#lib/server/answer.ts';
import { getBoard } from '#lib/server/board.ts';
import type { RequestHandler } from './$types';

const isText = (value: unknown): value is string => typeof value === 'string';

/** Answer one question of a controller. The answer is written by the panel helper or not at all. */
export const POST: RequestHandler = async ({ request }) => {
	const body: Partial<Record<keyof AnswerRequest, unknown>> | null = await request.json().catch(() => null);
	const { controllerId, questionId, revision, sectionSha256, select, text, note } = body ?? {};
	if (
		!isText(controllerId) ||
		!controllerId ||
		!isText(questionId) ||
		!questionId ||
		!Number.isInteger(revision) ||
		!isText(sectionSha256) ||
		!Array.isArray(select) ||
		!select.every((position) => Number.isInteger(position) && position > 0) ||
		!isText(text) ||
		!isText(note)
	) {
		return json({ error: 'invalid_answer_request' }, { status: 400 });
	}
	const result = await submitAnswer(getBoard(), {
		controllerId,
		questionId,
		revision: revision as number,
		sectionSha256,
		select,
		text,
		note
	});
	return json(result.body, { status: result.status });
};
