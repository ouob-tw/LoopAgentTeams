// Refuses a plain `bun run build` that would overwrite the build/ the active lat-board service serves.
// Runs before `vite build`; builds nothing itself. LAT_BOARD_LIVE_DIR replaces the systemctl lookup (tests;
// empty = no service). LAT_BOARD_ALLOW_LIVE_BUILD=1 builds there on purpose.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

function liveDir() {
	if (process.env.LAT_BOARD_LIVE_DIR !== undefined) return process.env.LAT_BOARD_LIVE_DIR;
	const r = spawnSync('systemctl', ['--user', 'show', 'lat-board', '-p', 'ActiveState', '-p', 'WorkingDirectory'], { encoding: 'utf8' });
	if (r.status !== 0) return '';
	const v = Object.fromEntries((r.stdout ?? '').split('\n').map((l) => l.split(/=(.*)/s)));
	return v.ActiveState === 'active' ? (v.WorkingDirectory ?? '') : '';
}

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const live = liveDir();
const out = resolve(real('.'), process.env.LAT_BOARD_BUILD_DIR ?? 'build');
if (live && !process.env.LAT_BOARD_ALLOW_LIVE_BUILD && out === resolve(real(live), 'build')) {
	console.error('Refusing to build over the live lat-board build/ (it would break the page on port 7100 until restart). Use `bun run build:test` or `bash scripts/deploy.sh`, or set LAT_BOARD_ALLOW_LIVE_BUILD=1 to build here on purpose.');
	process.exit(1);
}
