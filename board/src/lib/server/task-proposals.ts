// 任務提案 on the server (#699, #759): the task-proposal folder and the acceptor that brings
// proposals in.
//
// The folder (0700) holds one proposal file `<id>.json` and, once it has one, one result file
// `<id>.result.json` per proposal, both 0600 (shapes in ../board/task-proposals.ts). Only the board
// writes them. A result is taken by linking a finished temporary file into place, which fails when
// one is there already: of 無效, 已撤回, 已過期 and #760's 核准中 and 已拒絕, only the first to link
// counts. An invalid proposal's result is linked before its proposal file is written, so it is never
// listed as waiting. The agent's command reads the result files itself (query, wait) without the board.
//
// The acceptor (hooks/task-proposal-acceptor.py) is a child of the board: it listens on the board's
// local socket, verifies the sending agent from the connection itself, and hands each verified
// request over its standard output; the answer goes back on its standard input. One that ends is
// logged and started again.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import {
	approvedTaskId,
	MAX_REJECT_REASON,
	PROPOSAL_EXPIRY_MS,
	PROPOSAL_ID,
	PROPOSAL_KEEP_MS,
	RESULT_LABELS,
	type Approval,
	type NotifyFile,
	type PendingProposal,
	type ProposalDetail,
	type ProposalFile,
	type Proposer,
	type ResultFile,
	type ResultStatus
} from '../board/task-proposals.ts';
import { expandHome, validateTask, writeAtomic, writeFirst, type Automation } from './automation.ts';
import type { BoardConfig, PasskeySite } from './config.ts';
import type { Device } from './devices.ts';
import { createApprovals, answerOf, TEST_DEVICE_REFUSED, type Answer } from './task-proposal-approval.ts';
import { createProposalNotifier, notifyPath, resultPath as resultPathIn, type NotifyTarget } from './task-proposal-notify.ts';
import { ownEnv } from './hcom.ts';
import { exceptionFields, log } from './log.ts';

/** The largest brief a proposal may carry in full. */
export const MAX_BRIEF_BYTES = 256 * 1024;
/** A temporary file left by a write that stopped halfway goes after this long. */
const STALE_TEMPORARY_MS = 60 * 60 * 1000;
/** Waits before starting an acceptor that ended again: longer each time it ends soon after starting. */
const RESTART_WAITS_MS = [500, 1_000, 2_000, 5_000, 10_000, 30_000];
/** An acceptor that ran this long counts as having started well: the next restart waits the least. */
const STARTED_WELL_MS = 60_000;

/** Why a request was not taken; the acceptor itself adds `refused` (sender not verified) and
 *  `board-timeout` (no reply in 30 s). */
export type RefusalCode = 'bad-request' | 'not-found' | 'not-yours' | 'ended' | 'board';
export type AcceptorReply =
	| { ok: true; id: string; status: 'pending' | 'invalid' | 'withdrawn'; errors?: Record<string, string> }
	| { ok: false; error: RefusalCode; reason: string; status?: string };

export interface TaskProposals {
	/** The waiting proposals, oldest first; expires and clears what is due first. */
	pending(): PendingProposal[];
	/** One proposal and its result; null when there is none. */
	detail(id: string): ProposalDetail | null;
	/** A verified agent's new proposal (the acceptor's `submit`). */
	submit(proposer: Proposer, input: unknown): AcceptorReply;
	/** A verified agent takes back its own waiting proposal (the acceptor's `withdraw`). */
	withdraw(proposer: Proposer, id: unknown): AcceptorReply;
	/** A passkey challenge to approve one proposal at the version its card showed (核准挑戰). */
	challenge(id: string, input: unknown, device: Device, https: boolean): Promise<Answer>;
	/** The passkey's answer to that challenge: the task is made when it holds. */
	approve(id: string, input: unknown, device: Device, https: boolean): Promise<Answer>;
	/** Reject a waiting proposal, with an optional reason (`input.reason`). */
	reject(id: string, input: unknown, device: Device): Answer;
	/** Expire proposals 24 h unanswered, finish 核准中, and remove ended ones 7 days after their result. */
	sweep(): void;
	/** Resolves once every result message started so far is done (tests). */
	idle(): Promise<void>;
	close(): void;
}

