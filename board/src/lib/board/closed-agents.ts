// The 已關閉 section at the foot of the Herdr tab: agents the board saw in Herdr that the user, Herdr
// or the client itself closed within the last 7 days, with a saved conversation to bring back. The
// shapes the server and the page share, and how the page groups them by the host's calendar days.

/** How long a closed agent stays listed, from when it stopped: 7×24 hours. */
export const CLOSED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** Where a 接回 of a closed agent stands: under way, or failed and why. Gone once it is back. */
export type ClosedResume = { state: 'resuming'; time: string } | { state: 'failed'; reason: string; time: string };

/** One closed agent, as the board last saw it in Herdr and hcom recorded its stop. */
export interface ClosedAgent {
	/** Its session ID: the conversation 接回 brings back. */
	id: string;
	hcomName: string;
	/** Its Herdr tab's name when the board last saw it; null when it had none. */
	tab: string | null;
	client: string;
	folder: string;
	/** The Herdr workspace it was in. */
	workspace: string;
	workspaceLabel: string | null;
	stoppedAt: string;
	/** On the controller roster: 接回 wakes it like a controller. */
	controller: boolean;
	resume: ClosedResume | null;
}

export interface ClosedList {
	/** Newest stop first. */
	agents: ClosedAgent[];
	/** Why the list may be out of date or short; null when it is not. */
	error: string | null;
	/** The host's time zone: its calendar days make 今天 and 昨天. */
	timeZone: string;
}

/** Why nothing is sent to a closed agent from the command line while its page is open. */
export const CLOSED_SEND_TEXT = '已關閉，先接回才能傳訊息。';

export const EMPTY_CLOSED: ClosedList = { agents: [], error: null, timeZone: 'UTC' };

export const CLOSED_GROUPS = ['今天', '昨天', '近 7 天'] as const;
export type ClosedGroup = (typeof CLOSED_GROUPS)[number];

/** The calendar day of a moment in a time zone, as a count of days. */
function dayNumber(time: number, timeZone: string): number {
	const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(time);
	const part = (type: string) => Number(parts.find((candidate) => candidate.type === type)!.value);
	return Date.UTC(part('year'), part('month') - 1, part('day')) / 86_400_000;
}

/** The closed agents by when they stopped, by the host's calendar days: today, yesterday, and the
 *  rest still kept. Newest first within each; empty groups are left out. */
export function closedGroups(agents: ClosedAgent[], now: number, timeZone: string): { label: ClosedGroup; agents: ClosedAgent[] }[] {
	const today = dayNumber(now, timeZone);
	const groups = new Map<ClosedGroup, ClosedAgent[]>(CLOSED_GROUPS.map((label) => [label, []]));
	const sorted = [...agents].sort((a, b) => Date.parse(b.stoppedAt) - Date.parse(a.stoppedAt));
	for (const agent of sorted) {
		const age = today - dayNumber(Date.parse(agent.stoppedAt), timeZone);
		groups.get(age <= 0 ? '今天' : age === 1 ? '昨天' : '近 7 天')!.push(agent);
	}
	return CLOSED_GROUPS.filter((label) => groups.get(label)!.length).map((label) => ({ label, agents: groups.get(label)! }));
}

/** When it stopped, as a row shows it: the time of day, with the date unless it was today. */
export function stoppedText(stoppedAt: string, now: number, timeZone: string): string {
	const time = Date.parse(stoppedAt);
	const clock = new Intl.DateTimeFormat('zh-TW', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(time);
	if (dayNumber(time, timeZone) === dayNumber(now, timeZone)) return clock;
	const date = new Intl.DateTimeFormat('zh-TW', { timeZone, month: 'numeric', day: 'numeric' }).format(time);
	return `${date} ${clock}`;
}

/** What `POST /api/agents/closed/resume` answers: whether 接回 started, or why not. */
export interface ClosedResumeResponse {
	ok: boolean;
	/** Why not; or, when it started, what hcom said about a resume not known to be ready. */
	reason: string | null;
	/** Set when the attempt could not be written to the sent log. */
	logError: string | null;
	/** A controller's open resume attempt the user may give up, when it is what stopped this one. */
	abandon: string | null;
}
