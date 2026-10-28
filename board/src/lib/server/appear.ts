// Whether a client hcom started (or resumed) really runs: hcom's list has it, and Herdr lists an
// agent with its session, or in the pane hcom has for it. hcom's own answer is not enough: it can
// report a client ready, and list it for a while, that has already exited in its tab (a resume of
// a session with no saved conversation does).
import type { BoardConfig } from './config.ts';
import { listAgents, type HcomAgent } from './hcom.ts';
import { listHerdrAgents, type HerdrAgent } from './herdr.ts';

/** How often the lists are read while waiting. */
const POLL_MS = 1_000;
/** How many of hcom's lists in a row may lack the client before it counts as gone. */
const GONE_AFTER = 3;
/** How many reads in a row Herdr may show no agent in the pane hcom has for the client before it
 *  counts as exited: Herdr spots a client within a second of its start. */
const EXITED_AFTER = 8;
/** How many reads in a row Herdr's lists may fail before the wait gives up on them. */
const UNREAD_AFTER = 5;

/** Which client: the one hcom lists under this name, or with this session ID; with both, the one
 *  with the session ID, else the one under the name (a fresh launch that resumes a session is
 *  listed under a name of its own until hcom learns its session). */
export type Wanted = { name: string; sessionId?: string } | { sessionId: string };

/** The Herdr agent that is this client, when both lists are read and agree. */
export function runningIn(wanted: Wanted, hcom: HcomAgent[], herdr: HerdrAgent[]): { hcom: HcomAgent | undefined; herdr: HerdrAgent | undefined } {
	const listed =
		(wanted.sessionId !== undefined ? hcom.find((agent) => agent.sessionId === wanted.sessionId) : undefined) ??
		('name' in wanted ? hcom.find((agent) => agent.name === wanted.name) : undefined);
	// Its session first: a pane hcom still has from an earlier client may hold another agent now.
	const seen =
		listed &&
		(herdr.find((agent) => listed.sessionId !== null && agent.sessionId === listed.sessionId) ??
			herdr.find((agent) => listed.pane !== null && agent.pane === listed.pane));
	return { hcom: listed, herdr: seen };
}

export type Appearance = { found: HerdrAgent } | { found: null; reason: string };

/** What a wait does on the way: `onPane` gets each pane hcom lists for the client before it runs,
 *  until it answers true for that pane; an agent `accepts` turns down is not the client, and the
 *  wait goes on. */
export interface Watch {
	onPane(pane: string): Promise<boolean>;
	accepts?(found: HerdrAgent): boolean;
}

/** Wait until the client runs in Herdr, or until `deadline` (board clock); gives up early when
 *  hcom stops listing it, when it is listed but nothing runs in its pane for a while, or when
 *  Herdr's lists cannot be read for a while. `who` names it in the reasons; `watch` follows it. */
export async function waitToAppear(
	config: BoardConfig,
	wanted: Wanted,
	deadline: number,
	who: string,
	watch?: Watch
): Promise<Appearance> {
	let missing = 0;
	let idle = 0;
	let herdrUnread = 0;
	let unread: string | null = null;
	let paneDone: string | null = null;
	for (;;) {
		const [hcom, herdr] = await Promise.all([listAgents(config), listHerdrAgents(config)]);
		unread = !hcom.ok ? hcom.reason : !herdr.ok ? herdr.reason : null;
		herdrUnread = herdr.ok ? 0 : herdrUnread + 1;
		if (!herdr.ok && herdrUnread >= UNREAD_AFTER) {
			return { found: null, reason: `連續 ${UNREAD_AFTER} 次讀不到 Herdr 的清單，不再等 ${who}（${herdr.reason}）` };
		}
		if (hcom.ok && herdr.ok) {
			const running = runningIn(wanted, hcom.agents, herdr.agents);
			const turnedDown = running.herdr && watch?.accepts && !watch.accepts(running.herdr);
			if (running.herdr && !turnedDown) return { found: running.herdr };
			const pane = running.hcom?.pane;
			if (watch && pane && pane !== paneDone && (await watch.onPane(pane))) paneDone = pane;
			missing = running.hcom ? 0 : missing + 1;
			// An agent turned down runs in that pane: the client has not exited.
			idle = pane && !turnedDown ? idle + 1 : 0;
			if (missing >= GONE_AFTER) return { found: null, reason: `hcom 的清單上沒有 ${who}` };
			if (idle >= EXITED_AFTER) return { found: null, reason: `${who} 沒有在它的 Herdr 分頁裡執行，可能一啟動就結束了` };
		}
		if (config.now() >= deadline) {
			return { found: null, reason: `等了 ${Math.round(config.launchWaitMs / 1000)} 秒，Herdr 的清單上還沒有 ${who}${unread ? `（${unread}）` : ''}` };
		}
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}
}
