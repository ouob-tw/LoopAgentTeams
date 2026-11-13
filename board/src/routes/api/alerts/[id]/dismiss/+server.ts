import { error, json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import type { RequestHandler } from './$types';

/** 知道了，關掉紅卡: only the card is closed; the run records stay as they are. */
export const POST: RequestHandler = ({ params }) => {
	const alert = getBoard().alerts.dismiss(params.id);
	if (!alert) error(404, '這張紅卡已不存在');
	return json(alert);
};
