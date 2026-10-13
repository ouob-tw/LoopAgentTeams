// Board settings, read from the environment. No SvelteKit imports: the host command uses this too.
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

type Env = Record<string, string | undefined>;

export interface BoardConfig {
	/** Where the board keeps its own state (paired devices, pairing codes). */
	stateDir: string;
	/** Where the turn-end hook appends controller report records. */
	reportsDir: string;
	/** Command that runs the LAT panel helper; the board appends `board <command>`. */
	helperCommand: string[];
	helperTimeoutMs: number;
	/** Longest a change the file watch missed may take to be read and pushed to the pages. */
	fallbackMs: number;
	debounceMs: number;
	pairingTtlMs: number;
}

const MAX_FALLBACK_MS = 60_000;

function stateHome(env: Env): string {
	const value = env.XDG_STATE_HOME;
	return value && isAbsolute(value) ? value : join(homedir(), '.local/state');
}

function seconds(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return value && Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : fallback;
}

function helperCommand(env: Env): string[] {
	if (env.LAT_BOARD_HELPER_COMMAND) {
		const parsed: unknown = JSON.parse(env.LAT_BOARD_HELPER_COMMAND);
		if (!Array.isArray(parsed) || !parsed.length || parsed.some((part) => typeof part !== 'string')) {
			throw new Error('LAT_BOARD_HELPER_COMMAND must be a JSON array of strings');
		}
		return parsed;
	}
	const latDir = env.LAT_BOARD_LAT_DIR || join(homedir(), '.agents/skills/lat');
	return ['uv', 'run', '--no-project', 'python', join(latDir, 'herdr-panel/lat_panel.py')];
}

export function loadConfig(env: Env = process.env): BoardConfig {
	return {
		stateDir: env.LAT_BOARD_STATE_DIR || join(stateHome(env), 'lat/board'),
		reportsDir: env.LAT_REPORTS_DIR || join(stateHome(env), 'lat/reports'),
		helperCommand: helperCommand(env),
		helperTimeoutMs: seconds(env.LAT_BOARD_HELPER_TIMEOUT_SECONDS, 15_000),
		fallbackMs: Math.min(seconds(env.LAT_BOARD_FALLBACK_SECONDS, MAX_FALLBACK_MS), MAX_FALLBACK_MS),
		debounceMs: 200,
		pairingTtlMs: seconds(env.LAT_BOARD_PAIRING_TTL_SECONDS, 300_000)
	};
}
