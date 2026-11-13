// Host commands for the board: start the built server, set the login password, list and revoke
// logged-in devices, print what the inbox holds. Runs under Bun, or under Node 22.18+ (22.17 with --experimental-strip-types).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/server/config.ts';
import {
	expired,
	issueTestLogin,
	listDevices,
	revokeDevice,
	TEST_LOGIN_DEFAULT_HOURS,
	TEST_LOGIN_MAX_HOURS,
	type ListedDevice
} from './lib/server/devices.ts';
import { listHerdrAgents } from './lib/server/herdr.ts';
import type { BoardConfig } from './lib/server/config.ts';
import { formatInboxStatus, readInboxStatus } from './lib/server/inbox-status.ts';
import { hasPassword, setPassword } from './lib/server/password.ts';

const USAGE = `用法：
  start [--host <位址>] [--port <連接埠>]   啟動看板（需先 build）
  password                                  設定或變更登入密碼（輸入兩次）
  devices                                   列出已登入的裝置（含測試裝置）
  revoke <裝置 ID>                          撤銷一台裝置
  test-login [--hours <時數>] [--label <名稱>] [--url <看板網址>]
                                            發一組測試用登入，印出只能用一次的登入網址
                                            （預設 4 小時、上限 24 小時）
  inbox                                     列出待辦與已處理的現況（只讀，不需登入）`;

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

/** A test device's column in `devices`: its label, when it ends, and whether it is used or over. */
function testColumn(device: ListedDevice, now: number): string {
	const test = device.test!;
	const state = expired(device, now) ? '（已到期）' : device.unused ? '（網址尚未使用）' : '';
	return `測試裝置「${test.label}」到期 ${test.expiresAt}${state}`;
}

/** The agents a test device started that Herdr still runs, one line each, for the host to decide
 *  whether to close them; the board never closes them itself. */
async function runningOwned(config: BoardConfig, device: ListedDevice): Promise<string[]> {
	const owned = device.test?.owned ?? [];
	if (!owned.length) return [];
	const listed = await listHerdrAgents(config);
	if (!listed.ok) return [`  讀不到 Herdr 的清單，無法確認它建立的 ${owned.length} 個 Agent 是否還在執行：${listed.reason}`];
	const running = listed.agents.filter((agent) => agent.sessionId !== null && owned.includes(agent.sessionId));
	if (!running.length) return [];
	return [
		`  它建立的 Agent 仍在執行 ${running.length} 個，看板不會自動關閉，請自行決定是否關閉：`,
		...running.map((agent) => `  ${agent.sessionId}\t${agent.client}\t${agent.workspaceLabel ?? agent.workspace}／${agent.tabPlace?.label ?? agent.title ?? agent.tab}\t${agent.cwd}`)
	];
}

async function main(argv: string[]): Promise<number> {
	const [command, ...args] = argv;
	const config = loadConfig();

	if (command === 'start') {
		// LAT_BOARD_BUILD_DIR names another build, relative to the board directory (the tests run `build-test/`).
		const build = process.env.LAT_BOARD_BUILD_DIR ?? 'build';
		const entry = join(fileURLToPath(new URL('..', import.meta.url)), build, 'index.js');
		if (!existsSync(entry)) {
			console.error(`找不到 ${build}/，請先在 board 目錄執行 build。`);
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
		const now = config.now();
		if (!devices.length) console.log('沒有已登入的裝置。');
		for (const device of devices) {
			const state = device.test ? [testColumn(device, now)] : expired(device, now) ? ['（登入已失效，須重新登入）'] : [];
			console.log([device.id, device.pairedAt, device.label, ...state].join('\t'));
			if (device.test && expired(device, now)) for (const line of await runningOwned(config, device)) console.log(line);
		}
		return 0;
	}

	if (command === 'revoke' && args[0]) {
		const device = listDevices(config.stateDir).find((candidate) => candidate.id === args[0]);
		if (!device || !revokeDevice(config.stateDir, args[0])) {
			console.error(`找不到裝置 ${args[0]}。`);
			return 1;
		}
		console.log(`已撤銷裝置 ${args[0]}。`);
		for (const line of await runningOwned(config, device)) console.log(line);
		return 0;
	}

	if (command === 'test-login') {
		const hours = Number(option(args, '--hours') ?? TEST_LOGIN_DEFAULT_HOURS);
		if (!(hours > 0 && hours <= TEST_LOGIN_MAX_HOURS)) {
			console.error(`--hours 要大於 0、最多 ${TEST_LOGIN_MAX_HOURS}。`);
			return 2;
		}
		const label = (option(args, '--label') ?? '').trim() || '測試';
		const base = (option(args, '--url') ?? `http://${hostname()}:${process.env.PORT ?? DEFAULT_PORT}`).replace(/\/+$/, '');
		const issued = issueTestLogin(config.stateDir, { label, hours, now: config.now() });
		console.log(`已發出測試登入「${label}」（裝置 ${issued.id}），到期 ${issued.expiresAt}。`);
		console.log('用瀏覽器打開下面的網址登入；網址只能用一次，到期後自動登出。');
		console.log(`${base}/login/test#${issued.code}`);
		console.log(`提早收回：bun run board revoke ${issued.id}`);
		return 0;
	}

	if (command === 'inbox') {
		const status = await readInboxStatus(config);
		console.log(formatInboxStatus(status));
		return status.problems.length ? 1 : 0;
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
