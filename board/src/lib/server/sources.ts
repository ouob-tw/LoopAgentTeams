// Where the panel helper keeps the binding registry and the pending notifications. The board
// reads neither file; it only needs to know which directories to watch.
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BoardConfig } from './config.ts';
import { runCommand } from './external.ts';

/** Mirrors the helper's own lookup order for its config and state directories. Herdr is asked
 *  through the configured command, so tests put a fake in its place. */
// 須與 `skills/local/lat/scripts/_lat_common.py` 一致
export async function helperDirectories(config: BoardConfig): Promise<{ config: string; state: string }> {
	const env = process.env;
	let configDir = env.HERDR_PLUGIN_CONFIG_DIR;
	if (!configDir) {
		const run = await runCommand(config.herdrCommand, ['plugin', 'config-dir', 'lat.panel'], { timeoutMs: config.herdrTimeoutMs });
		// Herdr is not installed or not running when it fails; fall through to the XDG location.
		if (run.failure === null) configDir = run.stdout.trim();
	}
	configDir ||= join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'herdr/plugins/config/lat.panel');
	const state =
		env.HERDR_PLUGIN_STATE_DIR ||
		join(env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'herdr/plugins/lat.panel');
	return { config: configDir, state };
}
