// The 任務提案 test fixture shared by the server tests (#759, #760): a test board whose fake hcom
// lists stand-in agents, and the agent's command run as their child. Agents are processes named
// `claude` or `codex` that run the command beneath them; every folder, the socket and hcom are the
// fixture's own.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logged, runCli, startFixture, until, uvPython, type CliResult, type Fixture } from './harness.ts';

export const CLI = join(import.meta.dir, '../../skills/local/task-proposal/scripts/task-proposal.py');
export const LAT_DIR = join(import.meta.dir, '../../skills/local/lat');

export interface AgentDouble {
	client: 'claude' | 'codex';
	/** HCOM_INSTANCE_NAME: the base name, as hcom sets it. */
	name: string;
	processId: string;
	folder: string;
}

/** An agent as hcom lists it. */
export const listed = (agent: AgentDouble, overrides: Record<string, unknown> = {}) => ({
	name: `grp-${agent.name}`,
	base_name: agent.name,
	tag: 'grp',
	tool: agent.client,
	status: 'active',
	session_id: `session-${agent.name}`,
	directory: agent.folder,
	launch_context: { process_id: agent.processId },
	...overrides
});

/** A folder of its own for each agent, outside any git checkout. */
export function agentFolder(board: Fixture, name: string): string {
	const folder = join(board.dir, 'workspaces', name);
	mkdirSync(join(folder, '.lat/sessions'), { recursive: true });
	return folder;
}

/** The stand-in client: a shell named `claude` or `codex` that runs its arguments as a child and
 *  stays their parent. With PROPOSAL_GATE set it writes its PID to `<gate>.pid` and waits for `<gate>`. */
export function clientBinary(board: Fixture, client: 'claude' | 'codex'): string {
	const bin = join(board.dir, 'agent-bin');
	mkdirSync(bin, { recursive: true });
	const path = join(bin, client);
	if (!existsSync(path)) {
		writeFileSync(path, '#!/bin/sh\nif [ -n "$PROPOSAL_GATE" ]; then echo $$ > "$PROPOSAL_GATE.pid"; while [ ! -e "$PROPOSAL_GATE" ]; do sleep 0.05; done; fi\n"$@"\n');
		chmodSync(path, 0o755);
	}
	return path;
}

/** The command's environment: the fixture's folder and socket, and the agent's HCOM identity. */
export function commandEnv(board: Fixture, agent?: AgentDouble, extra: Record<string, string> = {}) {
	const server = board.serverEnv();
	return {
		PATH: process.env.PATH ?? '',
		HOME: server.HOME,
		LAT_BOARD_PROPOSALS_DIR: server.LAT_BOARD_PROPOSALS_DIR,
		LAT_BOARD_PROPOSAL_SOCKET: server.LAT_BOARD_PROPOSAL_SOCKET,
		...(agent ? { HCOM_INSTANCE_NAME: agent.name, HCOM_TOOL: agent.client, HCOM_PROCESS_ID: agent.processId } : {}),
		...extra
	};
}

/** Run the command as the agent's child; without an agent, orphaned first, so no claude or codex
 *  process (such as the one running these tests) is above it. */
export function asAgent(board: Fixture, agent: AgentDouble | null, args: string[], options: { input?: string; env?: Record<string, string> } = {}): Promise<CliResult> {
	const command = [uvPython(), CLI, ...args];
	const env = commandEnv(board, agent ?? undefined, options.env);
	if (!agent) return runCli('/bin/sh', ['-c', '( "$@" & )', 'orphan', ...command], { env, input: options.input });
	return runCli('/bin/sh', ['-c', 'cd "$0" && exec "$@"', agent.folder, clientBinary(board, agent.client), ...command], { env, input: options.input });
}

export const commandTask = (folder: string, overrides: Record<string, unknown> = {}) => ({
	name: '每天備份筆記',
	schedule: { type: 'daily' },
	time: '09:30',
	limitMinutes: 30,
	kind: 'command',
	command: { command: 'echo backed-up', folder, checks: [] },
	...overrides
});

export const agentTask = (folder: string) => ({
	name: '每週整理 issue',
	schedule: { type: 'weekly', fromWeekday: 1, toWeekday: 5 },
	time: '10:00',
	limitMinutes: 60,
	kind: 'agent',
	agent: { client: 'codex', model: 'gpt-6.1-sol', effort: 'medium', folder, brief: 'brief.md' }
});

/** Send `task`; from a file when there is no agent, as an orphaned command has no standard input. */
export function submit(board: Fixture, agent: AgentDouble | null, task: unknown, env?: Record<string, string>) {
	if (agent) return asAgent(board, agent, ['--json', 'submit'], { input: JSON.stringify(task), env });
	const file = join(board.dir, 'proposal.json');
	writeFileSync(file, JSON.stringify(task));
	return asAgent(board, null, ['--json', 'submit', file], { env });
}
export const parsed = (result: CliResult) => JSON.parse(result.stdout);

export const proposalsDir = (board: Fixture) => board.serverEnv().LAT_BOARD_PROPOSALS_DIR;
export const filesIn = (board: Fixture) => (existsSync(proposalsDir(board)) ? readdirSync(proposalsDir(board)).sort() : []);
export const stored = (board: Fixture, id: string) => JSON.parse(readFileSync(join(proposalsDir(board), `${id}.json`), 'utf8'));

/** A fixture whose fake hcom lists these agents; each gets its folder. `started` hears of the
 *  fixture as soon as it runs, for the test file to clean up. */
export async function withAgents(names: { name: string; client: 'claude' | 'codex' }[], options: Parameters<typeof startFixture>[0] = {}, started?: (board: Fixture) => void) {
	// The acceptor reads LAT's session records by this repo's own LAT rules.
	const board = await startFixture({ ...options, env: { LAT_BOARD_LAT_DIR: LAT_DIR, ...options.env } });
	started?.(board);
	const agents = names.map(({ name, client }) => ({ name, client, processId: `process-${name}`, folder: agentFolder(board, name) }));
	board.setHcom({ agents: agents.map((agent) => listed(agent)) });
	await until(() => logged(board.serverOutput(), 'proposal_acceptor_ready').length > 0, 10_000, 'the acceptor to listen');
	return { board, agents };
}

