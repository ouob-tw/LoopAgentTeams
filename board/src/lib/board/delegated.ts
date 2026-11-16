// A round's delegated decisions as the controller page shows them (#663): the advisors decided in
// the user's place under the unattended grant, so nothing waits on the user; each card can only
// be overturned. The helper lists the cards (lat-unattended's review, less those a grant ending
// took away); the board adds whether the user has opened each one, kept on the host so every
// device agrees.
import type { UnattendedView } from './unattended.ts';

export type DelegatedKind = 'proxy-confirmed' | 'assumed' | 'prototype-decided';

export interface AdvisorOpinion {
	/** The advisor with its client and model, as the record names it. */
	who: string;
	agree: boolean;
	text: string;
}

export interface DelegatedCard {
	/** The decision record's ID. */
	id: string;
	kind: DelegatedKind;
	title: string;
	/** What would have been asked. */
	question: string | null;
	/** What the advisors chose, the record's `- decision:`. */
	decision: string | null;
	opinions: AdvisorOpinion[];
	/** An assumption's `- revert:`: what the user can change it to. */
	revertTo: string | null;
	/** A confirmed ticket's 驗收對照, one condition and the user's words per line. */
	checks: string[];
	/** A prototype decision's `- sample:`. */
	sample: string | null;
	/** `overturned` once the controller recorded the user's 推翻. */
	state: 'open' | 'overturned';
	stateLabel: string;
	/** The user opened it on some device. */
	seen: boolean;
	/** The 推翻 the controller recorded, as the record has it, and when; null while open. Only
	 *  the review's items carry them, not the controller page's cards. */
	answer?: string | null;
	answeredAt?: string | null;
}

/** What the strip's row says before the title. */
export const KIND_WORD: Record<DelegatedKind, string> = {
	assumed: '已代決',
	'proxy-confirmed': '已代確認',
	'prototype-decided': '樣品決定'
};

const KINDS: readonly string[] = Object.keys(KIND_WORD);
const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
const textOrNull = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);

/** The helper's cards (`board.py delegated_cards`), not yet seen; an entry that is not one is left out. */
export function cardsFrom(value: unknown): DelegatedCard[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((raw): DelegatedCard[] => {
		const given = record(raw);
		if (typeof given.id !== 'string' || !KINDS.includes(given.kind as string)) return [];
		return [
			{
				id: given.id,
				kind: given.kind as DelegatedKind,
				title: textOrNull(given.title) ?? given.id,
				question: textOrNull(given.question),
				decision: textOrNull(given.decision),
				opinions: (Array.isArray(given.opinions) ? given.opinions : []).flatMap((entry) => {
					const opinion = record(entry);
					return typeof opinion.who === 'string' && typeof opinion.text === 'string' ? [{ who: opinion.who, agree: opinion.stance === 'agree', text: opinion.text }] : [];
				}),
				revertTo: textOrNull(given.revert_to),
				checks: (Array.isArray(given.checks) ? given.checks : []).filter((line): line is string => typeof line === 'string' && line.trim() !== ''),
				sample: textOrNull(given.sample),
				state: given.state === 'overturned' ? 'overturned' : 'open',
				stateLabel: typeof given.state_label === 'string' ? given.state_label : '',
				seen: false,
				answer: textOrNull(given.answer),
				answeredAt: textOrNull(given.answered_at)
			}
		];
	});
}

/** The key the host keeps a card's seen state under: decision IDs are a workspace's, so the
 *  controller's session ID goes with it. */
export const seenKey = (controllerId: string, cardId: string) => `${controllerId}:${cardId}`;

/** Every card of the controller's round, seen or not. */
export function delegatedOf(controller: { unattended: UnattendedView }): DelegatedCard[] {
	const review = 'review' in controller.unattended ? controller.unattended.review : undefined;
	return review?.state === 'ok' ? review.delegated : [];
}

/** How many of its cards the user has not opened yet: the roster's 代決 N. */
export const unseenCount = (controller: { unattended: UnattendedView }): number => delegatedOf(controller).filter((card) => !card.seen).length;

/** The 回顧 tab's number (#664): what still needs the user: 代決 not opened yet, questions asked
 *  during the grant and not answered (only while the controller can still take an answer), and
 *  open parked items from before #661. Null without a review. */
export function reviewTabCount(controller: { unattended: UnattendedView }, inactive: boolean): number | null {
	const review = 'review' in controller.unattended ? controller.unattended.review : undefined;
	if (review?.state !== 'ok') return null;
	return unseenCount(controller) + (inactive ? 0 : review.askedOpen) + review.parked;
}

/** The cards with the host's seen state; the same object when nothing changes. */
export function withSeen<T extends { id: string; unattended: UnattendedView }>(controller: T, seen: Record<string, string>): T {
	const view = controller.unattended;
	const review = 'review' in view ? view.review : undefined;
	if (review?.state !== 'ok' || !review.delegated.length) return controller;
	const delegated = review.delegated.map((card) => ({ ...card, seen: seenKey(controller.id, card.id) in seen }));
	return { ...controller, unattended: { ...view, review: { ...review, delegated } } };
}

/** One line of a card's detail: a label with one text or a list of lines. */
export type DetailRow = { label: string; text?: string; lines?: string[] };

/** The detail's lines, each only when the record has it: never an empty field. The helper sets
 *  a kind's own field only for that kind. */
export function detailRows(card: DelegatedCard): DetailRow[] {
	const rows: DetailRow[] = [];
	if (card.question) rows.push({ label: '原本要問', text: card.question });
	if (card.decision) rows.push({ label: '參謀決定', text: card.decision });
	if (card.opinions.length) rows.push({ label: '兩位參謀', lines: card.opinions.map((opinion) => `${opinion.who}：${opinion.agree ? '同意' : '不同意'}；${opinion.text}`) });
	if (card.revertTo) rows.push({ label: '可以改成', text: card.revertTo });
	if (card.checks.length) rows.push({ label: '驗收對照', lines: card.checks });
	if (card.sample) rows.push({ label: '樣品', text: card.sample });
	return rows;
}

/** A time the records give (ISO, any offset) as the user reads it: month/day and hour:minute in
 *  Taiwan; the text as given when it is not a time. */
export function shortTime(iso: string): string {
	const time = Date.parse(iso);
	if (Number.isNaN(time)) return iso;
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
			.formatToParts(time)
			.map((part) => [part.type, part.value])
	);
	return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}