const isProposer = (value: any): value is Proposer =>
	!!value &&
	typeof value.name === 'string' &&
	(value.client === 'claude' || value.client === 'codex') &&
	['controller', 'agent', 'unknown'].includes(value.role) &&
	typeof value.folder === 'string' &&
	Number.isInteger(value.pid) &&
	Number.isInteger(value.startTime) &&
	typeof value.processId === 'string' &&
	(value.sessionId === null || typeof value.sessionId === 'string');

/** What an approval or a rejection came to, for the page. */
export type Decided =
	| { ok: true; id: string; status: ResultStatus; taskId?: string; reason?: string }
	| { ok: false; httpStatus: number; error: 'bad-request' | 'not-found' | 'ended' | 'changed'; reason: string; result?: ResultStatus };

/** Why a saved approval is no longer what was approved. */
export const DAMAGED_APPROVAL = '核准紀錄損壞，請 Agent 重新提案';

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export const approvalHashOf = (approval: Approval) => sha256(JSON.stringify(approval));

/** The folder alone, with no acceptor: what the acceptor's requests and the API read and write.
 *  `createTask` makes an approved proposal's task (the automation's `createApproved`); `taskExists`
 *  tells whether the task of a damaged approval was made already; `ended` hears of each final
 *  result written here, with whom to tell (結果通知); `damaged` of an approval found damaged. */
