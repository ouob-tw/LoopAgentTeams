// The two inbox orders. The page applies them; the choice is remembered per device.
import type { AskRow } from './ask-inbox.ts';
import type { InboxItem } from './types.ts';

export type InboxSort = 'time' | 'project';

export interface ControllerGroup {
	controllerId: string;
	hcomName: string;
	items: InboxItem[];
}

export interface ProjectGroup {
	/** Projects are told apart by path: two folders with the same name are two projects. */
	workspace: string;
	project: string;
	controllers: ControllerGroup[];
}

/** Questions waiting for an answer that has not been sent go first. */
const pinned = (item: InboxItem) => item.kind === 'question' && item.unsent;

/** An item without a usable time sorts as older than every dated one. */
function stamp(item: InboxItem): number {
	const time = item.time === null ? NaN : Date.parse(item.time);
	return Number.isNaN(time) ? -Infinity : time;
}

const newestFirst = (a: number, b: number) => Number(b > a) - Number(b < a);

/** Unsent questions on top, newest first; then everything else, newest first. Undated items keep
 *  their source order after the dated ones. */
export function sortByTime(items: InboxItem[]): InboxItem[] {
	return items.toSorted((a, b) => Number(pinned(b)) - Number(pinned(a)) || newestFirst(stamp(a), stamp(b)));
}

/** Project → controller → items. Groups with an unsent question come first, then groups by their
 *  newest item; inside a controller the order is `sortByTime`. Unsent questions are never pulled
 *  out of their own controller's group. */
export function groupByProject(items: InboxItem[]): ProjectGroup[] {
	const projects = new Map<string, ProjectGroup>();
	for (const item of sortByTime(items)) {
		let project = projects.get(item.workspace);
		if (!project) projects.set(item.workspace, (project = { workspace: item.workspace, project: item.project, controllers: [] }));
		let controller = project.controllers.find((group) => group.controllerId === item.controllerId);
		if (!controller) project.controllers.push((controller = { controllerId: item.controllerId, hcomName: item.hcomName, items: [] }));
		controller.items.push(item);
	}

	const order = <T>(groups: T[], itemsOf: (group: T) => InboxItem[]) =>
		groups.toSorted((a, b) => {
			const [itemsA, itemsB] = [itemsOf(a), itemsOf(b)];
			return (
				Number(itemsB.some(pinned)) - Number(itemsA.some(pinned)) ||
				newestFirst(Math.max(...itemsA.map(stamp)), Math.max(...itemsB.map(stamp)))
			);
		});

	return order(
		[...projects.values()].map((project) => ({ ...project, controllers: order(project.controllers, (group) => group.items) })),
		(project) => project.controllers.flatMap((group) => group.items)
	);
}

/** An inbox entry: an item, or a board ask. */
export type InboxEntry = { kind: 'item'; item: InboxItem } | { kind: 'ask'; row: AskRow };

const entryKey = (entry: InboxEntry) => (entry.kind === 'item' ? entry.item.key : entry.row.key);
const entryStamp = (entry: InboxEntry) => (entry.kind === 'item' ? stamp(entry.item) : stamp({ time: entry.row.time } as InboxItem));
/** Unsent questions, and asks the user can still answer, go first. */
const entryPinned = (entry: InboxEntry) => (entry.kind === 'item' ? pinned(entry.item) : entry.row.open);

/** The entries of a list in the time order: pinned ones on top, newest first, source order for ties. */
export function sortEntries(items: InboxItem[], rows: AskRow[]): InboxEntry[] {
	const entries: InboxEntry[] = [...items.map((item): InboxEntry => ({ kind: 'item', item })), ...rows.map((row): InboxEntry => ({ kind: 'ask', row }))];
	return entries.toSorted((a, b) => Number(entryPinned(b)) - Number(entryPinned(a)) || newestFirst(entryStamp(a), entryStamp(b)));
}

export interface AgentGroup {
	agentId: string;
	name: string;
	rows: AskRow[];
}

export interface ProjectEntries {
	workspace: string;
	project: string;
	controllers: ControllerGroup[];
	/** The asking agents in the project, each with its asks. */
	agents: AgentGroup[];
}

/** Like `groupByProject`, with the board asks grouped by their agent's project beside the
 *  controllers. A project and a group of it come first while one of its entries is pinned. */
export function groupEntriesByProject(items: InboxItem[], rows: AskRow[]): ProjectEntries[] {
	const projects = new Map<string, ProjectEntries>();
	const projectOf = (workspace: string, project: string) => {
		let found = projects.get(workspace);
		if (!found) projects.set(workspace, (found = { workspace, project, controllers: [], agents: [] }));
		return found;
	};
	for (const group of groupByProject(items)) projectOf(group.workspace, group.project).controllers = group.controllers;
	for (const entry of sortEntries([], rows)) {
		if (entry.kind !== 'ask') continue;
		const { row } = entry;
		const project = projectOf(row.workspace, row.project);
		let agent = project.agents.find((group) => group.agentId === row.ask.sessionId);
		if (!agent) project.agents.push((agent = { agentId: row.ask.sessionId, name: row.name, rows: [] }));
		agent.rows.push(row);
	}
	const entriesOf = (project: ProjectEntries): InboxEntry[] => [
		...project.controllers.flatMap((group) => group.items.map((item): InboxEntry => ({ kind: 'item', item }))),
		...project.agents.flatMap((group) => group.rows.map((row): InboxEntry => ({ kind: 'ask', row })))
	];
	const rank = (entries: InboxEntry[]) => [Number(entries.some(entryPinned)), Math.max(...entries.map(entryStamp))] as const;
	const first = (a: readonly [number, number], b: readonly [number, number]) => b[0] - a[0] || newestFirst(a[1], b[1]);
	const agentEntries = (group: AgentGroup): InboxEntry[] => group.rows.map((row): InboxEntry => ({ kind: 'ask', row }));
	return [...projects.values()]
		.map((project) => ({ ...project, agents: project.agents.toSorted((a, b) => first(rank(agentEntries(a)), rank(agentEntries(b)))) }))
		.toSorted((a, b) => first(rank(entriesOf(a)), rank(entriesOf(b))));
}

export { entryKey };
