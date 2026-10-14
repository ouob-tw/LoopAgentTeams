// Starting agents through hcom, in a Herdr tab of a workspace the board picks.
import type { LaunchClient, LaunchOutcome } from '../board/launch.ts';
import type { BoardConfig } from './config.ts';
import { runExternal, type ExternalResult } from './external.ts';

export interface LaunchResult {
	outcome: LaunchOutcome;
	hcomName: string | null;
	/** Why it failed, or what is not known about a launch that did not report ready. */
	reason: string | null;
}

/** The one agent name the launch output's `Names:` line gives, or null. */
export function launchedName(stdout: string): string | null {
	const names = /^Names:[ \t]*(.*)$/m.exec(stdout)?.[1].split(/[\s,]+/).filter(Boolean) ?? [];
	return names.length === 1 ? names[0] : null;
}

/**
 * Whether a variable carries the identity of an agent the board may have been started from. hcom
 * treats the caller as that agent: it would make the new agent its child and end the first message
 * with a line asking to report back to it. Only HCOM_DIR, where hcom keeps its data, is kept; that
 * also drops HCOM_TAG, so the name hcom prints is the agent's whole name. CODEX_HOME is the
 * client's settings folder, not a session, so it is kept.
 *
 * A board started inside a Herdr pane also carries that pane's own place (HERDR_PANE_ID,
 * HERDR_TAB_ID, HERDR_ENV and the like): hcom's herdr terminal would record the new agent as
 * running in the caller's pane, so stopping the agent later would close it. Only how Herdr is
 * reached is kept: its socket and, when set, its config file.
 */
const HERDR_KEPT = new Set(['HERDR_SOCKET_PATH', 'HERDR_CONFIG_PATH']);

function agentIdentity(name: string): boolean {
	if (name.startsWith('HCOM_')) return name !== 'HCOM_DIR';
	if (name.startsWith('CODEX_')) return name !== 'CODEX_HOME';
	if (name.startsWith('HERDR_')) return !HERDR_KEPT.has(name);
	return name === 'CLAUDECODE' || name === 'CLAUDE_PID' || name === 'CLAUDE_EFFORT' || name === 'AI_AGENT' || name.startsWith('CLAUDE_CODE_');
}

/** The environment hcom starts or resumes an agent in: the board's own, as the background service
 *  has it even when the board was started from inside an agent's shell or a Herdr pane, with
 *  Herdr's tab opening in this workspace. */
export function hcomEnv(herdrWorkspace: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(process.env)) if (!agentIdentity(name)) env[name] = value;
	env.HERDR_WORKSPACE_ID = herdrWorkspace;
	return env;
}

/** What one hcom run that opens a client ended as: ready, still starting (exit 2 or out of time) or
 *  failed. `action` names the run in the reasons: 啟動 or 接回. */
export function launchResult(run: ExternalResult, action = '啟動'): LaunchResult {
	const hcomName = launchedName(run.stdout);
	if (run.code === 0) return { outcome: 'started', hcomName, reason: null };
	if (run.code === 2) return { outcome: 'pending', hcomName, reason: 'hcom 回報主控仍在啟動，或在等你到 Herdr 分頁處理' };
	if (run.timedOut) return { outcome: 'pending', hcomName, reason: `hcom ${action}指令${run.failure}，分頁可能已經開了` };
	return { outcome: 'failed', hcomName, reason: `hcom ${action}失敗：${run.failure}` };
}

/**
 * Where hcom puts the agent: always a new Herdr tab. hcom does not go by `--terminal` when it
 * decides whether to run a single agent inside the calling process; from a shell that is not an
 * agent's (the background service, or the board with the caller's identity removed) it would run
 * it inside the board's own child process, with no tab, until the board gave up waiting.
 * `--no-run-here` is accepted although `hcom <client> --help` does not list it.
 */
const IN_A_HERDR_TAB = ['--terminal', 'herdr', '--no-run-here'];

