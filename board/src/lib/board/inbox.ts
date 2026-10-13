// The two inbox orders. The page applies them; the choice is remembered per device.
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
