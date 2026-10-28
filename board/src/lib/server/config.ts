// Board settings, read from the environment. No SvelteKit imports: the host command uses this too.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parseModelOptions, type ModelOptions } from '../board/models.ts';
import { ASK_EXECUTION_WAIT_MS } from '../board/board-asks.ts';
import { codexMultiAuthDir } from './quota.ts';

type Env = Record<string, string | undefined>;

export interface BoardConfig {
	/** Where the board keeps its own state (logged-in devices, password hash, sent log). */
	stateDir: string;
	/** Where the turn-end hook appends controller report records. */
	reportsDir: string;
	/** Where the status line recorder keeps each Claude session's context use, quota and cache. */
	usageDir: string;
	/** The user's own stylesheet, loaded after the built-in styles on every device. May not exist. */
	userStylePath: string;
	/** Command that runs the LAT panel helper; the board appends `board <command>`. */
	helperCommand: string[];
	helperTimeoutMs: number;
	/** Command that types into a controller's client; the board appends `<HCOM name> <text> --enter`. */
	injectCommand: string[];
	injectTimeoutMs: number;
	/** Command that runs hcom; the board appends e.g. `claude --dir <folder> ...` to start a controller. */
	hcomCommand: string[];
	/** How long an hcom launch or resume may take, its own wait for the client to be ready included. */
	hcomTimeoutMs: number;
	/** How long `hcom list --json` and `hcom kill` may take; neither waits for a client to start. */
	hcomListTimeoutMs: number;
	/** The models and efforts the forms offer each client. */
	modelOptions: ModelOptions;
	/** Command that runs the Herdr CLI; the board appends e.g. `pane list`. */
	herdrCommand: string[];
	herdrTimeoutMs: number;
	/** Herdr's socket, for the requests its CLI does not offer (moving a tab). */
	herdrSocket: string;
	/** How long a new controller may take to bind before its launch record asks the user to look in Herdr. */
	launchWaitMs: number;
	/** The Herdr pane the board itself runs in, when it was started inside one; null otherwise. */
	ownPane: string | null;
	/** Where an agent whose HCOM link is paused has its pause record, shared with LAT's stall watcher. */
	pausedDir: string;
	/** The folder the board-ask hook and the board share: the asks, their results and the board's heartbeat. */
	asksDir: string;
	/** How long a permission Codex was allowed after its turn ended waits to be seen run before the
	 *  board stops waiting: 7 days. */
	askExecutionWaitMs: number;
	/** How long a resumed link may take to show in hcom's list before the board says it did not. */
	unpauseWaitMs: number;
	/** Longest a change the file watch missed may take to be read and pushed to the pages. */
	fallbackMs: number;
	debounceMs: number;
	/** How long a source address is refused after too many wrong passwords in a row. */
	loginLockMs: number;
	/** The speech recognition service voice input sends its recordings to; null turns voice input off. */
	asrUrl: string | null;
	/** The service's access token. It stays on the server: no response to a page carries it. */
	asrToken: string | null;
	asrTimeoutMs: number;
	/** Where files attached to a message are kept; the message carries their paths. */
	uploadDir: string;
	/** The largest file that may be attached. */
	uploadMaxBytes: number;
	/** Command that runs a Codex app server over standard input and output, to tidy long speech. */
	tidyCommand: string[];
	tidyTimeoutMs: number;
	/** The same for translating English replies of a conversation into Chinese. */
	translateCommand: string[];
	translateTimeoutMs: number;
	/** Command that runs a Codex app server as the user's own, to list the skills Codex can call in a folder. */
	skillsCommand: string[];
	skillsTimeoutMs: number;
	/** How many Codex app servers translate at once; more requests wait their turn. */
	translateConcurrency: number;
	/** How long a saved translation is kept after it was last used. */
	translateKeepMs: number;
	/** Command that runs claude-swap; the board appends `list --json --cached-only`, which reads its files only. */
	cswapCommand: string[];
	cswapTimeoutMs: number;
	/** codex-multi-auth's folder, whose account file and quota cache the board reads. */
	codexMultiAuthDir: string;
	/** How often the 額度 tab's sources are read. */
	quotaIntervalMs: number;
	/** Command that runs pd; the board appends `pending --json`, `deny <id>`, or the passkey relay (`passkey challenge <id>`, `passkey approve <id>` with the page's assertion on stdin), never a confirmation code. */
	pdCommand: string[];
	pdTimeoutMs: number;
	/** How often pd's waiting requests are read. */
	pdIntervalMs: number;
	/** How often the agents' statuses (hcom's and Herdr's lists only) are read while a page is connected. */
	statusPollMs: number;
	/** The same while an agent works through hcom, so that a turn ended by Esc, which hcom never reports, is noticed in time. */
	statusWorkingPollMs: number;
	/** The longest one such read may take; each list is cut off at it. */
	statusPollTimeoutMs: number;
	/** How soon after a send or an interrupt from the board the statuses are read once more. */
	statusAfterActionMs: number;
	/** The current time in milliseconds. Read state and archiving use this, never `Date.now()`. */
	now(): number;
}

