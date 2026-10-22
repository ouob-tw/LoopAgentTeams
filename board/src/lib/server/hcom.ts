// Starting agents through hcom, in a Herdr tab of a workspace the board picks.
import type { LaunchClient, LaunchOutcome } from '../board/launch.ts';
import type { BoardConfig } from './config.ts';
import { parseJsonOutput, runCommand, type ExternalResult } from './external.ts';

interface LaunchResult {
	outcome: LaunchOutcome;
	hcomName: string | null;
	/** Why it failed, or what is not known about a launch that did not report ready. */
	reason: string | null;
}

/** The one agent name the launch output's `Names:` line gives, or null. */
function launchedName(stdout: string): string | null {
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

/** The board's own environment without the identity of an agent or pane it was started from. */
export function ownEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(process.env)) if (!agentIdentity(name)) env[name] = value;
	return env;
}

/** The environment hcom starts or resumes an agent in: the board's own, as the background service
 *  has it even when the board was started from inside an agent's shell or a Herdr pane, with
 *  Herdr's tab opening in this workspace. */
function hcomEnv(herdrWorkspace: string): NodeJS.ProcessEnv {
	const env = ownEnv();
	env.HERDR_WORKSPACE_ID = herdrWorkspace;
	return env;
}

/** What one hcom run that opens a client ended as: ready, still starting (exit 2 or out of time) or
 *  failed. `action` names the run in the reasons: 啟動 or 接回. */
function launchResult(run: ExternalResult, action = '啟動'): LaunchResult {
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

/** Start one agent of this client in the folder, with this first message (none when it is
 *  empty), in a new Herdr tab of the workspace. `extraArgs` go to the client, after hcom's own flags. */
export async function launchAgent(
	config: BoardConfig,
	launch: { client: LaunchClient; folder: string; herdrWorkspace: string; prompt: string; extraArgs: string[] }
): Promise<LaunchResult> {
	const prompt = launch.prompt ? ['--hcom-prompt', launch.prompt] : [];
	const args = [launch.client, '--dir', launch.folder, ...IN_A_HERDR_TAB, '--go', ...prompt, ...launch.extraArgs];
	const run = await runCommand(config.hcomCommand, args, {
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
	const run = await runCommand(config.hcomCommand, args, {
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
	const run = await runCommand(config.hcomCommand, ['list', '--json'], { timeoutMs: config.hcomListTimeoutMs });
	if (run.failure) return { ok: false, reason: `hcom 的 Agent 清單讀不到：${run.failure}` };
	const read = parseJsonOutput<unknown>(run, 'hcom 的 Agent 清單不是預期的 JSON');
	if (!read.ok) return read;
	const parsed = read.value;
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
	return runCommand(config.hcomCommand, ['kill', name], { timeoutMs: config.hcomListTimeoutMs });
}

/** The arguments hcom repeats when it resumes this session: those its latest `stopped` event kept
 *  of the launch before. An empty list when hcom never stopped it (a session started outside hcom
 *  has none to repeat); null when they cannot be read. */
export async function storedLaunchArgs(config: BoardConfig, sessionId: string): Promise<string[] | null> {
	// Only the session's own events. The ID goes into hcom's SQL: nothing but letters, digits, underscores and dashes.
	if (!/^[\w-]+$/.test(sessionId)) return null;
	const sql = `data like '%${sessionId}%'`;
	const args = ['events', '--type', 'life', '--action', 'stopped', '--full', '--last', '20', '--sql', sql];
	const run = await runCommand(config.hcomCommand, args, { timeoutMs: config.hcomListTimeoutMs });
	if (run.failure) return null;
	let latest: { id: number; args: string[] | null } | null = null;
	for (const line of run.stdout.split('\n')) {
		if (!line.trim()) continue;
		let event: { id?: unknown; data?: { snapshot?: { session_id?: unknown; launch_args?: unknown } } };
		try {
			event = JSON.parse(line);
		} catch {
			return null;
		}
		const snapshot = event?.data?.snapshot;
		if (typeof event?.id !== 'number' || snapshot?.session_id !== sessionId || (latest && latest.id > event.id)) continue;
		latest = { id: event.id, args: launchArgsOf(snapshot.launch_args) };
	}
	return latest ? latest.args : [];
}

/** hcom keeps the arguments as a JSON list in a string; null when they are in another shape. */
function launchArgsOf(value: unknown): string[] | null {
	if (value === null || value === undefined || value === '') return [];
	try {
		const args: unknown = typeof value === 'string' ? JSON.parse(value) : null;
		return Array.isArray(args) && args.every((arg) => typeof arg === 'string') ? args : null;
	} catch {
		return null;
	}
}

/** One `stopped` life event of hcom: who stopped which session, and when. */
export interface HcomStop {
	/** hcom's event ID: a later stop has a higher one. */
	id: number;
	/** The HCOM name it ran under. */
	name: string;
	/** Who stopped it: `cli`, `pty`, `session`, `system`, `subagent`, or another agent's name. */
	by: string;
	reason: string;
	/** Board clock milliseconds. */
	time: number;
	/** From the event's snapshot of the agent; null when it has none. */
	sessionId: string | null;
	client: string | null;
	folder: string | null;
}

export type StopList = { ok: true; stops: HcomStop[] } | { ok: false; reason: string };

const textOf = (value: unknown) => (typeof value === 'string' && value ? value : null);

/** hcom's `stopped` events since this time (board clock milliseconds), oldest first. Only the full
 *  form of an event carries the agent's session; its time without a zone is UTC. */
export async function listStops(config: BoardConfig, since: number): Promise<StopList> {
	const args = ['events', '--type', 'life', '--action', 'stopped', '--full', '--after', new Date(since).toISOString(), '--last', '100000'];
	const run = await runCommand(config.hcomCommand, args, { timeoutMs: config.hcomListTimeoutMs });
	if (run.failure) return { ok: false, reason: `hcom 的停止紀錄讀不到：${run.failure}` };
	const stops: HcomStop[] = [];
	for (const line of run.stdout.split('\n')) {
		if (!line.trim()) continue;
		let event: { id?: unknown; instance?: unknown; ts?: unknown; data?: Record<string, unknown> };
		try {
			event = JSON.parse(line);
		} catch {
			return { ok: false, reason: 'hcom 的停止紀錄不是預期的 JSON' };
		}
		const data = event?.data;
		const ts = textOf(event?.ts);
		if (typeof event?.id !== 'number' || typeof event.instance !== 'string' || !ts || data?.action !== 'stopped' || typeof data.by !== 'string') {
			return { ok: false, reason: 'hcom 的停止紀錄不是預期的格式' };
		}
		const time = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : `${ts}Z`);
		if (Number.isNaN(time)) return { ok: false, reason: 'hcom 的停止紀錄時間不是預期的格式' };
		const snapshot = (typeof data.snapshot === 'object' && data.snapshot !== null ? data.snapshot : {}) as Record<string, unknown>;
		stops.push({
			id: event.id,
			name: event.instance,
			by: data.by,
			reason: typeof data.reason === 'string' ? data.reason : '',
			time,
			sessionId: textOf(snapshot.session_id),
			client: textOf(snapshot.tool),
			folder: textOf(snapshot.directory)
		});
	}
	return { ok: true, stops };
}