export function createProposalStore(options: {
	dir: string;
	now(): number;
	home?: string;
	createTask?: Automation['createApproved'];
	taskExists?(taskId: string): boolean;
	ended?(id: string, result: ResultFile, target: NotifyTarget | null): void;
	damaged?(id: string): void;
}) {
	const { dir, now } = options;
	const home = options.home ?? homedir();
	const proposalPath = (id: string) => join(dir, `${id}.json`);
	const resultPath = (id: string) => resultPathIn(dir, id);
	const stamp = () => new Date(now()).toISOString();

	function ensureDir() {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dir, 0o700);
	}
	ensureDir();

	/** Link a result into place; false when one was there first. */
	const takeResult = (result: ResultFile) => writeFirst(resultPath(result.id), JSON.stringify(result, null, '\t') + '\n');

	function readJson<T>(path: string): T | null {
		try {
			return JSON.parse(readFileSync(path, 'utf8')) as T;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log('WARNING', 'board.proposals', 'proposal_file_unreadable', { path, ...exceptionFields(error) });
			return null;
		}
	}

	function readProposal(id: string): { file: ProposalFile; hash: string } | null {
		let raw: Buffer;
		try {
			raw = readFileSync(proposalPath(id));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log('WARNING', 'board.proposals', 'proposal_file_unreadable', { id, ...exceptionFields(error) });
			return null;
		}
		try {
			const file = JSON.parse(raw.toString('utf8')) as ProposalFile;
			if (file?.id !== id || !isProposer(file.proposer)) throw new Error('not a proposal file');
			return { file, hash: createHash('sha256').update(raw).digest('hex') };
		} catch (error) {
			log('WARNING', 'board.proposals', 'proposal_file_unreadable', { id, ...exceptionFields(error) });
			return null;
		}
	}

	const readResult = (id: string) => readJson<ResultFile>(resultPath(id));

	/** The result as its file is: none, one, one that reads but is no result (`broken`), or one
	 *  that cannot be read just now (`unreadable`, such as out of file handles), left for a later look. */
	function resultState(id: string): { kind: 'none' } | { kind: 'read'; result: ResultFile } | { kind: 'broken' } | { kind: 'unreadable' } {
		let text: string;
		try {
			text = readFileSync(resultPath(id), 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none' };
			log('WARNING', 'board.proposals', 'proposal_file_unreadable', { id, ...exceptionFields(error) });
			return { kind: 'unreadable' };
		}
		try {
			const result = JSON.parse(text) as ResultFile;
			if (result?.id === id && typeof result.status === 'string' && result.status in RESULT_LABELS) return { kind: 'read', result };
		} catch {
			// Answered below.
		}
		return { kind: 'broken' };
	}

	/** Whom a result is told to: the proposer as verified, from the approval saved in the result
	 *  when there is one (the proposal file may have changed since), else from the proposal. */
	function targetOf(id: string, result: ResultFile): NotifyTarget | null {
		const proposer = result.approval?.source.proposer ?? readProposal(id)?.file.proposer;
		return proposer ? { name: proposer.name, sessionId: proposer.sessionId } : null;
	}

	/** A final result was written: log it and pass it on for 結果通知. */
	function ended(id: string, result: ResultFile): void {
		try {
			options.ended?.(id, result, targetOf(id, result));
		} catch (error) {
			log('ERROR', 'board.proposals', 'task_proposal_notify_failed', { proposal_id: id, ...exceptionFields(error) });
		}
	}

	/** Rewrite 核准中 to what it became; false, leaving 核准中 for the next look, when it cannot be written. */
	function settle(id: string, next: ResultFile): boolean {
		try {
			writeAtomic(resultPath(id), JSON.stringify(next, null, '\t') + '\n');
		} catch (error) {
			log('ERROR', 'board.proposals', 'task_proposal_result_unsaved', { proposal_id: id, status: next.status, ...exceptionFields(error) });
			return false;
		}
		log(next.status === 'approved' ? 'INFO' : 'WARNING', 'board.proposals', next.status === 'approved' ? 'task_proposal_approved' : 'task_proposal_approve_failed', {
			proposal_id: id,
			...(next.taskId ? { task_id: next.taskId } : {}),
			...(next.reason ? { reason: next.reason } : {})
		});
		ended(id, next);
		return true;
	}

	/** The saved approval when it is still what was approved; null when it is damaged. */
	function intact(id: string, result: ResultFile): Approval | null {
		const approval = result.approval;
		if (!approval || typeof approval !== 'object' || result.approvalHash !== approvalHashOf(approval)) return null;
		if (approval.taskId !== approvedTaskId(id) || !approval.task || typeof approval.task !== 'object' || approval.source?.proposalId !== id) return null;
		if (approval.brief && (typeof approval.brief.text !== 'string' || sha256(approval.brief.text) !== approval.brief.sha256)) return null;
		return approval;
	}

	/**
	 * Take 核准中 on to 已核准 or 核准失敗, from the result file alone: the task is made under its
	 * fixed ID (one already there is not made again), then the result rewritten. A file that could
	 * not be written, the task's or the result's, leaves 核准中 to be tried again by the next sweep;
	 * as the ID is fixed that never makes a second task. Answers the result as it is now.
	 */
	function finish(id: string, current: ResultFile | null): ResultFile | null {
		const at = stamp();
		const approval = current && intact(id, current);
		if (!approval) {
			const taskId = approvedTaskId(id);
			// The task came before the damage, from the approval as it was: that approval stands.
			if (options.taskExists?.(taskId)) return settle(id, { version: 1, id, status: 'approved', at, taskId }) ? readResult(id) : current;
			const failed: ResultFile = { version: 1, id, status: 'approve-failed', at, reason: DAMAGED_APPROVAL };
			if (!settle(id, failed)) return current;
			options.damaged?.(id);
			return failed;
		}
		if (!options.createTask) return current;
		let made: ReturnType<Automation['createApproved']>;
		try {
			made = options.createTask(approval);
		} catch (error) {
			log('ERROR', 'board.proposals', 'task_proposal_task_unsaved', { proposal_id: id, ...exceptionFields(error) });
			return current;
		}
		if (!made.ok && made.status >= 500) {
			log('ERROR', 'board.proposals', 'task_proposal_task_unsaved', { proposal_id: id, errors: made.errors });
			return current;
		}
		const next: ResultFile = made.ok
			? { ...current!, status: 'approved', at, taskId: made.task.id }
			: { ...current!, status: 'approve-failed', at, reason: `建立任務失敗：${Object.values(made.errors).join('；')}` };
		return settle(id, next) ? next : current;
	}

	function ids(): string[] {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return [];
		}
		const found = new Set<string>();
		for (const name of names) {
			const id = name.replace(/(?:\.result)?\.json$/, '');
			if (id !== name && PROPOSAL_ID.test(id)) found.add(id);
		}
		return [...found].sort();
	}

	function newId(): string {
		for (;;) {
			const id = randomBytes(6).toString('hex');
			try {
				statSync(proposalPath(id));
			} catch {
				try {
					statSync(resultPath(id));
				} catch {
					return id;
				}
			}
		}
	}

	/** An agent task's brief in full as the 新增任務 checks found it; an error for the form otherwise. */
	function readBrief(folder: string, brief: string): { brief: ProposalFile['brief'] } | { error: string } {
		const path = resolve(expandHome(folder, home), expandHome(brief, home));
		let bytes: Buffer;
		try {
			if (statSync(path).size > MAX_BRIEF_BYTES) return { error: `任務說明檔太大：最多 ${MAX_BRIEF_BYTES / 1024} KB` };
			bytes = readFileSync(path);
		} catch (error) {
			return { error: `讀不到任務說明檔：${(error as Error).message}` };
		}
		let text: string;
		try {
			// A byte-order mark stays in the text, so the text is the file byte for byte.
			text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
		} catch {
			return { error: '任務說明檔不是 UTF-8 文字' };
		}
		return { brief: { path, text, sha256: createHash('sha256').update(bytes).digest('hex') } };
	}

	/** Expire, finish and clear what is due. 核准中 is finished here, at start and on each later look,
	 *  and never cleared; so is a result file that reads but is no result, taken for a damaged 核准中:
	 *  only 核准中 is ever rewritten, every other result is linked in whole once. */
	function sweep(): void {
		const at = now();
		for (const id of ids()) {
			const state = resultState(id);
			if (state.kind === 'none') {
				const proposal = readProposal(id);
				if (proposal && Date.parse(proposal.file.expiresAt) <= at) {
					const expired: ResultFile = { version: 1, id, status: 'expired', at: new Date(at).toISOString() };
					if (takeResult(expired)) {
						log('INFO', 'board.proposals', 'task_proposal_expired', { proposal_id: id });
						ended(id, expired);
					}
				}
				continue;
			}
			if (state.kind === 'unreadable') continue;
			const result = state.kind === 'read' ? state.result : null;
			if (!result || result.status === 'approving') {
				finish(id, result);
				continue;
			}
			const endedAt = Date.parse(result.at);
			if (Number.isFinite(endedAt) && endedAt + PROPOSAL_KEEP_MS <= at) {
				// The result goes last: a cleanup stopped halfway is still found and finished.
				rmSync(notifyPath(dir, id), { force: true });
				rmSync(proposalPath(id), { force: true });
				rmSync(resultPath(id), { force: true });
				log('INFO', 'board.proposals', 'task_proposal_removed', { proposal_id: id, status: result.status });
			}
		}
		// Left by a write that stopped halfway; real time, as the files' own times are.
		let names: string[] = [];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names.filter((entry) => entry.endsWith('.tmp'))) {
			try {
				if (statSync(join(dir, name)).mtimeMs + STALE_TEMPORARY_MS <= Date.now()) unlinkSync(join(dir, name));
			} catch {
				// Gone already.
			}
		}
	}

	/** What the API shows of a proposal file. */
	const shownOf = (id: string, { file, hash }: { file: ProposalFile; hash: string }) => ({
		id,
		createdAt: file.createdAt,
		expiresAt: file.expiresAt,
		proposer: file.proposer,
		task: file.task,
		brief: file.brief,
		contentHash: hash
	});

	return {
		pending(): PendingProposal[] {
			sweep();
			const list: PendingProposal[] = [];
			for (const id of ids()) {
				// One with any result file, even one unreadable just now, is not waiting.
				if (resultState(id).kind !== 'none') continue;
				const proposal = readProposal(id);
				const shown = proposal && shownOf(id, proposal);
				if (shown?.task) list.push({ ...shown, task: shown.task });
			}
			return list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		},
		detail(id: string): ProposalDetail | null {
			sweep();
			const proposal = readProposal(id);
			if (!proposal) return null;
			const result = readResult(id);
			return { ...shownOf(id, proposal), status: result?.status ?? 'pending', result, notify: readJson<NotifyFile>(notifyPath(dir, id)) };
		},
		submit(proposer: Proposer, input: unknown): AcceptorReply {
			if (!isProposer(proposer)) return { ok: false, error: 'bad-request', reason: '看板沒收到查證過的提案者' };
			if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'bad-request', reason: '提案要是一個任務的欄位（JSON 物件）' };
			ensureDir();
			const checked = validateTask(input, home);
			const errors = 'errors' in checked ? { ...checked.errors } : {};
			let brief: ProposalFile['brief'] = null;
			if ('task' in checked && checked.task.agent) {
				const read = readBrief(checked.task.agent.folder, checked.task.agent.brief);
				if ('error' in read) errors.brief = read.error;
				else brief = read.brief;
			}
			const valid = Object.keys(errors).length === 0 && 'task' in checked;
			const at = now();
			const id = newId();
			const file: ProposalFile = {
				version: 1,
				id,
				createdAt: new Date(at).toISOString(),
				expiresAt: new Date(at + PROPOSAL_EXPIRY_MS).toISOString(),
				proposer,
				input,
				task: valid ? checked.task : null,
				brief: valid ? brief : null
			};
			// Invalid: the result goes first, so the proposal is never seen waiting.
			const invalid: ResultFile | null = valid ? null : { version: 1, id, status: 'invalid', at: file.createdAt, errors };
			if (invalid) takeResult(invalid);
			writeAtomic(proposalPath(id), JSON.stringify(file, null, '\t') + '\n');
			if (invalid) ended(id, invalid);
			log('INFO', 'board.proposals', valid ? 'task_proposal_received' : 'task_proposal_invalid', {
				proposal_id: id,
				proposer: proposer.name,
				client: proposer.client,
				role: proposer.role,
				...(valid ? {} : { fields: Object.keys(errors) })
			});
			return valid ? { ok: true, id, status: 'pending' } : { ok: true, id, status: 'invalid', errors };
		},
		withdraw(proposer: Proposer, id: unknown): AcceptorReply {
			if (!isProposer(proposer)) return { ok: false, error: 'bad-request', reason: '看板沒收到查證過的提案者' };
			if (typeof id !== 'string' || !PROPOSAL_ID.test(id)) return { ok: false, error: 'bad-request', reason: '提案編號不對' };
			const proposal = readProposal(id);
			if (!proposal) return { ok: false, error: 'not-found', reason: '找不到這個提案' };
			const owner = proposal.file.proposer;
			// The same agent process as hcom knows it: a later agent given the same name is another one.
			if (owner.name !== proposer.name || owner.client !== proposer.client || owner.processId !== proposer.processId) {
				log('WARNING', 'board.proposals', 'task_proposal_withdraw_refused', { proposal_id: id, proposer: proposer.name, owner: owner.name });
				return { ok: false, error: 'not-yours', reason: '只有提出這個提案的 Agent 能撤回它' };
			}
			sweep();
			if (!takeResult({ version: 1, id, status: 'withdrawn', at: new Date(now()).toISOString() })) {
				const status = readResult(id)?.status;
				const label = status ? RESULT_LABELS[status as ResultStatus] ?? status : '已有結果';
				return { ok: false, error: 'ended', status, reason: `這個提案已經有結果：${label}` };
			}
			log('INFO', 'board.proposals', 'task_proposal_withdrawn', { proposal_id: id, proposer: proposer.name });
			return { ok: true, id, status: 'withdrawn' };
		},
		/** Whether the waiting proposal is still at the version the card showed (its SHA-256); why
		 *  it cannot be approved otherwise. */
		stillShown(id: string, shownHash: string): { ok: true } | Extract<Decided, { ok: false }> {
			sweep();
			const proposal = readProposal(id);
			if (!proposal) return { ok: false, httpStatus: 404, error: 'not-found', reason: '找不到這個提案' };
			const state = resultState(id);
			if (state.kind !== 'none') return endedAnswer(state.kind === 'read' ? state.result.status : undefined);
			return proposal.hash === shownHash ? { ok: true } : changedAnswer();
		},
		/**
		 * Approve the waiting proposal at the version the card showed, for the device and passkey
		 * that signed: 核准中 is linked into place with everything the task is made from (the commit
		 * point), then finished at once. All of it runs without a pause, so nothing else in the board
		 * acts on the proposal between the check and the commit.
		 */
		approve(id: string, contentHash: string, by: { deviceId: string; passkeyId: string }): Decided {
			sweep();
			const proposal = readProposal(id);
			if (!proposal) return { ok: false, httpStatus: 404, error: 'not-found', reason: '找不到這個提案' };
			const state = resultState(id);
			if (state.kind !== 'none') return endedAnswer(state.kind === 'read' ? state.result.status : undefined);
			if (proposal.hash !== contentHash) return changedAnswer();
			const { file } = proposal;
			if (!file.task) return endedAnswer('invalid');
			const at = stamp();
			const { name, client, role, folder, sessionId } = file.proposer;
			const approval: Approval = {
				taskId: approvedTaskId(id),
				contentHash,
				task: file.task,
				brief: file.brief,
				source: { kind: 'proposal', proposalId: id, proposer: { name, client, role, folder, sessionId }, proposedAt: file.createdAt, approvedAt: at, deviceId: by.deviceId, passkeyId: by.passkeyId }
			};
			const approving: ResultFile = { version: 1, id, status: 'approving', at, approval, approvalHash: approvalHashOf(approval) };
			if (!takeResult(approving)) return endedAnswer(readResult(id)?.status);
			log('INFO', 'board.proposals', 'task_proposal_approving', { proposal_id: id, task_id: approval.taskId, device_id: by.deviceId, passkey_id: by.passkeyId });
			const settled = finish(id, approving) ?? approving;
			return { ok: true, id, status: settled.status, ...(settled.taskId ? { taskId: settled.taskId } : {}), ...(settled.reason ? { reason: settled.reason } : {}) };
		},
		/** Reject the waiting proposal, with the user's reason when one is given. */
		reject(id: string, reason: unknown, deviceId: string): Decided {
			if (reason !== undefined && reason !== null && typeof reason !== 'string') return { ok: false, httpStatus: 400, error: 'bad-request', reason: '原因要是文字' };
			const text = (reason ?? '').trim();
			if (text.length > MAX_REJECT_REASON) return { ok: false, httpStatus: 400, error: 'bad-request', reason: `原因最多 ${MAX_REJECT_REASON} 字` };
			sweep();
			if (!readProposal(id)) return { ok: false, httpStatus: 404, error: 'not-found', reason: '找不到這個提案' };
			const rejected: ResultFile = { version: 1, id, status: 'rejected', at: stamp(), ...(text ? { reason: text } : {}), deviceId };
			if (!takeResult(rejected)) return endedAnswer(readResult(id)?.status);
			log('INFO', 'board.proposals', 'task_proposal_rejected', { proposal_id: id, device_id: deviceId, with_reason: !!text });
			ended(id, rejected);
			return { ok: true, id, status: 'rejected', ...(text ? { reason: text } : {}) };
		},
		sweep
	};
}

