import { error } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import type { RequestHandler } from './$types';

/** The output a run kept: its end, when it was long. */
export const GET: RequestHandler = ({ params }) => {
	const output = getBoard().automation.output(params.id, params.run);
	if (output === null) error(404, '這次沒有留下輸出');
	return new Response(output, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
};
