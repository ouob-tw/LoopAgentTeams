// How the roster lays out the controllers it is given: the ones still on the board in runs of one
// status each, in the server's order, then the ended ones that reported within a day, newest
// first; the other ended ones are kept apart, by how long ago they last reported.
import { DAY_MS } from './archive.ts';
import type { Controller } from './types.ts';

/** When a controller last reported, earliest of all when it never has. */
export const reportedAt = (controller: Controller) => (controller.lastReportAt ? Date.parse(controller.lastReportAt) : -Infinity);

/** Runs of one status in the order given, the ended ones that reported within a day last and
 *  newest first; and the older ended ones, which the roster keeps out of its list. */
export function splitRoster(controllers: readonly Controller[], now: number): { groups: Controller[][]; older: Controller[] } {
	const groups: Controller[][] = [];
	const recent: Controller[] = [];
	const older: Controller[] = [];
	for (const controller of controllers) {
		if (controller.status === 'ended') {
			(now - reportedAt(controller) <= DAY_MS ? recent : older).push(controller);
			continue;
		}
		const last = groups.at(-1);
		if (last?.[0].status === controller.status) last.push(controller);
		else groups.push([controller]);
	}
	if (recent.length) groups.push(recent.sort((a, b) => reportedAt(b) - reportedAt(a)));
	return { groups, older };
}

const AGES = [
	{ label: '3 天內', days: 3 },
	{ label: '1 週內', days: 7 }
] as const;
const OLDEST = '更早';

/** Ended controllers older than a day by the age of their latest report, newest first: within
 *  three days, a week, or earlier, where one without a report goes. Empty ranges are left out. */
export function endedByAge(ended: readonly Controller[], now: number): { label: string; controllers: Controller[] }[] {
	const buckets = [...AGES.map(({ label }) => ({ label, controllers: [] as Controller[] })), { label: OLDEST, controllers: [] as Controller[] }];
	for (const controller of [...ended].sort((a, b) => reportedAt(b) - reportedAt(a))) {
		const age = now - reportedAt(controller);
		const at = AGES.findIndex(({ days }) => age <= days * DAY_MS);
		buckets[at === -1 ? AGES.length : at].controllers.push(controller);
	}
	return buckets.filter((bucket) => bucket.controllers.length);
}
