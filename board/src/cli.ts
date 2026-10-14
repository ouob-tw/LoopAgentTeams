// Host commands for the board: start the built server, set the login password, list and revoke
// logged-in devices. Runs under Bun, or under Node 22.18+ (22.17 with --experimental-strip-types).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/server/config.ts';
import { listDevices, revokeDevice } from './lib/server/devices.ts';
import { hasPassword, setPassword } from './lib/server/password.ts';

const USAGE = `用法：
  start [--host <位址>] [--port <連接埠>]   啟動看板（需先 build）
  password                                  設定或變更登入密碼（輸入兩次）
  devices                                   列出已登入的裝置
  revoke <裝置 ID>                          撤銷一台裝置`;

const DEFAULT_PORT = '7100';

/** What runs the built server: Node when the host has it (the way it has always run), the runtime
 *  running this command otherwise, which is Bun on a host without Node. */
function serverRuntime(): string {
	return 'Bun' in globalThis ? (Bun.which('node') ?? process.execPath) : process.execPath;
}

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

/** Read the passwords to set: typed without echo on a terminal, otherwise one per line of input. */
function passwordReader(): (prompt: string) => Promise<string> {
	const stdin = process.stdin;
	if (stdin.isTTY) {
		return (prompt) =>
			new Promise((resolve, reject) => {
				process.stderr.write(prompt);
				let typed = '';
				stdin.setRawMode(true);
				stdin.resume();
				stdin.setEncoding('utf8');
				const finish = (error?: Error) => {
					stdin.off('data', onData);
					stdin.setRawMode(false);
					stdin.pause();
					process.stderr.write('\n');
					if (error) reject(error);
					else resolve(typed);
				};
				const onData = (chunk: string) => {
					for (const char of chunk) {
						if (char === '\r' || char === '\n') return finish();
						if (char === '\u0003') return finish(new Error('已取消，密碼沒有變更。'));
						if (char === '\u007f' || char === '\b') typed = [...typed].slice(0, -1).join('');
						else if (char >= ' ') typed += char;
					}
				};
				stdin.on('data', onData);
			});
	}
	let lines: Promise<string[]> | undefined;
	let next = 0;
	return async () => {
		lines ??= (async () => {
			let text = '';
			for await (const chunk of stdin) text += chunk;
			return text.split(/\r?\n/);
		})();
		return (await lines)[next++] ?? '';
	};
}

async function main(argv: string[]): Promise<number> {
	const [command, ...args] = argv;
	const config = loadConfig();

	if (command === 'start') {
		const entry = fileURLToPath(new URL('../build/index.js', import.meta.url));
		if (!existsSync(entry)) {
			console.error('找不到 build/，請先在 board 目錄執行 build。');
			return 1;
		}
		const env = {
			...process.env,
			HOST: option(args, '--host') ?? process.env.HOST ?? '0.0.0.0',
			PORT: option(args, '--port') ?? process.env.PORT ?? DEFAULT_PORT
		};
		console.log(`LAT 看板啟動於 http://${env.HOST}:${env.PORT}（只應在內網或私人網路使用）`);
		const server = spawn(serverRuntime(), [entry], { env, stdio: 'inherit' });
		for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.kill(signal));
		server.on('exit', (code) => process.exit(code ?? 1));
		return 0;
	}

	if (command === 'password') {
		let changing = true;
		try {
			changing = hasPassword(config.stateDir);
		} catch (error) {
			// A damaged password file is replaced; this command is the way to repair it.
			console.error(`現有的密碼檔讀不出來（${(error as Error).message}），這次設定會取代它。`);
		}
		const read = passwordReader();
		const first = await read(changing ? '新密碼：' : '密碼：');
		if (!first) {
			console.error('密碼不能是空的，密碼沒有變更。');
			return 1;
		}
		if ((await read('再輸入一次：')) !== first) {
			console.error('兩次輸入不一致，密碼沒有變更。');
			return 1;
		}
		setPassword(config.stateDir, first);
		console.log(
			changing
				? '已變更密碼，舊密碼不能再登入。已登入的裝置維持登入；要讓某台登出，用 devices 查 ID 再 revoke。'
				: '已設定密碼。在瀏覽器打開看板、輸入密碼即可登入。'
		);
		return 0;
	}

	if (command === 'devices') {
		const devices = listDevices(config.stateDir);
		if (!devices.length) console.log('沒有已登入的裝置。');
		for (const device of devices) console.log(`${device.id}\t${device.pairedAt}\t${device.label}`);
		return 0;
	}

	if (command === 'revoke' && args[0]) {
		if (!revokeDevice(config.stateDir, args[0])) {
			console.error(`找不到裝置 ${args[0]}。`);
			return 1;
		}
		console.log(`已撤銷裝置 ${args[0]}。`);
		return 0;
	}

	console.error(USAGE);
	return 2;
}

try {
	process.exitCode = await main(process.argv.slice(2));
} catch (error) {
	console.error(`看板指令失敗：${(error as Error).message}`);
	process.exitCode = 1;
}
