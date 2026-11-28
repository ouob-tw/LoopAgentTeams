// Board settings, read from the environment. No SvelteKit imports: the host command uses this too.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseModelOptions, type ModelOptions } from '../board/models.ts';
import { ASK_EXECUTION_WAIT_MS } from '../board/board-asks.ts';
import { connectionSettings, type AddressList } from './client-address.ts';
import { demoAddress, type DemoSite } from './demo-address.ts';

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
	/** The LAT skill folder (`LAT_BOARD_LAT_DIR`): an unattended automation task's controller runs its `lat-unattended.py`. */
	latDir: string;
	/** The clients' settings files an agent task's folder trust is read from, never written (#703):
	 *  `$CLAUDE_CONFIG_DIR/.claude.json` or `~/.claude.json`, `$CODEX_HOME/config.toml` or `~/.codex/config.toml`. */
	trustFiles: { claude: string; codex: string };
	helperTimeoutMs: number;
	/** Command that types into a controller's client; the board appends `<HCOM name> <text> --enter`. */
	injectCommand: string[];
	injectTimeoutMs: number;
	/** Command that runs hcom; the board appends e.g. `claude --dir <folder> ...` to start a controller. */
	hcomCommand: string[];
	/** Where hcom keeps its data (`HCOM_DIR`, else `~/.hcom`), the folder hcom lets its Codex agents
	 *  write to; taken to be the one hcom itself resolves, as both read the same environment. */
	hcomDir: string;
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
	/** The task-proposal folder (`LAT_BOARD_PROPOSALS_DIR`): one proposal file and one result file per
	 *  任務提案. The agent's command reads the results here too, so it works the folder out the same way. */
	proposalsDir: string;
	/** The local socket agents send proposals and withdrawals to (`LAT_BOARD_PROPOSAL_SOCKET`). */
	proposalSocket: string;
	/** What runs the acceptor that listens on it (`LAT_BOARD_PROPOSAL_ACCEPTOR_COMMAND`); the board appends the socket's path. */
	proposalAcceptorCommand: string[];
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
	/** Who may connect at all, checked before anything else; only the host itself when not set. */
	allowedSources: AddressList;
	/** Proxies whose `X-Forwarded-For` and `X-Forwarded-Proto` the board believes; none when not set. */
	trustedProxies: AddressList;
	/** Where passkeys work: the board's address as browsers open it, and the passkeys' RP ID. Null
	 *  when the board's address is not set, which leaves passkeys off. */
	passkeySite: PasskeySite | null;
	/** The speech recognition service voice input sends its recordings to; null turns voice input off. */
	asrUrl: string | null;
	/** The service's access token. It stays on the server: no response to a page carries it. */
	asrToken: string | null;
	asrTimeoutMs: number;
	/** Where files attached to a message are kept; the message carries their paths. */
	uploadDir: string;
	/** Where `demo.py publish` puts demo pages (`<data>/site`), served under `/demo/<name>/`. May not exist. */
	demoSiteDir: string;
	/** Where `demo.py share` leaves an agent's request to share a demo (`<data>/share-requests`), one
	 *  file per demo; only a passkey confirmation on the board shares it (demo-share-requests.ts). */
	demoRequestsDir: string;
	/** The demo pages' own address (`LAT_BOARD_DEMO_URL`), another origin than the board's; null serves
	 *  them sandboxed under the board's `/demo/` instead. */
	demoSite: DemoSite | null;
	/** The largest file that may be attached. */
	uploadMaxBytes: number;
	/** Command that runs a Codex app server over standard input and output, to tidy long speech. */
	tidyCommand: string[];
	tidyTimeoutMs: number;
	/** The same for translating English replies of a conversation into Chinese. */
	translateCommand: string[];
	translateTimeoutMs: number;
	/** Command that runs one text-only turn of the Claude CLI on Haiku, standing in for Codex in
	 *  translation and tidy while luna's quota is out; the board appends `--system-prompt <prompt>`. */
	haikuCommand: string[];
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
	/** CPA's management API, whose Codex accounts the 額度 tab shows: its base URL
	 *  (`LAT_BOARD_CPA_URL`) and the file holding the management key alone
	 *  (`LAT_BOARD_CPA_MANAGEMENT_KEY_FILE`); either unset shows the Codex group as not set up. */
	cpa: { url: string | null; keyFile: string | null };
	/** How often the 額度 tab's sources are read. */
	quotaIntervalMs: number;
	/** Command that runs pd; the board appends `pending --json`, `deny <id>`, or the passkey relay (`passkey challenge <id>`, `passkey approve <id>` with the page's assertion on stdin), never a confirmation code. */
	pdCommand: string[];
	pdTimeoutMs: number;
	/** How often pd's waiting requests are read. */
	pdIntervalMs: number;
	/** How often the 自動化 scheduler checks for tasks due, ended periods and run limits. */
	automationTickMs: number;
	/** How often a running agent task's agent is looked at (hcom's list, its last reply). */
	automationAgentPollMs: number;
	/** Waits before each retry of a launch hcom failed on its database lock; null for the fixed 1, 2, 4 minutes. Only tests set it. */
	automationLaunchRetryWaitsMs: number[] | null;
	/** An origin taken as a Web Push service besides the browsers' real ones: only the tests' fake service sets it. */
	pushTestOrigin: string | null;
	/** How often the agents' statuses (hcom's and Herdr's lists only) are read while a page is connected. */
	statusPollMs: number;
	/** The same while an agent works through hcom, so that a turn ended by Esc, which hcom never reports, is noticed in time. */
	statusWorkingPollMs: number;
	/** The longest one such read may take; each list is cut off at it. */
	statusPollTimeoutMs: number;
	/** How soon after a send or an interrupt from the board the statuses are read once more. */
	statusAfterActionMs: number;
	/** How often an open 終端分頁's screen is read. */
	screenMs: number;
	/** Where the 資源 tab reads the host's processes, memory and mounts: `/proc`, or a folder laid out like it in tests. */
	procRoot: string;
	/** For tests: a JSON file of each mount's `statfs` numbers (`{ "/": { "bsize": …, "blocks": …, "bfree": …, "bavail": … } }`)
	 *  the 資源 tab reads instead of the disks themselves (`LAT_BOARD_STATFS_FILE`); null reads the disks. */
	statfsFile: string | null;
	/** The current time in milliseconds. Read state, archiving and the 終端分頁's recovery bookkeeping use this, never `Date.now()`. */
	now(): number;
}

