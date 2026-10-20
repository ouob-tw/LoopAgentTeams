import { dayNumber } from './closed-agents.ts';

/** Where a Herdr workspace and tab sit, by name and by their place in its lists; one no longer in
 *  Herdr is null. `position` counts from 1 among the workspace's tabs. */
export type HerdrPlace = {
	workspace: { label: string; number: number } | null;
	tab: { label: string; position: number } | null;
};

/** A place as the information pages write it, e.g. `LAT（工作區#1）・lat-lagu（分頁#3）`. */
export const placeText = (place: HerdrPlace) =>
	`${place.workspace ? `${place.workspace.label}（工作區#${place.workspace.number}）` : '工作區已不在 Herdr'}・${place.tab ? `${place.tab.label}（分頁#${place.tab.position}）` : '分頁已不在 Herdr'}`;

export const formatTime = (iso: string | null) =>
	iso === null
		? '時間不明'
		: new Date(iso).toLocaleString('zh-TW', {
				month: 'numeric',
				day: 'numeric',
				hour: '2-digit',
				minute: '2-digit',
				second: '2-digit',
				hour12: false
			});

/** A notification's or last report's time: the time of day when it is today in the board's time
 *  zone, with the date from yesterday on; seconds kept as `formatTime` does. */
export function noticeTime(iso: string | null, now: number, timeZone: string): string {
	if (iso === null) return '時間不明';
	const time = Date.parse(iso);
	const clock = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false } as const;
	const today = dayNumber(time, timeZone) === dayNumber(now, timeZone);
	return new Date(time).toLocaleString('zh-TW', { timeZone, ...(today ? {} : { month: 'numeric', day: 'numeric' }), ...clock });
}
