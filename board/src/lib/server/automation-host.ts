// What an agent task's run does through the board (`automation-agent.ts`): it opens its agent by
// the new-agent launch flow, reads hcom's list, the conversation and the Herdr screen, closes the
// agent by the board's close flow, and reads which provider a Codex run's own session goes through
// (CPA or not, #710), through the helper. It never touches a Codex account.
import { readFile } from 'node:fs/promises';
import { closeAgent, sendToAgent } from './agent-control.ts';
import type { AgentHost, Cut } from './automation-agent.ts';
import type { Board } from './board.ts';
import { backgroundGoesOn } from './claude-background.ts';
import type { BoardConfig } from './config.ts';
import { killAgent, launchBlocked, listAgents, resumeAgent, stopAgent } from './hcom.ts';
import { readProvider, readTranscript } from './helper.ts';
import { automationWorkspace, readScreen } from './herdr.ts';
import { startLaunch } from './launch.ts';

/** hcom's launch failed on its own database lock (#657): the wait before each retry, so at most three. */
export const LAUNCH_LOCK_WAITS_MS: readonly number[] = [60_000, 120_000, 240_000];
/** How often a wait before a retry looks for 停止這次 or the time limit. */
const WAIT_LOOK_MS = 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const isLockedFailure = (reason: string) => /database is locked/i.test(reason);

/** Wait `ms`, looking every second whether the run was stopped or ran out of time; ends at once then. */
export async function pauseUnlessHalted(ms: number, halted: () => Cut | null): Promise<void> {
	for (let left = ms; left > 0 && !halted(); left -= WAIT_LOOK_MS) await sleep(Math.min(left, WAIT_LOOK_MS));
}

type Launched = { ok: true; name: string; workspace: string | null } | { ok: false; reason: string; cut?: Cut };

/** Run `attempt`; when hcom failed on `database is locked`, clean up what that left, wait and try
 *  again, once per wait in `waitsMs`. Only that error retries. A stop or the time limit, seen
 *  before or during a wait, ends it at once with `cut`; running out of retries says so. */
export async function launchWithLockRetry(deps: {
	attempt: () => Promise<Launched>;
	cleanup: () => Promise<string | null>;
	halted: () => Cut | null;
	waitsMs?: readonly number[];
	pause?: (ms: number, halted: () => Cut | null) => Promise<void>;
}): Promise<Launched> {
	const waits = deps.waitsMs ?? LAUNCH_LOCK_WAITS_MS;
	const pause = deps.pause ?? pauseUnlessHalted;
	let result = await deps.attempt();
	for (const wait of waits) {
		if (result.ok || !isLockedFailure(result.reason)) return result;
		let left = await deps.cleanup();
		if (left && !isLockedFailure(left)) return { ok: false, reason: `${result.reason}；清不掉這次留下的半開 Agent：${left}` };
		await pause(wait, deps.halted);
		const cut = deps.halted();
		if (cut) return { ok: false, reason: result.reason, cut };
		// The lock hit the cleanup too: it is done again after the wait, before anything is launched.
		if (left && (left = await deps.cleanup())) {
			if (!isLockedFailure(left)) return { ok: false, reason: `${result.reason}；清不掉這次留下的半開 Agent：${left}` };
			result = { ok: false, reason: `${result.reason}；清理也遇到：${left}` };
			continue;
		}
		// Looked at again right before launching: a stop during the cleanup is not launched over.
		const late = deps.halted();
		if (late) return { ok: false, reason: result.reason, cut: late };
		result = await deps.attempt();
	}
	if (result.ok || !isLockedFailure(result.reason)) return result;
	// The last launch left its half-opened agent too; the run fails without an agent to close it.
	const left = await deps.cleanup();
	return { ok: false, reason: `已重試 ${waits.length} 次仍失敗，最後一次：${result.reason}${left ? `；清不掉這次留下的半開 Agent：${left}` : ''}` };
}

/** The agent a failed launch left: same tag, listed by hcom, no terminal. `hcom kill` ends it;
 *  when that fails (hcom has no process tracked for it), `hcom stop`. Why one is left, or null. */
export async function closeHalfLaunched(config: BoardConfig, tag: string): Promise<string | null> {
	const listed = await listAgents(config);
	if (!listed.ok) return listed.reason;
	for (const agent of listed.agents.filter((agent) => agent.tag === tag && !agent.pane)) {
		const killed = await killAgent(config, agent.name);
		if (killed.failure) {
			const stopped = await stopAgent(config, agent.name);
			if (stopped.failure) return `${agent.name}：hcom kill ${killed.failure}；hcom stop ${stopped.failure}`;
		}
	}
	const after = await listAgents(config);
	if (!after.ok) return after.reason;
	const left = after.agents.find((agent) => agent.tag === tag && !agent.pane);
	return left ? `${left.name} 還在 hcom 的清單上` : null;
}

