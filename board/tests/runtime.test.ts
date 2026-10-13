// The host commands on a host with only one of the two runtimes: a PATH that holds that runtime
// and nothing else. Runs the real `pair` and `start` commands (the other command, `build`, is
// covered by running the whole suite this way, see the README).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PORT_BASE, sleep } from './harness.ts';

const ROOT = join(import.meta.dir, '..');
const nodeBinary = Bun.which('node');

// Node 22 before 22.18 runs TypeScript only with the flag; later versions accept it as well.
const hosts = [
	{ name: 'Bun', binary: process.execPath, cmd: 'bun', args: [], offset: 16 },
	{ name: 'Node', binary: nodeBinary, cmd: 'node', args: ['--experimental-strip-types'], offset: 17 }
];

for (const host of hosts) {
	describe.skipIf(!host.binary)(`a host with only ${host.name}`, () => {
		let dir: string;
		let env: Record<string, string>;
		let run: string;
		let server: ChildProcess | undefined;

		beforeAll(() => {
			dir = mkdtempSync(join(tmpdir(), 'lat-board-runtime-'));
			const bin = join(dir, 'bin');
			mkdirSync(bin);
			run = join(bin, host.cmd);
			symlinkSync(host.binary!, run);
			env = {
				PATH: bin,
				HOME: join(dir, 'home'),
				LAT_BOARD_STATE_DIR: join(dir, 'board-state'),
				LAT_BOARD_CONFIG_DIR: join(dir, 'board-config'),
				LAT_REPORTS_DIR: join(dir, 'reports'),
				HERDR_PLUGIN_CONFIG_DIR: join(dir, 'herdr-config'),
				HERDR_PLUGIN_STATE_DIR: join(dir, 'herdr-state')
			};
		});
		afterAll(async () => {
			// SIGTERM, so the command passes it on to the server it started; SIGKILL would leave that running.
			if (server && server.exitCode === null) {
				const exited = new Promise((resolve) => server!.once('exit', resolve));
				server.kill('SIGTERM');
				await exited;
			}
			rmSync(dir, { recursive: true, force: true });
		});

		const command = (...args: string[]) => [...host.args, join(ROOT, 'src/cli.ts'), ...args];

		test('pair prints a code', () => {
			const other = host.cmd === 'bun' ? 'node' : 'bun';
			expect(Bun.which(other, { PATH: env.PATH })).toBeNull();

			const result = spawnSync(run, command('pair'), { env, encoding: 'utf8' });

			expect(result.stdout).toMatch(/配對碼：\S{4}-\S{4}/);
		});

		test('start serves the board', async () => {
			const port = PORT_BASE + host.offset;
			server = spawn(run, command('start', '--host', '127.0.0.1', '--port', String(port)), {
				env,
				stdio: ['ignore', 'pipe', 'pipe']
			});
			let output = '';
			server.stderr!.on('data', (chunk) => (output += chunk));

			const deadline = Date.now() + 10_000;
			for (;;) {
				try {
					const page = await fetch(`http://127.0.0.1:${port}/pair`);
					expect(page.status).toBe(200);
					return;
				} catch (error) {
					if (server.exitCode !== null) throw new Error(`start exited with ${server.exitCode}: ${output}`);
					if (Date.now() > deadline) throw error;
					await sleep(50);
				}
			}
		});
	});
}

test('pair also works through `bun run board` with no node on the PATH', () => {
	const dir = mkdtempSync(join(tmpdir(), 'lat-board-runtime-'));
	try {
		mkdirSync(join(dir, 'bin'));
		symlinkSync(process.execPath, join(dir, 'bin/bun'));
		const env = { PATH: join(dir, 'bin'), HOME: dir, LAT_BOARD_STATE_DIR: join(dir, 'state') };

		const result = spawnSync(join(dir, 'bin/bun'), ['run', 'board', 'pair'], { cwd: ROOT, env, encoding: 'utf8' });

		expect(result.stdout).toMatch(/配對碼：\S{4}-\S{4}/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
