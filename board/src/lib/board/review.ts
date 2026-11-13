// A round's unattended review as the board shows it: what `lat-unattended review show --json`
// prints, kept to what a page needs, and the words of the message 推翻 and 回覆 send. The review
// file's layout and order are lat-unattended's; nothing here reorders or rewrites them.

export type ReviewKind = 'parked' | 'parked-row' | 'proxy-confirmed' | 'assumed' | 'prototype-decided' | 'auto';
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

export interface ReviewVerification {
	checker: string;
	family: string;
	at: string;
	total: number;
	matched: number;
	mismatches: { id: string; text: string }[];
}

export interface Review {
	grant: string;
	verified: boolean;
	verification: ReviewVerification | null;
	goals: ReviewGoal[];
	items: ReviewItem[];
	/** IDs of the items 最該先看的幾項 lists, in order. */
	top: string[];
	doneTickets: string[];
	/** Sources the tool could not read. */
	problems: string[];
	/** The sections after 目標 and 最該先看, in the review file's order, with their headings. */
	sections: { key: string; heading: string }[];
}

const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
const text = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const strings = (value: unknown): string[] => list(value).filter((item): item is string => typeof item === 'string');

const KINDS: readonly string[] = ['parked', 'parked-row', 'proxy-confirmed', 'assumed', 'prototype-decided', 'auto'];
const STATES: readonly string[] = ['open', 'answered', 'overturned'];

/** The payload of `board review`, or null when it is not one. */
export function reviewFrom(payload: unknown): Review | null {
	const given = record(payload);
	const view = record(given.view);
	if (given.status !== 'ok' || typeof given.path !== 'string' || !Array.isArray(view.items)) return null;
	const items: ReviewItem[] = [];
	for (const raw of view.items) {
		const item = record(raw);
		if (typeof item.id !== 'string' || !KINDS.includes(text(item.kind)) || !STATES.includes(text(item.state))) return null;
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
	const verification = given.verified ? record(given.verification) : null;
	return {
		grant: text(view.grant),
		verified: given.verified === true && verification !== null && typeof verification.total === 'number',
		verification:
			verification && typeof verification.total === 'number'
				? {
						checker: text(verification.checker),
						family: text(verification.family),
						at: text(verification.at),
						total: verification.total,
						matched: typeof verification.matched === 'number' ? verification.matched : 0,
						mismatches: list(verification.mismatches).map((entry) => ({ id: text(record(entry).id), text: text(record(entry).text) }))
					}
				: null,
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
		top: strings(view.top),
		doneTickets: strings(view.done_tickets),
		problems: strings(view.problems),
		sections: list(view.sections)
			.map((raw) => ({ key: text(record(raw).key), heading: text(record(raw).heading) }))
			.filter((section) => section.key && section.heading)
	};
}

/** A parked item is answered with 回覆; every other kind is overturned with 推翻. */
export const isParked = (item: Pick<ReviewItem, 'kind'>): boolean => item.kind === 'parked' || item.kind === 'parked-row';
export const actionWord = (item: Pick<ReviewItem, 'kind'>): '回覆' | '推翻' => (isParked(item) ? '回覆' : '推翻');

/** What the controller is sent: the item's ID and title, then the user's words. */
export function reviewMessage(item: Pick<ReviewItem, 'id' | 'title' | 'kind'>, words: string): string {
	return `回顧項目 ${item.id}「${item.title}」${actionWord(item)}：${words.trim()}`;
}

/** Where the review's verification line stands, in one phrase for the banner. */
export function verificationText(review: Pick<Review, 'verified' | 'verification'>): string {
	const check = review.verification;
	if (!review.verified || !check) return '尚未核對';
	const who = check.family === 'gpt' ? 'Codex' : check.family === 'claude' ? 'Claude' : check.checker;
	if (!check.mismatches.length && check.matched === check.total) return `${who} 已核對紀錄：${check.total} 項全相符`;
	return `${who} 已核對紀錄：${check.total} 項中 ${check.matched} 項相符，${check.mismatches.length} 項不符`;
}

/** The folder-relative file an evidence entry opens with (`.lat/decisions/LAT-P1.md`, with or
 *  without `row 3` / `第 3 行` after it), and what follows the path. Null for any other entry. */
export function evidenceFile(entry: string): { path: string; rest: string } | null {
	const found = /^((?:\.?[\w-][\w.-]*\/)*\.?[\w-][\w.-]*\.(?:md|jsonl|json|txt))(?=\s|$)(.*)$/s.exec(entry);
	if (!found || found[1].split('/').some((part) => part === '.' || part === '..')) return null;
	return { path: found[1], rest: found[2] };
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
	for (const found of text.matchAll(/(?<![\w#/])#(\d+)(?!\w)|(?<![\w-])(?=[0-9a-f]*\d)([0-9a-f]{7,40})(?![\w-])/g)) {
		if (found.index > last) pieces.push({ kind: 'text', text: text.slice(last, found.index) });
		pieces.push(found[1] ? { kind: 'issue', text: found[0], href: `${ISSUE_REPO}/issues/${found[1]}` } : { kind: 'commit', text: found[0], href: `${CODE_REPO}/commit/${found[2]}` });
		last = found.index + found[0].length;
	}
	if (last < text.length) pieces.push({ kind: 'text', text: text.slice(last) });
	return pieces;
}