/** Whether `pane` is the board's own pane. A pane nobody reported (null) is never it, and neither is
 *  a board that does not know its own pane: two unknowns must not count as the same pane. */
export function isOwnPane(config: Pick<BoardConfig, 'ownPane'>, pane: string | null | undefined): boolean {
	return pane != null && config.ownPane !== null && pane === config.ownPane;
}

export interface PasskeySite {
	/** The only page origin a passkey is used from, such as `https://lat.ouob.net`; always https. */
	origin: string;
	/** The domain passkeys are made for: the address's host name, or a domain it belongs to. */
	rpId: string;
}

/** `LAT_BOARD_URL`, the board's https address, and `LAT_BOARD_PASSKEY_RP_ID`, which defaults to its
 *  host name. Throws on an address that is not https (passkeys never go over plain http, not even
 *  to localhost) or an RP ID the host name does not belong to. */
export function passkeySite(env: Env): PasskeySite | null {
	const given = env.LAT_BOARD_URL?.trim();
	if (!given) return null;
	let url: URL;
	try {
		url = new URL(given);
	} catch {
		throw new Error(`LAT_BOARD_URL: "${given}" is not an address`);
	}
	if (url.protocol !== 'https:') throw new Error(`LAT_BOARD_URL: "${given}" is not an https address`);
	const rpId = env.LAT_BOARD_PASSKEY_RP_ID?.trim().toLowerCase() || url.hostname;
	if (url.hostname !== rpId && !url.hostname.endsWith(`.${rpId}`))
		throw new Error(`LAT_BOARD_PASSKEY_RP_ID: "${rpId}" is not ${url.hostname} or a domain it belongs to`);
	return { origin: url.origin, rpId };
}

/** `LAT_BOARD_DEMO_URL` (demo-address.ts). Its logins are handed over from the board, so the
 *  board's own address must be set too, and be another one. */
