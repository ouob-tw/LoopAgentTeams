// A round's unattended review as the board shows it: what `lat-unattended review show --json`
// prints, kept to what a page needs, and the words of the message 推翻 and 回覆 send. The review
// file's layout and order are lat-unattended's; the review tab groups them (reviewGroups).
import { cardsFrom, shortTime, unseenCount, type DelegatedCard } from './delegated.ts';
import type { UnattendedView } from './unattended.ts';

export type ReviewKind = 'parked' | 'parked-row' | 'proxy-confirmed' | 'assumed' | 'prototype-decided';
export type ReviewItemState = 'open' | 'answered' | 'overturned';

export interface ReviewItem {
	id: string;
	kind: ReviewKind;
	kindLabel: string;
	section: string;
	title: string;
	/** 做了什麼: the one line a folded item shows. */
	did: string;
	why: string;
	evidence: string[];
	/** 怎麼推翻. */
	revert: string;
	state: ReviewItemState;
	stateLabel: string;
}

export interface ReviewGoal {
	version: number;
	goal: string;
	done: string[];
	sourceLabel: string;
	note: string | null;
	startedAt: string;
	endedAt: string | null;
	endLabel: string | null;
	scope: string[];
	maxHours: number;
}

/** A question the controller asked the user during this round's grant (#661, `- grant:`). */
export interface AskedQuestion {
	/** The decision record's ID, which is also the question's ID on the board. */
	id: string;
	title: string;
	state: 'open' | 'answered';
	/** The recorded answer; null while open, or when the record holds none. */
	answer: string | null;
	answeredAt: string | null;
}

export interface Review {
	grant: string;
	goals: ReviewGoal[];
	items: ReviewItem[];
	/** The delegated items in full, in the review's order (the review tab's 代決 rows). */
	delegated: DelegatedCard[];
	/** The questions asked during this round's grant, in the tool's order. */
	asked: AskedQuestion[];
	/** Sources the tool could not read, and a line for review items the board could not show. */
	problems: string[];
}

const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
const text = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const strings = (value: unknown): string[] => list(value).filter((item): item is string => typeof item === 'string');

const KINDS: readonly string[] = ['parked', 'parked-row', 'proxy-confirmed', 'assumed', 'prototype-decided'];
const STATES: readonly string[] = ['open', 'answered', 'overturned'];

/** The payload of `board review`, or null when it is not one. */
export function reviewFrom(payload: unknown): Review | null {
	const given = record(payload);
	const view = record(given.view);
	if (given.status !== 'ok' || typeof given.path !== 'string' || !Array.isArray(view.items)) return null;
	const items: ReviewItem[] = [];
	let unknown = 0;
	for (const raw of view.items) {
		const item = record(raw);
		// Auto actions are no longer review items, and an item the board does not know is left out
		// too, with a line under 讀不出的來源: an old review, or one from a newer tool, still opens
		// with the rest.
		if (item.kind === 'auto') continue;
		if (typeof item.id !== 'string' || !KINDS.includes(text(item.kind)) || !STATES.includes(text(item.state))) {
			unknown++;
			continue;
		}
		items.push({
			id: item.id,
			kind: item.kind as ReviewKind,
			kindLabel: text(item.kind_label),
			section: text(item.section),
			title: text(item.title, item.id),
			did: text(item.did),
			why: text(item.why),
			evidence: strings(item.evidence),
			revert: text(item.revert),
			state: item.state as ReviewItemState,
			stateLabel: text(item.state_label)
		});
	}
	return {
		grant: text(view.grant),
		goals: list(view.goals).map((raw) => {
			const goal = record(raw);
			return {
				version: typeof goal.version === 'number' ? goal.version : 0,
				goal: text(goal.goal),
				done: strings(goal.done),
				sourceLabel: text(goal.source_label),
				note: typeof goal.note === 'string' ? goal.note : null,
				startedAt: text(goal.started_at),
				endedAt: typeof goal.ended_at === 'string' ? goal.ended_at : null,
				endLabel: typeof goal.end_label === 'string' ? goal.end_label : null,
				scope: strings(goal.scope),
				maxHours: typeof goal.max_hours === 'number' ? goal.max_hours : 0
			};
		}),
		items,
		delegated: cardsFrom(view.items),
		asked: list(view.asked).flatMap((raw): AskedQuestion[] => {
			const asked = record(raw);
			if (typeof asked.id !== 'string') return [];
			const answer = typeof asked.answer === 'string' && asked.answer.trim() ? asked.answer : null;
			return [{ id: asked.id, title: text(asked.title) || asked.id, state: asked.state === 'answered' ? 'answered' : 'open', answer, answeredAt: typeof asked.answered_at === 'string' ? asked.answered_at : null }];
		}),
		problems: [...strings(view.problems), ...(unknown ? [`回顧裡有 ${unknown} 項看板認不得，沒有列出`] : [])]
	};
}

/** The review tab's groups, in order (#664); a group with nothing in it is left out by the page.
 *  `fresh`: the IDs of the delegated cards the controller page still lists as not seen (a grant
 *  ending takes them off it). */
