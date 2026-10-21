// Restarting afresh, for a model switch, a client that has had no turn yet (see the top of
// `switch.ts`): one hcom launch with the arguments hcom started it with and the new settings, then
// a wait for it to run in Herdr, its tab named and placed like the old one, and the switch ended.
// The wait runs in the background of the request that launched it; a relaunch no board process
// waits for (the board restarted meanwhile) is settled by the board's reads.
import { isLaunchClient } from '../board/launch.ts';
import { modelArgs, type SwitchResponse, type SwitchView } from '../board/models.ts';
import type { Board } from './board.ts';
import { runningIn, waitToAppear } from './appear.ts';
import { launchAgent, listAgents } from './hcom.ts';
import { chooseWorkspace, listHerdrAgents, moveTab, renameTab, type HerdrAgent } from './herdr.ts';
import { queued } from './send.ts';
import { currentSwitch, respondLogged, step, type Result, type SwitchTarget } from './switch.ts';

/** Relaunches whose client is being waited for by this board process. One the board does not
 *  wait for (it restarted meanwhile) is settled by its reads (`settleRelaunches`). */
const following = new Set<string>();

/**
 * Where a relaunch stands by hcom's and Herdr's lists now: its client runs; it may still come
 * (`waiting`, within the launch wait); or it failed, and why. A switch given up or over is `over`.
 */
async function relaunchStanding(board: Board, view: SwitchView): Promise<{ runs: HerdrAgent } | 'waiting' | 'over' | { failed: string }> {
	const { config } = board;
	if (view.state !== 'resuming' && view.state !== 'resume-failed') return 'over';
	const name = view.relaunchedName;
	if (name) {
		const [hcom, herdr] = await Promise.all([listAgents(config), listHerdrAgents(config)]);
		const found = hcom.ok && herdr.ok ? runningIn({ name }, hcom.agents, herdr.agents).herdr : undefined;
		if (found) return { runs: found };
	}
	if (view.state === 'resume-failed') return { failed: view.error ?? '重新啟動失敗' };
	const since = Date.parse(view.appliedAt ?? view.resumingAt ?? view.time);
	if (config.now() < since + config.launchWaitMs) return 'waiting';
	return {
		failed: name
			? `重新啟動後等了 ${Math.round(config.launchWaitMs / 1000)} 秒，Herdr 的清單上還沒有 @${name}`
			: '重新啟動的結果不明（看板在啟動途中停過），請到 Herdr 查看'
	};
}

/**
 * Start afresh a stopped client that had no saved conversation (see the top of this file): one
 * hcom launch, then, in the background, wait for it to run in Herdr, name and place its tab like
 * the old one, and end the switch. One whose earlier launch still may come, or runs by now, is not
 * launched again.
 */
export async function relaunchSwitch(board: Board, controller: SwitchTarget, view: SwitchView): Promise<Result<SwitchResponse>> {
	const { config } = board;
	const relaunch = view.relaunch!;
	const standing = await relaunchStanding(board, view);
	if (standing === 'waiting' || following.has(view.id)) {
		const what = view.relaunchedName ? `已經重新啟動為 @${view.relaunchedName}` : '正在重新啟動';
		return respondLogged(board, view.id, { reason: `${what}，正在等它出現，請稍後再看`, status: 409 }, null);
	}
	if (typeof standing === 'object' && 'runs' in standing) {
		const logError = await finishRelaunch(board, view, standing.runs);
		return respondLogged(board, view.id, { reason: logError && `寫不進送出紀錄：${logError}`, status: 500 }, logError);
	}
	if (view.state === 'resuming' && typeof standing === 'object') step(board, view.id, { state: 'resume-failed', error: standing.failed });
	const fail = (error: string, status = 502) => respondLogged(board, view.id, { reason: error, status }, step(board, view.id, { state: 'resume-failed', error }));
	if (!isLaunchClient(controller.client)) return fail(`看板不會重新啟動 ${controller.client || '這個 client'}。`, 409);
	const workspace = await chooseWorkspace(config, controller.workspace, view.agent?.workspace);
	if (!workspace.ok) return fail(`沒有重新啟動：${workspace.reason}`);
	// In the log before hcom runs, with no name yet: a board stopped meanwhile waits out the launch
	// wait before it launches again.
	const logError = step(board, view.id, { state: 'resuming', error: null, relaunchedName: '' });
	if (logError) return respondLogged(board, view.id, { reason: `寫不進送出紀錄，沒有重新啟動：${logError}`, status: 500 }, logError);
	following.add(view.id);
	const launched = await launchAgent(config, {
		client: controller.client,
		folder: controller.workspace,
		herdrWorkspace: workspace.id,
		prompt: '',
		// Later arguments win over the ones hcom kept, the way a resume's do.
		extraArgs: [...relaunch.args, ...modelArgs(controller.client, view.to)]
	});
	if (launched.outcome === 'failed' || !launched.hcomName) {
		following.delete(view.id);
		return fail(launched.outcome === 'failed' ? (launched.reason ?? '重新啟動失敗') : '重新啟動後沒有拿到它的 HCOM 名稱，看板認不出是哪一個，請到 Herdr 查看');
	}
	const named = step(board, view.id, { relaunchedName: launched.hcomName });
	void followRelaunch(board, view.id, view.controllerId, launched.hcomName);
	return respondLogged(board, view.id, { reason: null }, named);
}

