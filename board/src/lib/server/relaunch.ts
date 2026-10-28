// Restarting afresh, for a model switch, a client that has had no turn yet (see the top of
// `switch.ts`): one hcom launch with the arguments hcom started it with and the new settings, then
// a wait for it to run in Herdr, its tab named and placed like the old one (or kept, when it runs in
// the shell the stop held in that tab), and the switch ended. A Codex permission switch launches
// afresh too, to resume its conversation (`relaunch.session`): it runs once Herdr shows that
// session, which takes the first turn the launch sends.
// The wait runs in the background of the request that launched it; a relaunch no board process
// waits for (the board restarted meanwhile) is settled by the board's reads.
import { isLaunchClient } from '../board/launch.ts';
import { modelArgs, type SwitchResponse, type SwitchView } from '../board/models.ts';
import { codexFirstTurnText } from '../board/permissions.ts';
import type { Board } from './board.ts';
import { runningIn, waitToAppear, type Wanted } from './appear.ts';
import { launchAgent, listAgents } from './hcom.ts';
import { chooseWorkspace, listHerdrAgents, moveTab, renameTab, type HerdrAgent } from './herdr.ts';
import { queued } from './send.ts';
import type { SentLog } from './sent-log.ts';
import { switchView } from './sent-views.ts';
import { currentSwitch, heldPane, respondLogged, step, type Result, type SwitchTarget } from './switch.ts';

/** Relaunches whose client is being waited for by this board process. One the board does not
 *  wait for (it restarted meanwhile) is settled by its reads (`settleRelaunches`). */
const following = new Set<string>();

/** The client a relaunch waits for: the one it launched, and for a session relaunch that session. */
const wantedOf = (view: SwitchView, name: string): Wanted => ({ name, ...(view.relaunch?.session && { sessionId: view.relaunch.session }) });

/** Why a session relaunch's client is not taken to run yet, once the launch wait is over. */
const firstTurnMissing = (board: Board, name: string) =>
	`重新接回後等了 ${Math.round(board.config.launchWaitMs / 1000)} 秒，@${name} 還沒做完第一回合，hcom 還認不出它是原本的對話`;

/** Whether this Herdr agent is the relaunch's client: for a session relaunch, only once Herdr shows the session. */
const isRelaunched = (view: SwitchView, found: HerdrAgent) => !view.relaunch?.session || found.sessionId === view.relaunch.session;

/**
 * Where a relaunch stands by hcom's and Herdr's lists now: its client runs; it may still come
 * (`waiting`, within the launch wait); or it failed, and why, and whether hcom still lists the
 * client it launched (`listed`: a session relaunch whose first turn has not bound it yet). A
 * switch given up or over is `over`.
 */
async function relaunchStanding(board: Board, view: SwitchView): Promise<{ runs: HerdrAgent } | 'waiting' | 'over' | { failed: string; listed: boolean }> {
	const { config } = board;
	if (view.state !== 'resuming' && view.state !== 'resume-failed') return 'over';
	const name = view.relaunchedName;
	let listed = false;
	if (name) {
		const [hcom, herdr] = await Promise.all([listAgents(config), listHerdrAgents(config)]);
		const running = hcom.ok && herdr.ok ? runningIn(wantedOf(view, name), hcom.agents, herdr.agents) : null;
		if (running?.herdr && isRelaunched(view, running.herdr)) return { runs: running.herdr };
		listed = !!view.relaunch?.session && !!running?.hcom;
	}
	if (view.state === 'resume-failed') return { failed: view.error ?? '重新啟動失敗', listed };
	const since = Date.parse(view.appliedAt ?? view.resumingAt ?? view.time);
	if (config.now() < since + config.launchWaitMs) return 'waiting';
	return {
		failed: name
			? listed
				? firstTurnMissing(board, name)
				: `重新啟動後等了 ${Math.round(config.launchWaitMs / 1000)} 秒，Herdr 的清單上還沒有 @${name}`
			: '重新啟動的結果不明（看板在啟動途中停過），請到 Herdr 查看',
		listed
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
	// The client it launched still runs, its first turn not done: another launch would resume the
	// conversation twice. It is waited for, or the switch given up.
	if (typeof standing === 'object' && standing.listed) {
		return respondLogged(board, view.id, { reason: `${standing.failed}；沒有再啟動一次，請到 Herdr 查看它的畫面，或放棄這次切換`, status: 409 }, null);
	}
	const fail = (error: string, status = 502) => respondLogged(board, view.id, { reason: error, status }, step(board, view.id, { state: 'resume-failed', error }));
	if (!isLaunchClient(controller.client)) return fail(`看板不會重新啟動 ${controller.client || '這個 client'}。`, 409);
	// In the shell the stop left in its old tab while it is still open, else in a new tab.
	const held = await heldPane(config, view.holdPane);
	const workspace = await chooseWorkspace(config, controller.workspace, held?.workspace ?? view.agent?.workspace);
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
		prompt: relaunch.session && view.to.permission ? codexFirstTurnText(view.to.permission) : '',
		// Later arguments win over the ones hcom kept, the way a resume's do.
		extraArgs: [...relaunch.args, ...modelArgs(controller.client, view.to)],
		intoPane: held?.pane
	});
	if (launched.outcome === 'failed' || !launched.hcomName) {
		following.delete(view.id);
		return fail(launched.outcome === 'failed' ? (launched.reason ?? '重新啟動失敗') : '重新啟動後沒有拿到它的 HCOM 名稱，看板認不出是哪一個，請到 Herdr 查看');
	}
	const named = step(board, view.id, { relaunchedName: launched.hcomName });
	void followRelaunch(board, view, launched.hcomName);
	return respondLogged(board, view.id, { reason: null }, named);
}