export function reviewGroups(review: Pick<Review, 'items' | 'delegated' | 'asked'>, fresh: ReadonlySet<string>) {
	const unseen = review.delegated.filter((card) => card.state === 'open' && fresh.has(card.id));
	return {
		unseen,
		settled: review.delegated.filter((card) => !unseen.includes(card)),
		asked: review.asked,
		/** Parked items, written before #661 parked became a question: answered with 回覆. */
		parked: review.items.filter(isParked)
	};
}

/** What a question asked during the grant says under its title. `waiting`: its card is still in
 *  the inbox, null when it is not; `sent` when the user's answer went out but is not recorded yet.
 *  An ended controller's question can no longer be answered on the board. */
export function askedLabel(asked: Pick<AskedQuestion, 'state' | 'answer'>, inactive: boolean, waiting: { sent: boolean } | null): string {
	if (asked.state === 'answered') return asked.answer ? `你答：${asked.answer}` : '已回答';
	if (waiting?.sent) return '已送出答覆，等主控記下';
	return inactive ? '沒答到，主控已結束' : '等你回答';
}

/** A parked item is answered with 回覆; every other kind is overturned with 推翻. */
export const isParked = (item: Pick<ReviewItem, 'kind'>): boolean => item.kind === 'parked' || item.kind === 'parked-row';
export const actionWord = (item: Pick<ReviewItem, 'kind'>): '回覆' | '推翻' => (isParked(item) ? '回覆' : '推翻');

/** What the controller is sent: the item's ID and title, then the user's words. */
export function reviewMessage(item: Pick<ReviewItem, 'id' | 'title' | 'kind'>, words: string): string {
	return `回顧項目 ${item.id}「${item.title}」${actionWord(item)}：${words.trim()}`;
}

/** What the user wrote to overturn a card: the recorded answer without the start of the message
 *  reviewMessage builds, or without the bare 「推翻：」 a controller may record before the words.
 *  An answer recorded in other words is shown as it is. */
export function overturnWords(card: Pick<DelegatedCard, 'id' | 'title' | 'kind' | 'answer'>): string {
	const answer = (card.answer ?? '').trim();
	const start = reviewMessage(card, '');
	if (answer.startsWith(start)) return answer.slice(start.length).trim();
	return answer.replace(/^推翻[：:]/, '').trim();
}

/** A card that is no longer new, as the review tab says it: left alone it counts as agreed. */
export function settledLabel(card: Pick<DelegatedCard, 'id' | 'title' | 'kind' | 'state' | 'answer' | 'answeredAt'>): string {
	if (card.state !== 'overturned') return '沒推翻，算同意';
	const when = card.answeredAt ? `（${shortTime(card.answeredAt)}）` : '';
	const words = overturnWords(card);
	return `已由你推翻${when}${words ? `：${words}` : ''}`;
}

/** The record an evidence entry opens with, one of the two kinds lat-unattended cites
 *  (`.lat/decisions/<id>.md`, `.lat/ledgers/<name>.json`), with or without `row 3` / `第 3 行`
 *  after it, and what follows the path. Null for any other entry: a record's own text can start
 *  with a path, and only these folders are ever shown. */
export function evidenceFile(entry: string): { path: string; rest: string } | null {
	const found = /^(\.lat\/(?:decisions\/[\w-][\w.-]*\.md|ledgers\/[\w-][\w.-]*\.json))(?=\s|$)(.*)$/s.exec(entry);
	return found ? { path: found[1], rest: found[2] } : null;
}

/** Every file the review's evidence names: the only ones the board will show for it. */
export function evidencePaths(review: Pick<Review, 'items'>): Set<string> {
	const paths = new Set<string>();
	for (const item of review.items) for (const entry of item.evidence) {
		const file = evidenceFile(entry);
		if (file) paths.add(file.path);
	}
	return paths;
}

export const CODE_REPO = 'https://github.com/ouob-tw/LoopAgentTeams';
export const ISSUE_REPO = 'https://github.com/ouob-tw/LoopAgentTeams-work';

export type EvidencePiece = { kind: 'text'; text: string } | { kind: 'issue' | 'commit'; text: string; href: string };

/** Text split where it names an issue (`#570`) or a commit (7 to 40 hex digits, one a digit). */
export function evidencePieces(text: string): EvidencePiece[] {
	const pieces: EvidencePiece[] = [];
	let last = 0;
	for (const found of text.matchAll(/(?<![\w#/])#(\d+)(?!\w)|(?<![\w-])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)([0-9a-f]{7,40})(?![\w-])/g)) {
		if (found.index > last) pieces.push({ kind: 'text', text: text.slice(last, found.index) });
		pieces.push(found[1] ? { kind: 'issue', text: found[0], href: `${ISSUE_REPO}/issues/${found[1]}` } : { kind: 'commit', text: found[0], href: `${CODE_REPO}/commit/${found[2]}` });
		last = found.index + found[0].length;
	}
	if (last < text.length) pieces.push({ kind: 'text', text: text.slice(last) });
	return pieces;
}

/** The 回顧 tab's number (#664): what still needs the user: 代決 not opened yet, questions asked
 *  during the grant and not answered (only while the controller can still take an answer), and
 *  open parked items from before #661. Null without a review. */
export function reviewTabCount(controller: { unattended: UnattendedView }, inactive: boolean): number | null {
	const review = 'review' in controller.unattended ? controller.unattended.review : undefined;
	if (review?.state !== 'ok') return null;
	return unseenCount(controller) + (inactive ? 0 : review.askedOpen) + review.parked;
}