const MAX_FALLBACK_MS = 60_000;
const DAY_SECONDS = 24 * 60 * 60;
/** Below this there is no room left for the helper to run twice. */
const MIN_FALLBACK_MS = 5_000;
/** Allowed for reading the report files and pushing the snapshot once the helper has answered. */
export const READ_SLACK_MS = 1_000;

function stateHome(env: Env): string {
	const value = env.XDG_STATE_HOME;
	return value && isAbsolute(value) ? value : join(homedir(), '.local/state');
}

function configHome(env: Env): string {
	const value = env.XDG_CONFIG_HOME;
	return value && isAbsolute(value) ? value : join(homedir(), '.config');
}

function seconds(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return value && Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : fallback;
}

/** A command given as a JSON array of strings; undefined when the variable is not set. */
function commandFrom(env: Env, name: string): string[] | undefined {
	if (!env[name]) return undefined;
	const parsed: unknown = JSON.parse(env[name]);
	if (!Array.isArray(parsed) || !parsed.length || parsed.some((part) => typeof part !== 'string')) {
		throw new Error(`${name} must be a JSON array of strings`);
	}
	return parsed;
}

/** A Codex app server for turns that only rewrite text: none of the coding agent's apps, hooks,
 *  memories, plugins, skills or tools, which only slow every turn and fill its prompt. Its MCP
 *  servers are turned off per thread (codex-turn.ts). Features go as `-c features.<name>=false`,
 *  which a later Codex without that feature ignores, where `--disable` would refuse to start. */
const TEXT_ONLY_CODEX = [
	'codex',
	'app-server',
	...[
		...['apps', 'hooks', 'memories', 'plugins', 'multi_agent', 'goals', 'tool_suggest', 'skill_search'],
		...['shell_tool', 'unified_exec', 'view_image', 'image_generation', 'browser_use', 'computer_use']
	].flatMap((feature) => ['-c', `features.${feature}=false`]),
	...[
		...['skills.include_instructions=false', 'web_search="disabled"', 'include_permissions_instructions=false'],
		...['include_collaboration_mode_instructions=false', 'include_environment_context=false']
	].flatMap((setting) => ['-c', setting])
];

function helperCommand(env: Env): string[] {
	const given = commandFrom(env, 'LAT_BOARD_HELPER_COMMAND');
	if (given) return given;
	const latDir = env.LAT_BOARD_LAT_DIR || join(homedir(), '.agents/skills/lat');
	return ['uv', 'run', '--no-project', 'python', join(latDir, 'herdr-panel/lat_panel.py')];
}

/** The real clock, or for tests the time written in the file `LAT_BOARD_CLOCK_FILE` names. */
function clock(env: Env): () => number {
	const file = env.LAT_BOARD_CLOCK_FILE;
	if (!file) return Date.now;
	return () => {
		try {
			const time = Date.parse(readFileSync(file, 'utf8').trim());
			return Number.isNaN(time) ? Date.now() : time;
		} catch {
			return Date.now();
		}
	};
}

