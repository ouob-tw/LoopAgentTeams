// What the inbox holds now, for `board inbox`: the page's own rules applied to the real data, but
// with nothing written. The running board does the settling, pruning and archiving; here an archive
// that is due only counts in memory.
import { askNote, askRows, askTitle, ASK_KIND_TEXT } from '../board/ask-inbox.ts';
import { BOARD_ASK_STATE_TEXT, type BoardAskState } from '../board/board-asks.ts';
import { EMPTY_CLOSED } from '../board/closed-agents.ts';
import { sortEntries } from '../board/inbox.ts';
import { itemLabel } from '../board/types.ts';
import { readAsks } from './board-asks.ts';
import type { BoardConfig } from './config.ts';
import { listAgents } from './hcom.ts';
import { listControllers, readAnswered } from './helper.ts';
import { loadInboxState, type InboxState } from './inbox-state.ts';
import { answeredSources, archiveDue, buildSnapshot, type Sources } from './model.ts';
import { linkedAgain, readPauses } from './paused.ts';
import { createReportReader } from './reports.ts';

export interface InboxStatus {
	/** One line for each entry the inbox lists, in the page's order. */
	open: string[];
	/** The 已處理 count the page shows. */
	processedCount: number;
	/** How many ended asks are in each state; the rest of the processed items have no state. */
	endedAsks: Map<BoardAskState, number>;
	/** What could not be read: the rest may be incomplete. */
	problems: string[];
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 80);

export async function readInboxStatus(config: BoardConfig): Promise<InboxStatus> {
	const [helper, reports, listed] = await Promise.all([listControllers(config), createReportReader(config.reportsDir)(), listAgents(config)]);
	const active = helper.ok ? helper.controllers : [];
	const answered = await readAnswered(config, answeredSources(active, reports.files));
	const now = config.now();
	const problems: string[] = [];
	let state: InboxState | null = null;
	try {
		state = loadInboxState(config.stateDir);
	} catch (error) {
		problems.push(`已讀與封存紀錄讀不出來：${(error as Error).message}`);
	}
	const sources: Sources = {
		active,
		helperError: helper.ok ? null : helper.reason,
		reportFiles: reports.files,
		duties: reports.duties,
		reportsError: reports.error,
		running: listed.ok ? new Set(listed.agents.flatMap((agent) => (agent.sessionId ? [agent.sessionId] : []))) : null,
		paused: new Set([...readPauses(config.pausedDir).keys()].filter((id) => !(listed.ok && linkedAgain(listed.agents, id)))),
		hcomError: listed.ok ? null : listed.reason,
		agents: [],
		herdrError: null,
		workspaces: [],
		closed: EMPTY_CLOSED,
		pruneError: null,
		answered: answered.ok ? answered.files : [],
		answeredError: answered.ok ? null : answered.reason,
		ledgers: new Map(),
		ledgersError: null
	};
	if (state) archiveDue(sources, state, now);
	const snapshot = buildSnapshot(sources, state, now);
	problems.push(...snapshot.errors);

	const rows = askRows(readAsks(config.asksDir, { now, executionWaitMs: config.askExecutionWaitMs }), []);
	const ended = rows.filter((row) => !row.open);
	const endedAsks = new Map<BoardAskState, number>();
	for (const { ask } of ended) endedAsks.set(ask.state, (endedAsks.get(ask.state) ?? 0) + 1);
	const items = snapshot.inbox.filter((item) => item.kind === 'question' || item.readAt === null);
	const open = sortEntries(items, rows.filter((row) => row.open)).map((entry) =>
		entry.kind === 'item'
			? [itemLabel(entry.item), entry.item.project, oneLine(entry.item.title)].join('\t')
			: [ASK_KIND_TEXT[entry.row.ask.kind], entry.row.project, oneLine(askTitle(entry.row)), askNote(entry.row, now)].join('\t')
	);
	return { open, processedCount: snapshot.processedCount + ended.length, endedAsks, problems };
}

/** The status as the command prints it. */
export function formatInboxStatus({ open, processedCount, endedAsks, problems }: InboxStatus): string {
	const states = [...endedAsks].map(([state, count]) => `${BOARD_ASK_STATE_TEXT[state]} ${count}`);
	return [
		`待辦 ${open.length}`,
		...open.map((line) => `  ${line}`),
		`已處理 ${processedCount}`,
		...states.map((line) => `  提問：${line}`),
		...problems.map((problem) => `讀不到：${problem}`)
	].join('\n');
}
