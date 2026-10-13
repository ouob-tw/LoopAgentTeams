// Board settings, read from the environment. No SvelteKit imports: the host command uses this too.
import { readFileSync } from 'node:fs';
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
	/** The current time in milliseconds. Read state and archiving use this, never `Date.now()`. */
	now(): number;
}

const MAX_FALLBACK_MS = 60_000;
/** Below this there is no room left for the helper to run twice. */
const MIN_FALLBACK_MS = 5_000;
/** Allowed for reading the report files and pushing the snapshot once the helper has answered. */
export const READ_SLACK_MS = 1_000;

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
		reportsDir: env.LAT_REPORTS_DIR || join(stateHome(env), 'lat/reports'),
		helperCommand: helperCommand(env),
		// A missed change may wait out one read and then need a second one; both must fit in the
		// fallback deadline, so the helper never gets more than half of it.
		helperTimeoutMs: Math.min(seconds(env.LAT_BOARD_HELPER_TIMEOUT_SECONDS, 15_000), (fallbackMs - READ_SLACK_MS) / 2),
		fallbackMs,
		debounceMs: 200,
		pairingTtlMs: seconds(env.LAT_BOARD_PAIRING_TTL_SECONDS, 300_000),
		now: clock(env)
	};
}
