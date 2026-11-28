// 結果通知 (#699 consensus v4, #760): once a 任務提案 has a final result, one HCOM message tells the
// agent that proposed it, so it need not keep waiting. Best effort and at most once: `<id>.notify.json`
// is taken (linked into place, like a result) as 通知中 before anything is sent, then rewritten to
// 已通知 or 通知失敗; a board that restarts and finds 通知中 never sends again and records 通知結果不明.
// The result file stays what counts; the agent's query command reads it whatever happened here.
//
// The proposer is found by the HCOM session the acceptor verified, not by its name: hcom's list must
// have exactly one agent with that session, and the message goes to that agent's name now (so a
// rename still reaches it). None, several, or no session kept, and nothing is sent: a name alone may
// belong to another agent by now.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOTIFIED, PROPOSAL_ID, RESULT_LABELS, type NotifyFile, type ResultFile } from '../board/task-proposals.ts';
import { writeAtomic, writeFirst } from './automation.ts';
import { runCommand } from './external.ts';
import { listAgents, ownEnv } from './hcom.ts';
import { exceptionFields, log } from './log.ts';
import type { BoardConfig } from './config.ts';

/** Who to tell: the proposer's name when it proposed, and the session hcom listed it with. */
export interface NotifyTarget {
	name: string;
	sessionId: string | null;
}

export interface ProposalNotifier {
	/** Tell the proposer of this final result, unless it was told (or tried) before. */
	tell(id: string, result: ResultFile, target: NotifyTarget | null): void;
	/** At start: every 通知中 left by a board that stopped becomes 通知結果不明. */
	settleInterrupted(): void;
	/** Resolves once every message started so far is done (tests and closing). */
	idle(): Promise<void>;
}

/** The sender name the messages carry. */
const SENDER = 'lat-board';

export const notifyPath = (dir: string, id: string) => join(dir, `${id}.notify.json`);

/** The message: the proposal, its result and the task or reason, and how to look it up; never the
 *  brief or the task's command. */
export function notifyText(id: string, result: ResultFile): string {
	const lines = [`任務提案 ${id}：${RESULT_LABELS[result.status]}`];
	if (result.status === 'approved' && result.taskId) lines.push(`任務編號：${result.taskId}`);
	if (result.reason) lines.push(`原因：${result.reason}`);
	if (result.status === 'invalid' && result.errors) lines.push(`有問題的欄位：${Object.keys(result.errors).join('、')}`);
	lines.push(`查詢結果：task-proposal.py status ${id}`);
	return lines.join('\n');
}

export function createProposalNotifier(options: { dir: string; now(): number; config: Pick<BoardConfig, 'hcomCommand' | 'hcomListTimeoutMs'> }): ProposalNotifier {
	const { dir, now, config } = options;
	const running = new Set<Promise<void>>();
	const stamp = () => new Date(now()).toISOString();

	/** Take the one attempt: false when this proposal had one already. */
	function claim(id: string): boolean {
		const sending: NotifyFile = { version: 1, id, attempt: 1, status: 'sending', at: stamp() };
		return writeFirst(notifyPath(dir, id), JSON.stringify(sending, null, '\t') + '\n');
	}

	function record(id: string, fields: Pick<NotifyFile, 'status' | 'to' | 'reason'>) {
		const file: NotifyFile = { version: 1, id, attempt: 1, at: stamp(), ...fields };
		try {
			writeAtomic(notifyPath(dir, id), JSON.stringify(file, null, '\t') + '\n');
		} catch (error) {
			log('ERROR', 'board.proposals', 'task_proposal_notify_unsaved', { proposal_id: id, status: fields.status, ...exceptionFields(error) });
		}
	}

	/** The proposer's name now, by its session; or why there is none to send to. */
	async function recipient(target: NotifyTarget | null): Promise<{ name: string } | { reason: string }> {
		if (!target?.sessionId) return { reason: '提案者沒有記下的 HCOM session' };
		const list = await listAgents(config);
		if (!list.ok) return { reason: list.reason };
		const matches = list.agents.filter((agent) => agent.sessionId === target.sessionId);
		if (matches.length > 1) return { reason: `hcom 的名單裡有 ${matches.length} 個 Agent 用同一個 session，認不出是哪一個` };
		if (matches.length === 1) return { name: matches[0].name };
		if (list.agents.some((agent) => agent.name === target.name)) return { reason: `${target.name} 現在是另一個 session，不是提出這個提案的 Agent` };
		return { reason: '提出這個提案的 Agent 已不在 hcom 的名單裡' };
	}

	async function send(id: string, result: ResultFile, target: NotifyTarget | null) {
		const found = await recipient(target);
		if ('reason' in found) {
			log('INFO', 'board.proposals', 'task_proposal_notify_skipped', { proposal_id: id, status: result.status, proposer: target?.name ?? null, reason: found.reason });
			record(id, { status: 'failed', reason: found.reason });
			return;
		}
		// A send is as quick as a list: both only touch hcom's own database.
		const run = await runCommand(config.hcomCommand, ['send', `@${found.name}`, '--intent', 'inform', '--from', SENDER], {
			input: notifyText(id, result),
			env: ownEnv(),
			timeoutMs: config.hcomListTimeoutMs
		});
		if (run.failure) {
			const reason = `hcom 傳送失敗：${run.failure}`;
			log('WARNING', 'board.proposals', 'task_proposal_notify_failed', { proposal_id: id, status: result.status, to: found.name, reason });
			record(id, { status: 'failed', to: found.name, reason });
			return;
		}
		log('INFO', 'board.proposals', 'task_proposal_notified', { proposal_id: id, status: result.status, to: found.name });
		record(id, { status: 'sent', to: found.name });
	}

	return {
		tell(id, result, target) {
			if (!NOTIFIED.includes(result.status)) return;
			let claimed: boolean;
			try {
				claimed = claim(id);
			} catch (error) {
				log('ERROR', 'board.proposals', 'task_proposal_notify_unsaved', { proposal_id: id, status: 'sending', ...exceptionFields(error) });
				return;
			}
			if (!claimed) return;
			const job = send(id, result, target)
				.catch((error) => {
					log('ERROR', 'board.proposals', 'task_proposal_notify_failed', { proposal_id: id, status: result.status, ...exceptionFields(error) });
					record(id, { status: 'failed', reason: (error as Error).message });
				})
				.finally(() => running.delete(job));
			running.add(job);
		},
		settleInterrupted() {
			let names: string[];
			try {
				names = readdirSync(dir).filter((name) => name.endsWith('.notify.json'));
			} catch {
				return;
			}
			for (const name of names) {
				const id = name.slice(0, -'.notify.json'.length);
				let file: NotifyFile;
				try {
					file = JSON.parse(readFileSync(join(dir, name), 'utf8'));
				} catch {
					continue;
				}
				if (!PROPOSAL_ID.test(id) || file?.status !== 'sending') continue;
				log('WARNING', 'board.proposals', 'task_proposal_notify_unknown', { proposal_id: id });
				record(id, { status: 'unknown', reason: '看板在傳送通知時重新啟動，不確定有沒有送到' });
			}
		},
		async idle() {
			while (running.size) await Promise.all([...running]);
		}
	};
}
