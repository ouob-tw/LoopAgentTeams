// Whether an agent's process has hcom's hooks, told by the process itself. hcom loads the hooks of
// Claude and Codex only into a client it starts, and it gives what it starts HCOM_PROCESS_ID. A
// client started any other way (Herdr restoring its panes with a plain `claude --resume`) never has
// them, and hcom's list cannot tell: it has no entry for one never registered, and an `hcom start`
// lists it like any other.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { BoardConfig } from './config.ts';
import type { AgentList } from './hcom.ts';
import { paneProcess, type HerdrAgent, type PaneProcess } from './herdr.ts';
import { isConnected } from './paused.ts';

export type ProcessHooks = 'hcom' | 'none' | 'unknown';

/** The clients whose hooks only an hcom launch loads, of those the board can restart. */
export const relinkable = (client: string) => client === 'claude' || client === 'codex';

/** Sessions being restarted (`relink.ts`): off Herdr's list for a moment, and not closed. */
export const relinking = new Set<string>();

/** Whether this process runs with hcom's environment; null when that cannot be read. */
function hasHcomEnv(pid: number): boolean | null {
	try {
		return /(?:^|\0)HCOM_PROCESS_ID=[^\0]/.test(readFileSync(`/proc/${pid}/environ`, 'latin1'));
	} catch {
		return null;
	}
}

/** Whether this foreground process is the client, its program being run directly or by Node. */
export const isClient = (argv: string[], client: string) => argv.slice(0, 2).some((arg) => basename(arg) === client);

/** `hcom` once any foreground process has hcom's environment (`hcom pty` holds it for a client on
 *  a terminal of its own); `none` only when the client itself is seen without it. */
export function judgeHooks(process: PaneProcess, client: string): ProcessHooks {
	const told = process.foreground.map((running) => ({ running, env: hasHcomEnv(running.pid) }));
	if (told.some(({ env }) => env === true)) return 'hcom';
	return told.some(({ running, env }) => env === false && isClient(running.argv, client)) ? 'none' : 'unknown';
}

export function createHookWatch() {
	let hookless = new Set<string>();
	return {
		/** The panes whose client has no hooks, from these lists. One hcom holds the process of and
		 *  has on its link is not asked about; one that cannot be told stays as it was. */
		async update(config: BoardConfig, herdr: { ok: true; agents: HerdrAgent[] } | { ok: false }, hcom: AgentList): Promise<Set<string>> {
			if (!herdr.ok) return hookless;
			const next = new Set<string>();
			await Promise.all(
				herdr.agents.map(async (agent) => {
					if (!relinkable(agent.client)) return;
					const entry = hcom.ok ? (hcom.agents.find((candidate) => candidate.sessionId === agent.sessionId && agent.sessionId) ?? hcom.agents.find((candidate) => candidate.pane === agent.pane)) : undefined;
					if (entry?.processBound && isConnected(entry)) return;
					const process = await paneProcess(config, agent.pane);
					const hooks = 'reason' in process ? 'unknown' : judgeHooks(process, agent.client);
					if (hooks === 'none' || (hooks === 'unknown' && hookless.has(agent.pane))) next.add(agent.pane);
				})
			);
			hookless = next;
			return next;
		}
	};
}