export function loadConfig(env: Env = process.env): BoardConfig {
	const fallbackMs = Math.max(
		MIN_FALLBACK_MS,
		Math.min(seconds(env.LAT_BOARD_FALLBACK_SECONDS, MAX_FALLBACK_MS), MAX_FALLBACK_MS)
	);
	return {
		stateDir: env.LAT_BOARD_STATE_DIR || join(stateHome(env), 'lat/board'),
		// 須與 `skills/local/lat/scripts/_lat_common.py` 一致
		reportsDir: env.LAT_REPORTS_DIR || join(stateHome(env), 'lat/reports'),
		usageDir: env.LAT_USAGE_DIR || join(stateHome(env), 'lat/usage'),
		userStylePath: join(env.LAT_BOARD_CONFIG_DIR || join(configHome(env), 'lat/board'), 'user.css'),
		helperCommand: helperCommand(env),
		// A missed change may wait out one read and then need a second one; both must fit in the
		// fallback deadline, and each runs the helper twice in a row (the list, then the answered
		// questions and sent answers), so the helper never gets more than a quarter of it.
		helperTimeoutMs: Math.min(seconds(env.LAT_BOARD_HELPER_TIMEOUT_SECONDS, 15_000), (fallbackMs - READ_SLACK_MS) / 4),
		injectCommand: commandFrom(env, 'LAT_BOARD_INJECT_COMMAND') ?? ['hcom', 'term', 'inject'],
		// The command itself waits up to 2 seconds for the client to show the text before submitting.
		injectTimeoutMs: seconds(env.LAT_BOARD_INJECT_TIMEOUT_SECONDS, 15_000),
		hcomCommand: commandFrom(env, 'LAT_BOARD_HCOM_COMMAND') ?? ['hcom'],
		// hcom itself waits for the client to report ready before it answers.
		hcomTimeoutMs: seconds(env.LAT_BOARD_HCOM_TIMEOUT_SECONDS, 60_000),
		hcomListTimeoutMs: seconds(env.LAT_BOARD_HCOM_LIST_TIMEOUT_SECONDS, 15_000),
		modelOptions: parseModelOptions(env.LAT_BOARD_MODEL_OPTIONS),
		herdrCommand: commandFrom(env, 'LAT_BOARD_HERDR_COMMAND') ?? ['herdr'],
		herdrTimeoutMs: seconds(env.LAT_BOARD_HERDR_TIMEOUT_SECONDS, 10_000),
		herdrSocket: env.HERDR_SOCKET_PATH || join(configHome(env), 'herdr/herdr.sock'),
		launchWaitMs: seconds(env.LAT_BOARD_LAUNCH_WAIT_SECONDS, 180_000),
		ownPane: env.HERDR_PANE_ID || null,
		// The same folder LAT's `lat-watch.py` and `lat-reap.py` read.
		pausedDir: env.LAT_HCOM_PAUSED_DIR && isAbsolute(env.LAT_HCOM_PAUSED_DIR) ? env.LAT_HCOM_PAUSED_DIR : join(stateHome(env), 'lat/hcom-paused'),
		// Next to the pause records; `hooks/board-ask.py` works it out the same way.
		asksDir: env.LAT_BOARD_ASKS_DIR && isAbsolute(env.LAT_BOARD_ASKS_DIR) ? env.LAT_BOARD_ASKS_DIR : join(stateHome(env), 'lat/board-asks'),
		askExecutionWaitMs: seconds(env.LAT_BOARD_ASK_EXECUTION_WAIT_SECONDS, ASK_EXECUTION_WAIT_MS),
		// A Codex agent runs one short turn to reconnect.
		unpauseWaitMs: seconds(env.LAT_BOARD_UNPAUSE_WAIT_SECONDS, 60_000),
		fallbackMs,
		debounceMs: 200,
		loginLockMs: seconds(env.LAT_BOARD_LOGIN_LOCK_SECONDS, 60_000),
		asrUrl: env.LAT_BOARD_ASR_URL?.replace(/\/+$/, '') || null,
		asrToken: env.LAT_BOARD_ASR_TOKEN || null,
		asrTimeoutMs: seconds(env.LAT_BOARD_ASR_TIMEOUT_SECONDS, 60_000),
		uploadDir: env.LAT_BOARD_UPLOAD_DIR || '/tmp/lat-board-uploads',
		uploadMaxBytes: (Number(env.LAT_BOARD_UPLOAD_MAX_MB) > 0 ? Number(env.LAT_BOARD_UPLOAD_MAX_MB) : 250) * 1024 * 1024,
		tidyCommand: commandFrom(env, 'LAT_BOARD_TIDY_COMMAND') ?? [...TEXT_ONLY_CODEX],
		tidyTimeoutMs: seconds(env.LAT_BOARD_TIDY_TIMEOUT_SECONDS, 30_000),
		translateCommand: commandFrom(env, 'LAT_BOARD_TRANSLATE_COMMAND') ?? [...TEXT_ONLY_CODEX],
		translateTimeoutMs: seconds(env.LAT_BOARD_TRANSLATE_TIMEOUT_SECONDS, 60_000),
		skillsCommand: commandFrom(env, 'LAT_BOARD_SKILLS_COMMAND') ?? ['codex', 'app-server'],
		skillsTimeoutMs: seconds(env.LAT_BOARD_SKILLS_TIMEOUT_SECONDS, 15_000),
		translateConcurrency: Math.max(1, Math.floor(Number(env.LAT_BOARD_TRANSLATE_CONCURRENCY)) || 3),
		// Days: read as seconds, then a second becomes a day.
		translateKeepMs: seconds(env.LAT_BOARD_TRANSLATE_KEEP_DAYS, 30_000) * DAY_SECONDS,
		cswapCommand: commandFrom(env, 'LAT_BOARD_CSWAP_COMMAND') ?? ['cswap'],
		cswapTimeoutMs: seconds(env.LAT_BOARD_CSWAP_TIMEOUT_SECONDS, 10_000),
		codexMultiAuthDir: codexMultiAuthDir(env),
		quotaIntervalMs: seconds(env.LAT_BOARD_QUOTA_SECONDS, 30_000),
		pdCommand: commandFrom(env, 'LAT_BOARD_PD_COMMAND') ?? ['pd'],
		pdTimeoutMs: seconds(env.LAT_BOARD_PD_TIMEOUT_SECONDS, 5_000),
		pdIntervalMs: seconds(env.LAT_BOARD_PD_SECONDS, 5_000),
		statusPollMs: seconds(env.LAT_BOARD_STATUS_POLL_SECONDS, 2_000),
		statusWorkingPollMs: seconds(env.LAT_BOARD_STATUS_WORKING_POLL_SECONDS, 2_000),
		statusPollTimeoutMs: seconds(env.LAT_BOARD_STATUS_POLL_TIMEOUT_SECONDS, 4_000),
		statusAfterActionMs: seconds(env.LAT_BOARD_STATUS_AFTER_ACTION_SECONDS, 2_000),
		now: clock(env)
	};
}
