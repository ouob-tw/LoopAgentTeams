// Host commands for the board: start the built server, hand out pairing codes, list and revoke
// paired devices. Runs under Bun, or under Node 22.18+ (which runs TypeScript directly).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/server/config.ts';
import { createPairingCode, listDevices, revokeDevice } from './lib/server/devices.ts';

const USAGE = `用法：
  start [--host <位址>] [--port <連接埠>]   啟動看板（需先 build）
  pair                                      產生一組配對碼（一次有效）
  devices                                   列出已配對的裝置
  revoke <裝置 ID>                          撤銷一台裝置`;

const DEFAULT_PORT = '7100';

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

function main(argv: string[]): number {
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
		const server = spawn('node', [entry], { env, stdio: 'inherit' });
		for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.kill(signal));
		server.on('exit', (code) => process.exit(code ?? 1));
		return 0;
	}

	if (command === 'pair') {
		const { code, expiresAt } = createPairingCode(config.stateDir, config.pairingTtlMs);
		const minutes = Math.round(config.pairingTtlMs / 60_000);
		console.log(`配對碼：${code.slice(0, 4)}-${code.slice(4)}`);
		console.log(
			`只能用一次，${minutes >= 1 ? `${minutes} 分鐘` : `${config.pairingTtlMs / 1000} 秒`}內有效（到 ${new Date(expiresAt).toLocaleTimeString('zh-TW', { hour12: false })}）。`
		);
		return 0;
	}

	if (command === 'devices') {
		const devices = listDevices(config.stateDir);
		if (!devices.length) console.log('沒有已配對的裝置。');
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
	process.exitCode = main(process.argv.slice(2));
} catch (error) {
	console.error(`看板指令失敗：${(error as Error).message}`);
	process.exitCode = 1;
}