/** Wait for a relaunched client to run, then end the switch (`finishRelaunch`), or record why it
 *  did not run. Only while the switch still waits for this client: a switch given up meanwhile
 *  stays given up. */
async function followRelaunch(board: Board, switchId: string, controllerId: string, name: string): Promise<void> {
	const { config } = board;
	let appeared: Awaited<ReturnType<typeof waitToAppear>>;
	try {
		appeared = await waitToAppear(config, { name }, config.now() + config.launchWaitMs, `@${name}`);
	} catch (error) {
		appeared = { found: null, reason: `確認不了它有沒有在執行：${(error as Error).message}` };
	}
	await queued(controllerId, async () => {
		following.delete(switchId);
		const view = currentSwitch(board, switchId);
		if (view?.state !== 'resuming' || view.relaunchedName !== name) return;
		if (appeared.found) await finishRelaunch(board, view, appeared.found);
		else step(board, switchId, { state: 'resume-failed', error: `重新啟動的 ${appeared.reason}` });
	});
	await board.refresh();
	board.agentActed(controllerId);
}

/** End a relaunch whose client runs: give its tab the old label and place (a failure is noted)
 *  and mark the switch done. Returns why the log could not be written, or null. */
async function finishRelaunch(board: Board, view: SwitchView, found: HerdrAgent): Promise<string | null> {
	const { config } = board;
	const relaunch = view.relaunch!;
	const problems: string[] = [];
	if (relaunch.tabLabel) {
		const renamed = await renameTab(config, found.tab, relaunch.tabLabel);
		if (!renamed.ok) problems.push(`改分頁名稱失敗：${renamed.reason}`);
	}
	const moved = await moveTab(config, found.tab, relaunch.tabIndex ?? 0);
	if (moved) problems.push(moved);
	return step(board, view.id, {
		state: 'done',
		error: problems.length ? `已重新啟動為 @${view.relaunchedName}，但${problems.join('；')}` : null
	});
}

/** Settle the relaunches this board process does not wait for (it restarted while one was on its
 *  way): done once the client runs, failed once the launch wait is over. Queued per session like
 *  every other step of a switch. */
export function settleRelaunches(board: Board, switches: SwitchView[]): void {
	for (const open of switches) {
		if (!open.relaunch || open.state !== 'resuming' || following.has(open.id)) continue;
		void queued(open.controllerId, async () => {
			const view = currentSwitch(board, open.id);
			if (!view || view.state !== 'resuming' || following.has(view.id)) return;
			const standing = await relaunchStanding(board, view);
			if (typeof standing !== 'object') return;
			if ('runs' in standing) await finishRelaunch(board, view, standing.runs);
			else step(board, view.id, { state: 'resume-failed', error: standing.failed });
			board.agentActed(view.controllerId);
		});
	}
}