/** Wait for a relaunched client to run, then end the switch (`finishRelaunch`), or record why it
 *  did not run. Only while the switch still waits for this client: a switch given up meanwhile
 *  stays given up. */
async function followRelaunch(board: Board, launched: SwitchView, name: string): Promise<void> {
	const { config } = board;
	const { id: switchId, controllerId } = launched;
	let appeared: Awaited<ReturnType<typeof waitToAppear>>;
	try {
		appeared = await waitToAppear(config, wantedOf(launched, name), config.now() + config.launchWaitMs, `@${name}`, {
			onPane: async () => true,
			accepts: (found) => isRelaunched(launched, found)
		});
	} catch (error) {
		appeared = { found: null, reason: `確認不了它有沒有在執行：${(error as Error).message}` };
	}
	await queued(controllerId, async () => {
		following.delete(switchId);
		const view = currentSwitch(board, switchId);
		if (view?.state !== 'resuming' || view.relaunchedName !== name) return;
		if (appeared.found) await finishRelaunch(board, view, appeared.found);
		else {
			// Still listed under its own name: running, its first turn not done.
			const list = view.relaunch?.session ? await listAgents(config) : null;
			const waiting = list?.ok && list.agents.some((agent) => agent.name === name && agent.sessionId === null);
			step(board, switchId, { state: 'resume-failed', error: waiting ? firstTurnMissing(board, name) : `重新啟動的 ${appeared.reason}` });
		}
	});
	await board.refresh();
	board.agentActed(controllerId);
}

/** End a relaunch whose client runs: give its tab the old label and place (a failure is noted),
 *  unless it runs in the shell held in its old tab, and mark the switch done. Returns why the log
 *  could not be written, or null. */
async function finishRelaunch(board: Board, view: SwitchView, found: HerdrAgent): Promise<string | null> {
	const { config } = board;
	const relaunch = view.relaunch!;
	const problems: string[] = [];
	if (found.pane === view.holdPane) return step(board, view.id, { state: 'done', error: null });
	if (relaunch.tabLabel) {
		const renamed = await renameTab(config, found.tab, relaunch.tabLabel);
		if (!renamed.ok) problems.push(`改分頁名稱失敗：${renamed.reason}`);
	}
	const moved = await moveTab(config, found.tab, relaunch.tabIndex ?? 0);
	if (moved) problems.push(moved);
	return step(board, view.id, {
		state: 'done',
		error: problems.length ? `${relaunch.session ? '已接回' : `已重新啟動為 @${view.relaunchedName}`}，但${problems.join('；')}` : null
	});
}

/** Settle the relaunches this board process does not wait for (it restarted while one was on its
 *  way): done once the client runs, failed once the launch wait is over. Queued per session like
 *  every other step of a switch, against the lines of the read that found them (`log`, still kept
 *  up with). Resolves once each has been looked at. */
export function settleRelaunches(board: Board, log: SentLog, switches: SwitchView[]): Promise<unknown> {
	const settling: Promise<unknown>[] = [];
	for (const open of switches) {
		if (!open.relaunch || open.state !== 'resuming' || following.has(open.id)) continue;
		settling.push(
			queued(open.controllerId, async () => {
				// The read's lines, kept up with: what was done to the switch while it waited its turn is in them.
				const view = switchView(log.lines, open.id, board.config.now(), board.config.launchWaitMs);
				if (!view || view.state !== 'resuming' || following.has(view.id)) return;
				const standing = await relaunchStanding(board, view);
				if (typeof standing !== 'object') return;
				if ('runs' in standing) await finishRelaunch(board, view, standing.runs);
				else step(board, view.id, { state: 'resume-failed', error: standing.failed });
				board.agentActed(view.controllerId);
			})
		);
	}
	return Promise.allSettled(settling);
}