export function demoSite(env: Env, board: PasskeySite | null): DemoSite | null {
	const demo = demoAddress(env);
	if (!demo) return null;
	if (!board) throw new Error('LAT_BOARD_DEMO_URL needs LAT_BOARD_URL: the demo address sends logins to the board');
	if (demo.origin === board.origin) throw new Error('LAT_BOARD_DEMO_URL must be another address than LAT_BOARD_URL');
	return demo;
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

/** demo.py's data folder: `LAT_BOARD_DEMO_DIR`, else `data` in `~/.agents/demo.json` (demo.py's own
 *  settings), else demo.py's default. A settings file that cannot be read is passed over. */
function demoDataDir(env: Env): string {
	if (env.LAT_BOARD_DEMO_DIR) return env.LAT_BOARD_DEMO_DIR;
	try {
		const data: unknown = JSON.parse(readFileSync(join(homedir(), '.agents/demo.json'), 'utf8')).data;
		if (typeof data === 'string' && data) return data;
	} catch {
		// No settings file, or not JSON: the default below.
	}
	return join(homedir(), '.local/share/demo-publish');
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

/** One turn of the Claude CLI on Haiku that only rewrites text: safe mode leaves out CLAUDE.md,
 *  skills, plugins, hooks and MCP servers; no tools, no MCP servers, no slash commands or skills,
 *  and no session kept. The answer comes as one JSON object (claude-turn.ts). */
const TEXT_ONLY_CLAUDE = [
	'claude',
	'-p',
	'--model',
	'claude-haiku-5-5',
	'--safe-mode',
	'--tools',
	'',
	'--strict-mcp-config',
	'--disable-slash-commands',
	'--no-session-persistence',
	'--output-format',
	'json'
];

function helperCommand(env: Env): string[] {
	const given = commandFrom(env, 'LAT_BOARD_HELPER_COMMAND');
	if (given) return given;
	const latDir = env.LAT_BOARD_LAT_DIR || join(homedir(), '.agents/skills/lat');
	return ['uv', 'run', '--no-project', 'python', join(latDir, 'herdr-panel/lat_panel.py')];
}

/** `hooks/task-proposal-acceptor.py` of the board folder: next to the build the server runs
 *  (`<board>/build/index.js`), whatever folder it was started from; the working folder's own
 *  `hooks/` otherwise (`vite dev`). */
function acceptorScript(): string {
	const script = 'hooks/task-proposal-acceptor.py';
	try {
		// `node build` names the folder, `node build/index.js` the file.
		const entry = resolve(process.argv[1]);
		const besideBuild = join(statSync(entry).isDirectory() ? entry : dirname(entry), '..', script);
		if (existsSync(besideBuild)) return besideBuild;
	} catch {
		// No script path, or one that is gone: the working folder's.
	}
	return resolve(script);
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
	const board = passkeySite(env);
	const proposalsDir = env.LAT_BOARD_PROPOSALS_DIR && isAbsolute(env.LAT_BOARD_PROPOSALS_DIR) ? env.LAT_BOARD_PROPOSALS_DIR : join(stateHome(env), 'lat/task-proposals');
	return {
		stateDir: env.LAT_BOARD_STATE_DIR || join(stateHome(env), 'lat/board'),
		// 須與 `skills/local/lat/scripts/_lat_common.py` 一致
		reportsDir: env.LAT_REPORTS_DIR || join(stateHome(env), 'lat/reports'),
		usageDir: env.LAT_USAGE_DIR || join(stateHome(env), 'lat/usage'),
		userStylePath: join(env.LAT_BOARD_CONFIG_DIR || join(configHome(env), 'lat/board'), 'user.css'),
		helperCommand: helperCommand(env),
		latDir: env.LAT_BOARD_LAT_DIR || join(homedir(), '.agents/skills/lat'),
		trustFiles: {
			claude: join(env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json'),
			codex: join(env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml')
		},
		// A missed change may wait out one read and then need a second one; both must fit in the
		// fallback deadline, and each runs the helper twice in a row (the list, then the answered
		// questions and sent answers), so the helper never gets more than a quarter of it.
		helperTimeoutMs: Math.min(seconds(env.LAT_BOARD_HELPER_TIMEOUT_SECONDS, 15_000), (fallbackMs - READ_SLACK_MS) / 4),
		injectCommand: commandFrom(env, 'LAT_BOARD_INJECT_COMMAND') ?? ['hcom', 'term', 'inject'],
		// The command itself waits up to 2 seconds for the client to show the text before submitting.
		injectTimeoutMs: seconds(env.LAT_BOARD_INJECT_TIMEOUT_SECONDS, 15_000),
		hcomCommand: commandFrom(env, 'LAT_BOARD_HCOM_COMMAND') ?? ['hcom'],
		hcomDir: env.HCOM_DIR || join(homedir(), '.hcom'),
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
		// Next to them too; `skills/local/task-proposal/scripts/task-proposal.py` works both out the same way.
		proposalsDir,
		// Inside the folder, which only the board's account can enter.
		proposalSocket: env.LAT_BOARD_PROPOSAL_SOCKET && isAbsolute(env.LAT_BOARD_PROPOSAL_SOCKET) ? env.LAT_BOARD_PROPOSAL_SOCKET : join(proposalsDir, 'board.sock'),
		proposalAcceptorCommand: commandFrom(env, 'LAT_BOARD_PROPOSAL_ACCEPTOR_COMMAND') ?? ['uv', 'run', '--no-project', 'python', acceptorScript()],
		askExecutionWaitMs: seconds(env.LAT_BOARD_ASK_EXECUTION_WAIT_SECONDS, ASK_EXECUTION_WAIT_MS),
		// A Codex agent runs one short turn to reconnect.
		unpauseWaitMs: seconds(env.LAT_BOARD_UNPAUSE_WAIT_SECONDS, 60_000),
		fallbackMs,
		debounceMs: 200,
		loginLockMs: seconds(env.LAT_BOARD_LOGIN_LOCK_SECONDS, 60_000),
		...connectionSettings(env),
		passkeySite: board,
		demoSite: demoSite(env, board),
		asrUrl: env.LAT_BOARD_ASR_URL?.replace(/\/+$/, '') || null,
		asrToken: env.LAT_BOARD_ASR_TOKEN || null,
		asrTimeoutMs: seconds(env.LAT_BOARD_ASR_TIMEOUT_SECONDS, 60_000),
		uploadDir: env.LAT_BOARD_UPLOAD_DIR || '/tmp/lat-board-uploads',
		demoSiteDir: join(demoDataDir(env), 'site'),
		demoRequestsDir: join(demoDataDir(env), 'share-requests'),
		uploadMaxBytes: (Number(env.LAT_BOARD_UPLOAD_MAX_MB) > 0 ? Number(env.LAT_BOARD_UPLOAD_MAX_MB) : 250) * 1024 * 1024,
		tidyCommand: commandFrom(env, 'LAT_BOARD_TIDY_COMMAND') ?? [...TEXT_ONLY_CODEX],
		tidyTimeoutMs: seconds(env.LAT_BOARD_TIDY_TIMEOUT_SECONDS, 30_000),
		translateCommand: commandFrom(env, 'LAT_BOARD_TRANSLATE_COMMAND') ?? [...TEXT_ONLY_CODEX],
		translateTimeoutMs: seconds(env.LAT_BOARD_TRANSLATE_TIMEOUT_SECONDS, 60_000),
		haikuCommand: commandFrom(env, 'LAT_BOARD_HAIKU_COMMAND') ?? [...TEXT_ONLY_CLAUDE],
		skillsCommand: commandFrom(env, 'LAT_BOARD_SKILLS_COMMAND') ?? ['codex', 'app-server'],
		skillsTimeoutMs: seconds(env.LAT_BOARD_SKILLS_TIMEOUT_SECONDS, 15_000),
		translateConcurrency: Math.max(1, Math.floor(Number(env.LAT_BOARD_TRANSLATE_CONCURRENCY)) || 3),
		// Days: read as seconds, then a second becomes a day.
		translateKeepMs: seconds(env.LAT_BOARD_TRANSLATE_KEEP_DAYS, 30_000) * DAY_SECONDS,
		cswapCommand: commandFrom(env, 'LAT_BOARD_CSWAP_COMMAND') ?? ['cswap'],
		cswapTimeoutMs: seconds(env.LAT_BOARD_CSWAP_TIMEOUT_SECONDS, 10_000),
		cpa: { url: env.LAT_BOARD_CPA_URL?.trim() || null, keyFile: env.LAT_BOARD_CPA_MANAGEMENT_KEY_FILE?.trim() || null },
		quotaIntervalMs: seconds(env.LAT_BOARD_QUOTA_SECONDS, 30_000),
		pdCommand: commandFrom(env, 'LAT_BOARD_PD_COMMAND') ?? ['pd'],
		pdTimeoutMs: seconds(env.LAT_BOARD_PD_TIMEOUT_SECONDS, 5_000),
		pdIntervalMs: seconds(env.LAT_BOARD_PD_SECONDS, 5_000),
		automationTickMs: seconds(env.LAT_BOARD_AUTOMATION_TICK_SECONDS, 60_000),
		automationAgentPollMs: seconds(env.LAT_BOARD_AUTOMATION_AGENT_POLL_SECONDS, 10_000),
		automationLaunchRetryWaitsMs: env.LAT_BOARD_AUTOMATION_LAUNCH_RETRY_WAITS_SECONDS ? env.LAT_BOARD_AUTOMATION_LAUNCH_RETRY_WAITS_SECONDS.split(',').map((value) => seconds(value, 0)) : null,
		pushTestOrigin: env.LAT_BOARD_PUSH_TEST_ORIGIN?.trim() || null,
		statusPollMs: seconds(env.LAT_BOARD_STATUS_POLL_SECONDS, 2_000),
		statusWorkingPollMs: seconds(env.LAT_BOARD_STATUS_WORKING_POLL_SECONDS, 2_000),
		statusPollTimeoutMs: seconds(env.LAT_BOARD_STATUS_POLL_TIMEOUT_SECONDS, 4_000),
		statusAfterActionMs: seconds(env.LAT_BOARD_STATUS_AFTER_ACTION_SECONDS, 2_000),
		screenMs: seconds(env.LAT_BOARD_SCREEN_SECONDS, 100),
		procRoot: env.LAT_BOARD_PROC_ROOT || '/proc',
		statfsFile: env.LAT_BOARD_STATFS_FILE || null,
		now: clock(env)
	};
}