/** The host every agent task's run goes through; `board` is read when a run first needs it. */
export function boardAgentHost(config: BoardConfig, board: () => Board, retry: { waitsMs?: readonly number[]; pause?: (ms: number, halted: () => Cut | null) => Promise<void> } = {}): AgentHost {
	return {
		pollMs: config.automationAgentPollMs,
		async launch(spec) {
			// Always the AUTOMATION workspace, made first when Herdr has none; the folder stays the task's.
			const place = await automationWorkspace(config, spec.folder);
			if (!place.ok) return { ok: false, reason: place.reason };
			const attempt = async (): Promise<Launched> => {
				const { body } = await startLaunch(board(), {
					client: spec.client,
					folder: spec.folder,
					text: spec.prompt,
					gitInit: false,
					workspace: { kind: 'existing', id: place.id },
					agent: { tabName: '', tag: spec.tag },
					model: spec.model,
					effort: spec.effort
				});
				if (!body.ok) return { ok: false, reason: body.reason ?? '原因不明' };
				const name = body.entry?.hcomName;
				if (!name) return { ok: false, reason: 'hcom 沒有給 Agent 名稱，無法追蹤這次執行；請到 Herdr 分頁查看並自行關閉' };
				return { ok: true, name, workspace: body.entry?.herdrWorkspace ?? null };
			};
			return launchWithLockRetry({ attempt, cleanup: () => closeHalfLaunched(config, spec.tag), halted: spec.halted ?? (() => null), ...retry });
		},
		async list() {
			const listed = await listAgents(config);
			if (!listed.ok) return listed;
			return { ok: true, agents: listed.agents.map(({ name, sessionId, pane, status, tag }) => ({ name, sessionId, pane, status, tag: tag ?? null })) };
		},
		async lastReply(client, sessionId) {
			const read = await readTranscript(config, client, sessionId);
			if (!read.ok) return { ok: false, reason: read.reason };
			const items = read.page.items;
			const reply = items.findLast((item) => item.kind === 'assistant');
			const time = reply?.time ? Date.parse(reply.time) : NaN;
			return { ok: true, text: reply && 'text' in reply ? reply.text : null, seq: reply?.seq ?? -1, time: Number.isNaN(time) ? null : time };
		},
		async repliesAfter(client, sessionId, seq) {
			const read = await readTranscript(config, client, sessionId);
			if (!read.ok) return { ok: false, reason: read.reason };
			return { ok: true, replies: read.page.items.flatMap((item) => (item.kind === 'assistant' && item.seq > seq && 'text' in item ? [{ text: item.text, seq: item.seq }] : [])) };
		},
		async position(client, sessionId) {
			const read = await readTranscript(config, client, sessionId);
			return read.ok ? { ok: true, seq: read.page.items.at(-1)?.seq ?? -1 } : { ok: false, reason: read.reason };
		},
		provider: (client, sessionId) => readProvider(config, client, sessionId),
		async backgroundGoesOn(sessionId) {
			const read = await readTranscript(config, 'claude', sessionId);
			if (!read.ok) return false;
			try {
				return backgroundGoesOn(await readFile(read.path, 'utf8'));
			} catch {
				return false;
			}
		},
		async transcript(client, sessionId) {
			const read = await readTranscript(config, client, sessionId);
			return read.ok ? read.path : null;
		},
		async inputAfter(client, sessionId, seq) {
			const read = await readTranscript(config, client, sessionId);
			if (!read.ok) return null;
			// Typed in (the terminal, or the board's own send) or the question panel's answer (hcom
			// sender lat-panel, #678); other agents' hcom messages and hook prompts are not the user's input.
			const input = read.page.items.find((item) => item.seq > seq && (item.kind === 'user' || (item.kind === 'tool' && item.name === 'lat-panel')));
			if (!input) return null;
			return { text: input.kind === 'tool' ? input.detail || input.label : input.text, seq: input.seq };
		},
		async send(sessionId, text) {
			const sent = await sendToAgent(board(), sessionId, text);
			return sent.body.ok ? null : (sent.body.reason ?? '沒有送到');
		},
		async screen(pane) {
			const read = await readScreen(config, pane, 'detection');
			return 'text' in read ? read.text : null;
		},
		launchBlocked: (name, since) => launchBlocked(config, name, since),
		async close({ sessionId, name }) {
			let why = '';
			if (sessionId) {
				const closed = await closeAgent(board(), sessionId);
				if (closed.body.ok) return null;
				why = closed.body.reason ?? '';
			}
			// Not closable from the Herdr tab (not listed there): hcom ends it.
			const killed = await killAgent(config, name);
			return killed.failure ? `關不掉這個 Agent：${why ? `${why}；` : ''}hcom kill ${killed.failure}` : null;
		},
		async resume(sessionId, workspace, prompt) {
			if (!workspace) return '不知道它原本開在哪個 Herdr 工作區';
			const resumed = await resumeAgent(config, { sessionId, herdrWorkspace: workspace, prompt, extraArgs: [] });
			return resumed.outcome === 'failed' ? (resumed.reason ?? '接回失敗') : null;
		}
	};
}
