// Board asks in the inbox (待辦): each ask that has not ended is one entry; once it ended it is
// among the processed items (已處理) with its result. Pure, shared by the page and its tests.
import { BOARD_ASK_STATE_TEXT, ENDED_ASK_STATES, type BoardAsk } from './board-asks.ts';
import { processedTime } from './archive.ts';
import type { Agent, InboxItem } from './types.ts';

/** A board ask as the inbox lists it, with the agent it belongs to. */
export interface AskRow {
	/** `ask:` and the ask's ID: unique among everything the inbox lists. */
	key: string;
	ask: BoardAsk;
	/** The asking agent's name; its session ID's start when Herdr no longer lists it. */
	name: string;
	/** The folder its agent works in; the project is told from it. Empty when not known. */
	workspace: string;
	/** The folder's last part; 「（未知）」 when the folder is not known. */
	project: string;
	/** When it was asked: places it among the items in the time order. */
	time: string;
	/** Whether it still wants the user: not ended. */
	open: boolean;
}

export const NO_PROJECT = '（未知）';
export const ASK_KIND_TEXT = { question: '提問', permission: '權限確認' } as const;

const lastPart = (folder: string) => folder.replace(/\/+$/, '').split('/').pop() || folder;

/** The inbox rows for the asks, in the order given. */
export function askRows(asks: readonly BoardAsk[], agents: readonly Pick<Agent, 'id' | 'name' | 'folder'>[]): AskRow[] {
	return asks.map((ask) => {
		const agent = agents.find((candidate) => candidate.id === ask.sessionId);
		const workspace = agent?.folder || ask.folder || '';
		return {
			key: `ask:${ask.id}`,
			ask,
			name: agent?.name ?? ask.sessionId.slice(0, 8),
			workspace,
			project: workspace ? lastPart(workspace) : NO_PROJECT,
			time: ask.createdAt,
			open: !ENDED_ASK_STATES.has(ask.state)
		};
	});
}

/** What a row's title says: what was asked, the first question or the tool. */
export function askTitle(row: AskRow): string {
	const { ask } = row;
	return ask.kind === 'permission' ? (ask.tool ?? '（未知工具）') : (ask.questions[0]?.question ?? '（沒有題目）');
}

/** The time left until the hook stops waiting, as `m:ss`; null once it ran out. */
export function askLeft(ask: Pick<BoardAsk, 'deadlineAt'>, now: number): string | null {
	const seconds = Math.ceil((Date.parse(ask.deadlineAt) - now) / 1000);
	return seconds > 0 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : null;
}

/** The note beside a row: while it waits in place the time left, then what its state says. */
export function askNote(row: AskRow, now: number): string {
	const { ask } = row;
	if (ask.state === 'waiting') {
		const left = askLeft(ask, now);
		return left ? `剩 ${left}` : BOARD_ASK_STATE_TEXT.waiting;
	}
	return BOARD_ASK_STATE_TEXT[ask.state];
}

/** When an ended row was handled; its place among the processed items. */
export const askEndedTime = (row: AskRow): number => Date.parse(row.ask.endedAt ?? row.time);

/** The processed items loaded and the ended asks, newest handled first. While more items are to
 *  be loaded, an ask older than the oldest one loaded is left out: it comes with its page. */
export function mergeProcessed(items: readonly InboxItem[], rows: readonly AskRow[], more: boolean): ({ item: InboxItem } | { row: AskRow })[] {
	const loaded = items.map((item) => ({ item, at: processedTime(item) }));
	const oldest = more ? (loaded.at(-1)?.at ?? -Infinity) : -Infinity;
	const asks = rows.filter((row) => askEndedTime(row) >= oldest).map((row) => ({ row, at: askEndedTime(row) }));
	return [...loaded, ...asks].toSorted((a, b) => b.at - a.at).map(({ at: _at, ...entry }) => entry);
}
