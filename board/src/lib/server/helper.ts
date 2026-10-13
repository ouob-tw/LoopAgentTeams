// The only way the board reads question files: the LAT panel helper's `board` commands.
import { execFile } from 'node:child_process';
import type { HelperController } from '../board/types.ts';
import type { BoardConfig } from './config.ts';

export type HelperList =
	| { ok: true; controllers: HelperController[] }
	| { ok: false; reason: string };

function run(config: BoardConfig, args: string[]): Promise<{ stdout: string; failure: string | null }> {
	const [command, ...prefix] = config.helperCommand;
	return new Promise((resolve) => {
		execFile(
			command,
			[...prefix, 'board', ...args],
			{ timeout: config.helperTimeoutMs, maxBuffer: 64 * 1024 * 1024 },
			(error, stdout, stderr) => {
				let failure: string | null = null;
				if (error) {
					// Exceeding the output limit also kills the helper, so `killed` alone is not a timeout.
					const timedOut = error.killed && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
					failure = timedOut
						? `輔助工具逾時（${config.helperTimeoutMs / 1000} 秒）`
						: stderr.trim().split('\n').at(-1) || error.message;
				}
				resolve({ stdout, failure });
			}
		);
	});
}

function isController(value: unknown): value is HelperController {
	const item = value as HelperController;
	return (
		typeof item === 'object' &&
		item !== null &&
		typeof item.session_id === 'string' &&
		typeof item.hcom_name === 'string' &&
		typeof item.workspace === 'string' &&
		typeof item.questions_path === 'string' &&
		Array.isArray(item.questions) &&
		item.questions.every((question) => typeof question === 'object' && question !== null)
	);
}

export async function listControllers(config: BoardConfig): Promise<HelperList> {
	const { stdout, failure } = await run(config, ['list']);
	let payload: { controllers?: unknown; reason?: unknown };
	try {
		payload = JSON.parse(stdout);
	} catch {
		return { ok: false, reason: failure ?? '輔助工具的輸出不是 JSON' };
	}
	// The helper prints one JSON object even when it fails; its reason is the useful one.
	const reason = typeof payload?.reason === 'string' ? payload.reason : failure;
	if (failure || !Array.isArray(payload?.controllers) || !payload.controllers.every(isController)) {
		return { ok: false, reason: reason ?? '輔助工具的輸出缺少主控清單' };
	}
	return { ok: true, controllers: payload.controllers };
}