/** Start one agent of this client in the folder, with this first message, in a new Herdr tab of
 *  the workspace. `extraArgs` go to the client, after hcom's own flags. */
export async function launchAgent(
	config: BoardConfig,
	launch: { client: LaunchClient; folder: string; herdrWorkspace: string; prompt: string; extraArgs: string[] }
): Promise<LaunchResult> {
	const args = [launch.client, '--dir', launch.folder, ...IN_A_HERDR_TAB, '--go', '--hcom-prompt', launch.prompt, ...launch.extraArgs];
	const run = await runExternal(config.hcomCommand, args, {
		timeoutMs: config.hcomTimeoutMs,
		env: hcomEnv(launch.herdrWorkspace)
	});
	return launchResult(run);
}

/** Resume the conversation with this session ID in a new Herdr tab of the workspace, with this
 *  first message (none when it is empty). `extraArgs` go to the client, after hcom's own flags. */
export async function resumeAgent(
	config: BoardConfig,
	resume: { sessionId: string; herdrWorkspace: string; prompt: string; extraArgs: string[] }
): Promise<LaunchResult> {
	const prompt = resume.prompt ? ['--hcom-prompt', resume.prompt] : [];
	const args = ['r', resume.sessionId, ...IN_A_HERDR_TAB, '--go', ...prompt, ...resume.extraArgs];
	const run = await runExternal(config.hcomCommand, args, {
		timeoutMs: config.hcomTimeoutMs,
		env: hcomEnv(resume.herdrWorkspace)
	});
	return launchResult(run, '接回');
}

/** One agent in hcom's list: the running ones and those still starting, bound or not. */
export interface HcomAgent {
	name: string;
	/** Null while the client has not reported its session yet. */
	sessionId: string | null;
	/** The Herdr pane it runs in, when hcom knows it. */
	pane: string | null;
	/** hcom's status, e.g. `listening` or `active`; null when it gave none. */
	status: string | null;
}

/** The agent with this session ID, or else one with any of these names. */
export function findAgent(agents: HcomAgent[], sessionId: string, names: (string | null)[]): HcomAgent | undefined {
	return agents.find((agent) => agent.sessionId === sessionId) ?? agents.find((agent) => agent.name && names.includes(agent.name));
}

export type AgentList = { ok: true; agents: HcomAgent[] } | { ok: false; reason: string };

/** hcom's list of agents. Whether a client is still running is told by its session ID in it. */
export async function listAgents(config: BoardConfig): Promise<AgentList> {
	const run = await runExternal(config.hcomCommand, ['list', '--json'], { timeoutMs: config.hcomListTimeoutMs });
	if (run.failure) return { ok: false, reason: `hcom 的 Agent 清單讀不到：${run.failure}` };
	let parsed: unknown;
	try {
		parsed = JSON.parse(run.stdout);
	} catch {
		return { ok: false, reason: 'hcom 的 Agent 清單不是預期的 JSON' };
	}
	const valid =
		Array.isArray(parsed) &&
		parsed.every(
			(agent) =>
				typeof agent?.name === 'string' &&
				(agent.session_id === null || agent.session_id === undefined || typeof agent.session_id === 'string')
		);
	if (!valid) return { ok: false, reason: 'hcom 的 Agent 清單不是預期的格式' };
	return {
		ok: true,
		agents: (parsed as { name: string; session_id?: string | null; status?: unknown; launch_context?: { pane_id?: unknown } | null }[]).map((agent) => ({
			name: agent.name,
			sessionId: agent.session_id || null,
			pane: typeof agent.launch_context?.pane_id === 'string' ? agent.launch_context.pane_id : null,
			status: typeof agent.status === 'string' ? agent.status : null
		}))
	};
}

/** Stop one agent's process; hcom closes its terminal pane too. Whether it is gone is for the
 *  caller to check: the command's own answer does not say. */
export function killAgent(config: BoardConfig, name: string): Promise<ExternalResult> {
	return runExternal(config.hcomCommand, ['kill', name], { timeoutMs: config.hcomListTimeoutMs });
}
