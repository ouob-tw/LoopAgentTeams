// Where the panel helper keeps the binding registry and the pending notifications. The board
// reads neither file; it only needs to know which directories to watch.
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

type Env = Record<string, string | undefined>;

/** Mirrors the helper's own lookup order for its config and state directories. */
export function helperDirectories(env: Env = process.env): { config: string; state: string } {
	let config = env.HERDR_PLUGIN_CONFIG_DIR;
	if (!config) {
		try {
			config = execFileSync('herdr', ['plugin', 'config-dir', 'lat.panel'], {
				encoding: 'utf8',
				timeout: 10_000,
				stdio: ['ignore', 'pipe', 'ignore']
			}).trim();
		} catch {
			// Herdr is not installed or not running; fall through to the XDG location.
		}
	}
	config ||= join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'herdr/plugins/config/lat.panel');
	const state =
		env.HERDR_PLUGIN_STATE_DIR ||
		join(env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'herdr/plugins/lat.panel');
	return { config, state };
}
