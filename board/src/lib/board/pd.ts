// The pd 待核准 section's data: the requests pd's daemon holds for the user's approval, as the
// server last read them from `pd pending --json`, and how the section words them. Only these fields
// ever reach a page; pd itself never lists a secret value. The board cannot approve: 核准 opens the
// request's own page on pd's passkey site, and only denying goes through the board.

export interface PdRequest {
	id: number;
	/** Who asked, as the requester declared it: not verified. */
	caller: string;
	item: string;
	fields: string[];
	/** The command the request would run, word by word, with any value pd recognised masked. */
	command: string[];
	cwd: string;
	/** Seconds the request had waited when it was read. */
	waiting: number;
	/** Seconds it had left before timing out when it was read; null from a pd that does not say. */
	remaining: number | null;
	/** The request's page on the passkey site; null when pd gave none that is a web address. */
	approvalUrl: string | null;
}

export type PdSnapshot = { ok: true; requests: PdRequest[] } | { ok: false; reason: string };

const clockText = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/** A request's time as it reads `elapsed` milliseconds after it was read: what is left while pd says,
 *  else how long it has waited. `low` once 30 seconds or less are left. */
export function timeText(request: PdRequest, elapsed: number): { text: string; low: boolean } {
	const passed = Math.max(0, Math.floor(elapsed / 1000));
	if (request.remaining === null) return { text: `已等待 ${clockText(request.waiting + passed)}`, low: false };
	const left = Math.max(0, request.remaining - passed);
	return { text: left ? `剩 ${clockText(left)}` : '即將逾時', low: left <= 30 };
}
