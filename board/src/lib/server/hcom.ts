// Starting agents through hcom, in a Herdr tab of a workspace the board picks.
import type { LaunchClient, LaunchOutcome } from '../board/launch.ts';
import type { BoardConfig } from './config.ts';
import { runExternal, type ExternalResult } from './external.ts';

export interface LaunchResult {
	outcome: LaunchOutcome;
	hcomName: string | null;
	/** Why it failed, or what is not known about a launch that did not report ready. */
	reason: string | null;
}

/** The one agent name the launch output's `Names:` line gives, or null. */
export function launchedName(stdout: string): string | null {
	const names = /^Names:[ \t]*(.*)$/m.exec(stdout)?.[1].split(/[\s,]+/).filter(Boolean) ?? [];
	return names.length === 1 ? names[0] : null;
}

/** The environment hcom runs in: Herdr's tab opens in this workspace (the board itself is in none),
 *  and no group tag, so the name hcom prints is the agent's whole name. */
export function hcomEnv(herdrWorkspace: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, HERDR_WORKSPACE_ID: herdrWorkspace };
	delete env.HCOM_TAG;
	return env;
}

/** What one hcom run that opens a client ended as: ready, still starting (exit 2 or out of time) or failed. */
export function launchResult(run: ExternalResult): LaunchResult {
	const hcomName = launchedName(run.stdout);
	if (run.code === 0) return { outcome: 'started', hcomName, reason: null };
	if (run.code === 2) return { outcome: 'pending', hcomName, reason: 'hcom 回報主控仍在啟動，或在等你到 Herdr 分頁處理' };
	if (run.timedOut) return { outcome: 'pending', hcomName, reason: `hcom 啟動指令${run.failure}，分頁可能已經開了` };
	return { outcome: 'failed', hcomName, reason: `hcom 啟動失敗：${run.failure}` };
}

/** Start one agent of this client in the folder, with this first message, in a new Herdr tab of
 *  the workspace. No model or effort is given: the client's own defaults apply. */
export async function launchAgent(
	config: BoardConfig,
	launch: { client: LaunchClient; folder: string; herdrWorkspace: string; prompt: string }
): Promise<LaunchResult> {
	const args = [launch.client, '--dir', launch.folder, '--terminal', 'herdr', '--go', '--hcom-prompt', launch.prompt];
	const run = await runExternal(config.hcomCommand, args, {
		timeoutMs: config.hcomTimeoutMs,
		env: hcomEnv(launch.herdrWorkspace)
	});
	return launchResult(run);
}