const endedAnswer = (status: ResultStatus | undefined): Extract<Decided, { ok: false }> => ({
	ok: false,
	httpStatus: 409,
	error: 'ended',
	reason: `這個提案已經有結果：${status ? (RESULT_LABELS[status] ?? status) : '已有結果'}`,
	...(status ? { result: status } : {})
});

const changedAnswer = (): Extract<Decided, { ok: false }> => ({ ok: false, httpStatus: 409, error: 'changed', reason: '提案在你看過之後改了，請重新看過卡片再核准' });

/** The acceptor and what it brings in: started at once, started again whenever it ends. */
export function createTaskProposals(options: {
	dir: string;
	socket: string;
	now(): number;
	home?: string;
	/** The acceptor: the board appends the socket's path. */
	acceptorCommand: string[];
	/** What the acceptor lists agents with: hcom, or the tests' fake. */
	hcomCommand: string[];
	/** The LAT skill folder, whose `scripts/_lat_common.py` the acceptor reads LAT's session records by. */
	latDir: string;
	/** How long an hcom list or send may take, for 結果通知. */
	hcomListTimeoutMs: BoardConfig['hcomListTimeoutMs'];
	/** The board state folder, whose passkeys and logins an approval is checked against. */
	stateDir: string;
	passkeySite: PasskeySite | null;
	createTask?: Automation['createApproved'];
	taskExists?(taskId: string): boolean;
	/** An approval was found damaged and ended 核准失敗: the user is told (a push). */
	damaged?(id: string): void;
	sweepMs?: number;
}): TaskProposals {
	const notifier = createProposalNotifier({ dir: options.dir, now: options.now, config: options });
	const store = createProposalStore({ ...options, ended: notifier.tell });
	const approvals = createApprovals({ store, stateDir: options.stateDir, site: options.passkeySite, now: options.now });
	let child: ChildProcess | null = null;
	let closed = false;
	let restarts = 0;
	let restartTimer: ReturnType<typeof setTimeout> | undefined;

	/** The board's reply to one verified request from the acceptor. */
	function replyTo(request: any): AcceptorReply {
		try {
			if (request.op === 'submit') return store.submit(request.proposer, request.proposal);
			if (request.op === 'withdraw') return store.withdraw(request.proposer, request.id);
			return { ok: false, error: 'bad-request', reason: '看不懂這個請求' };
		} catch (error) {
			log('ERROR', 'board.proposals', 'task_proposal_failed', { op: request.op, ...exceptionFields(error) });
			return { ok: false, error: 'board', reason: '看板沒能寫下這個提案' };
		}
	}

	function start(restart: boolean) {
		const [command, ...args] = options.acceptorCommand;
		const startedAt = Date.now();
		const started = spawn(command, [...args, options.socket], {
			// The board's own environment, not that of an agent whose shell may have started it.
			env: { ...ownEnv(), LAT_PROPOSAL_HCOM_COMMAND: JSON.stringify(options.hcomCommand), LAT_PROPOSAL_LAT_DIR: options.latDir },
			stdio: ['pipe', 'pipe', 'pipe']
		});
		child = started;
		log('INFO', 'board.proposals', restart ? 'proposal_acceptor_restarted' : 'proposal_acceptor_started', { pid: started.pid, socket: options.socket });
		started.stdin!.on('error', () => {});
		createInterface({ input: started.stdout! }).on('line', (line) => {
			let request: any;
			try {
				request = JSON.parse(line);
			} catch {
				log('WARNING', 'board.proposals', 'proposal_acceptor_output', { line: line.slice(0, 500) });
				return;
			}
			if (request?.event === 'ready') log('INFO', 'board.proposals', 'proposal_acceptor_ready', { pid: request.pid });
			else if (request?.event === 'lat-rules-unavailable') log('WARNING', 'board.proposals', 'proposal_roles_unknown', { lat_dir: request.lat_dir });
			else if (request?.event === 'refused') log('WARNING', 'board.proposals', 'task_proposal_refused', { reason: request.reason, peer_pid: request.peer_pid });
			else if (Number.isInteger(request?.seq) && !started.stdin!.destroyed) started.stdin!.write(JSON.stringify({ seq: request.seq, reply: replyTo(request) }) + '\n');
		});
		createInterface({ input: started.stderr! }).on('line', (line) => log('WARNING', 'board.proposals', 'proposal_acceptor_stderr', { line: line.slice(0, 2000) }));
		started.on('error', (error) => log('ERROR', 'board.proposals', 'proposal_acceptor_unstarted', exceptionFields(error)));
		started.on('close', (code, signal) => {
			if (child === started) child = null;
			if (closed) return;
			restarts = Date.now() - startedAt >= STARTED_WELL_MS ? 0 : restarts + 1;
			const waitMs = RESTART_WAITS_MS[Math.min(restarts, RESTART_WAITS_MS.length - 1)];
			log('ERROR', 'board.proposals', 'proposal_acceptor_exited', { pid: started.pid, code, signal, restart_in_ms: waitMs });
			restartTimer = setTimeout(() => !closed && start(true), waitMs);
		});
	}

	const stopChild = () => {
		if (!child) return;
		child.stdin?.end();
		try {
			child.kill('SIGTERM');
		} catch {
			// Gone already.
		}
	};
	process.once('exit', stopChild);

	start(false);
	// Before anything new is sent: a message the last board was sending is not known to have gone.
	notifier.settleInterrupted();
	store.sweep();
	const sweeper = setInterval(() => store.sweep(), options.sweepMs ?? 60_000);
	sweeper.unref?.();

	return {
		pending: store.pending,
		detail: store.detail,
		submit: store.submit,
		withdraw: store.withdraw,
		challenge: approvals.challenge,
		approve: approvals.approve,
		reject(id, input, device) {
			if (device.test) return TEST_DEVICE_REFUSED;
			if (input !== null && input !== undefined && (typeof input !== 'object' || Array.isArray(input))) return { status: 400, body: { error: 'bad-request' } };
			return answerOf(store.reject(id, (input as { reason?: unknown } | null)?.reason, device.id));
		},
		sweep: store.sweep,
		idle: notifier.idle,
		close() {
			closed = true;
			clearTimeout(restartTimer);
			clearInterval(sweeper);
			process.off('exit', stopChild);
			// Its standard input closing ends it, and it removes the socket.
			child?.stdin?.end();
		}
	};
}
