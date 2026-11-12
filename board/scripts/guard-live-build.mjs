// Refuses a build over the build/ the active lat-board service serves; builds nothing. LAT_BOARD_LIVE_DIR
// replaces the systemctl lookup (tests; empty = no service); LAT_BOARD_ALLOW_LIVE_BUILD=1 overrides.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

function liveDir() {
	if (process.env.LAT_BOARD_LIVE_DIR !== undefined) return process.env.LAT_BOARD_LIVE_DIR;
	const r = spawnSync('systemctl', ['--user', 'show', 'lat-board', '-p', 'ActiveState', '-p', 'WorkingDirectory'], { encoding: 'utf8' });
	const v = Object.fromEntries((r.status === 0 ? r.stdout : '').split('\n').map((l) => l.split(/=(.*)/s)));
	return v.ActiveState === 'active' ? (v.WorkingDirectory ?? '') : '';
}

const real = (/** @type {string} */ p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const live = liveDir();
const out = real(resolve(real('.'), process.env.LAT_BOARD_BUILD_DIR ?? 'build'));
if (live && !process.env.LAT_BOARD_ALLOW_LIVE_BUILD && out === real(resolve(live, 'build'))) {
	console.error('Refusing to build over the live lat-board build/ (it would break the page on port 7100 until restart). Use `bun run build:test` or `bash scripts/deploy.sh`, or set LAT_BOARD_ALLOW_LIVE_BUILD=1 to build here on purpose.');
	process.exit(1);
}
