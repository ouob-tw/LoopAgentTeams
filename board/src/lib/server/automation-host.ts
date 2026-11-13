// What an agent task's run does through the board (`automation-agent.ts`): it opens its agent by
// the new-agent launch flow, reads hcom's list, the conversation and the Herdr screen, closes the
// agent by the board's close flow, and handles the Codex account through codex-multi-auth and a
// probe run of Codex. Only `limits --json --refresh` and `switch <n>` of codex-multi-auth are run:
// never a reset, never an API account.
import { closeAgent } from './agent-control.ts';
import type { AgentHost, CodexAccounts, CodexLimits } from './automation-agent.ts';
import type { Board } from './board.ts';
import type { BoardConfig } from './config.ts';
import { parseJsonOutput, runCommand } from './external.ts';
import { killAgent, listAgents, resumeAgent } from './hcom.ts';
import { readTranscript } from './helper.ts';
import { readScreen } from './herdr.ts';
import { startLaunch } from './launch.ts';

/** The longest a codex-multi-auth command or a probe may take. */
const ACCOUNT_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 180_000;
/** How many times, and how far apart, hcom's list is read for a killed agent to be gone; still
 *  listed after that, nothing is switched. */
const KILL_CHECKS = 10;
const KILL_CHECK_MS = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The subscription accounts in `limits --json`: each one's highest use of its windows, in percent. */
export function parseLimits(value: unknown): CodexLimits | null {
	if (!isRecord(value) || !Array.isArray(value.accounts)) return null;
	const selection = isRecord(value.selection) ? value.selection : {};
	const pinned = typeof selection.pinnedIndex === 'number' ? selection.pinnedIndex : (value.accounts.find((account) => isRecord(account) && account.current === true) as { index?: number } | undefined)?.index ?? null;
	const accounts: CodexLimits['accounts'] = [];
	for (const account of value.accounts) {
		if (!isRecord(account) || typeof account.index !== 'number' || account.kind === 'api') continue;
		const quota = isRecord(account.quota) ? account.quota : null;
		const used = [quota?.primary, quota?.secondary]
			.filter((window): window is Record<string, unknown> => isRecord(window) && typeof window.usedPercent === 'number' && window.windowMinutes !== 0)
			.map((window) => window.usedPercent as number);
		accounts.push({
			index: account.index,
			label: `帳號 ${account.index + 1}`,
			enabled: account.enabled !== false,
			usedPercent: used.length ? Math.max(...used) : null
		});
	}
	return { pinned: typeof pinned === 'number' ? pinned : null, accounts };
}

export function codexAccounts(config: BoardConfig): CodexAccounts {
	return {
		async limits() {
			const run = await runCommand(config.codexMultiAuthCommand, ['limits', '--json', '--refresh'], { timeoutMs: ACCOUNT_TIMEOUT_MS });
			if (run.failure) return { ok: false, reason: `codex-multi-auth 查不到額度：${run.failure}` };
			const read = parseJsonOutput<unknown>(run, 'codex-multi-auth 的額度不是 JSON');
			if (!read.ok) return read;
			const limits = parseLimits(read.value);
			return limits ? { ok: true, value: limits } : { ok: false, reason: 'codex-multi-auth 的額度不是預期的格式' };
		},
		async switchTo(index) {
			const run = await runCommand(config.codexMultiAuthCommand, ['switch', String(index)], { timeoutMs: ACCOUNT_TIMEOUT_MS });
			return run.failure;
		},
		async probe(model, effort) {
			const run = await runCommand(
				config.codexProbeCommand,
				['exec', '-m', model, '-c', `model_reasoning_effort="${effort}"`, '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', 'Reply with OK only.'],
				{ timeoutMs: PROBE_TIMEOUT_MS }
			);
			if (!run.failure) return { ok: true };
			const said = `${run.stdout}\n${run.stderr}`;
			if (/model is not supported/i.test(said)) return { ok: false, reason: `這個帳號不能用 ${model}` };
			if (/usage limit/i.test(said)) return { ok: false, reason: '探測時額度仍是 0' };
			return { ok: false, reason: `探測沒過：${run.failure}` };
		}
	};
}

/** The host every agent task's run goes through; `board` is read when a run first needs it. */
export function boardAgentHost(config: BoardConfig, board: () => Board): AgentHost {
	return {
		pollMs: config.automationAgentPollMs,
		accounts: codexAccounts(config),
		async launch(spec) {
			const { body } = await startLaunch(board(), {
				client: spec.client,
				folder: spec.folder,
				text: spec.prompt,
				gitInit: false,
				workspace: { kind: 'auto' },
				agent: { tabName: '', tag: spec.tag },
				model: spec.model,
				effort: spec.effort
			});
			if (!body.ok) return { ok: false, reason: body.reason ?? '原因不明' };
			const name = body.entry?.hcomName;
			if (!name) return { ok: false, reason: 'hcom 沒有給 Agent 名稱，無法追蹤這次執行；請到 Herdr 分頁查看並自行關閉' };
			return { ok: true, name, workspace: body.entry?.herdrWorkspace ?? null };
		},
		async list() {
			const listed = await listAgents(config);
			if (!listed.ok) return listed;
			return { ok: true, agents: listed.agents.map(({ name, sessionId, pane, status, tag }) => ({ name, sessionId, pane, status, tag: tag ?? null })) };
		},
		async lastReply(client, sessionId) {
			const read = await readTranscript(config, client, sessionId);
			if (!read.ok) return { ok: false, reason: read.reason };
			const items = read.page.items;
			const reply = items.findLast((item) => item.kind === 'assistant');
			return { ok: true, text: reply && 'text' in reply ? reply.text : null, seq: reply?.seq ?? -1 };
		},
		async transcript(client, sessionId) {
			const read = await readTranscript(config, client, sessionId);
			return read.ok ? read.path : null;
		},
		async screen(pane) {
			const read = await readScreen(config, pane, 'detection');
			return 'text' in read ? read.text : null;
		},
		async close({ sessionId, name }) {
			let why = '';
			if (sessionId) {
				const closed = await closeAgent(board(), sessionId);
				if (closed.body.ok) return null;
				why = closed.body.reason ?? '';
			}
			// Not closable from the Herdr tab (not listed there): hcom ends it.
			const killed = await killAgent(config, name);
			return killed.failure ? `關不掉這個 Agent：${why ? `${why}；` : ''}hcom kill ${killed.failure}` : null;
		},
		async kill(name) {
			const killed = await killAgent(config, name);
			if (killed.failure) return `hcom kill ${killed.failure}`;
			for (let check = 0; check < KILL_CHECKS; check++) {
				const listed = await listAgents(config);
				if (listed.ok && !listed.agents.some((agent) => agent.name === name)) return null;
				await sleep(KILL_CHECK_MS);
			}
			return '已送出 hcom kill，但它還在 hcom 的清單上';
		},
		async resume(sessionId, workspace, prompt) {
			if (!workspace) return '不知道它原本開在哪個 Herdr 工作區';
			const resumed = await resumeAgent(config, { sessionId, herdrWorkspace: workspace, prompt, extraArgs: [] });
			return resumed.outcome === 'failed' ? (resumed.reason ?? '接回失敗') : null;
		}
	};
}
