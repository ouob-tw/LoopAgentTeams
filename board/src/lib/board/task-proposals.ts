// 任務提案: an agent's request for a new automation task, kept by the board until the user decides
// it (#699). The proposal and result files' shapes, shared by the server, the pages and the agent's
// command (skills/local/task-proposal/scripts/task-proposal.py reads the same result files).
import type { AutomationTaskInput, TaskSource } from './automation.ts';

/** How the board placed the proposer against LAT's session records. */
export type ProposerRole = 'controller' | 'agent' | 'unknown';
export const ROLE_LABELS: Record<ProposerRole, string> = { controller: 'LAT 主控', agent: '一般 Agent', unknown: '無法判斷' };

/** Who sent a proposal, as the board's acceptor verified it from the connection itself. */
export interface Proposer {
	/** The HCOM name in hcom's list at the time. */
	name: string;
	client: 'claude' | 'codex';
	role: ProposerRole;
	/** The agent process's working folder. */
	folder: string;
	pid: number;
	/** The agent process's start time, in clock ticks after boot (`/proc/<pid>/stat` field 22). */
	startTime: number;
	/** HCOM's own ID of the agent process (`HCOM_PROCESS_ID`). */
	processId: string;
	/** The client session hcom lists for the agent; null when it lists none. */
	sessionId: string | null;
}

/** `<id>.json` in the task-proposal folder, written once by the board. `task` is the task as the
 *  新增任務 checks left it; `input` is what the agent sent, kept for an invalid proposal. */
export interface ProposalFile {
	version: 1;
	id: string;
	createdAt: string;
	expiresAt: string;
	proposer: Proposer;
	input: unknown;
	task: AutomationTaskInput | null;
	/** An agent task's brief as it was read when the proposal arrived. */
	brief: { path: string; text: string; sha256: string } | null;
}

/** A result's status. `approving` (核准中) is the approval's commit point (#760): the result file
 *  then holds what is approved and is rewritten in place to `approved` or `approve-failed`; every
 *  other status is written once and never changes. Each final one but `withdrawn` is told to the
 *  proposer over HCOM (`NOTIFIED`). */
export type ResultStatus = 'invalid' | 'withdrawn' | 'expired' | 'rejected' | 'approving' | 'approved' | 'approve-failed';
export const NOTIFIED: readonly ResultStatus[] = ['approved', 'approve-failed', 'rejected', 'expired', 'invalid'];
export const RESULT_LABELS: Record<ResultStatus | 'pending', string> = {
	pending: '等待中',
	invalid: '無效',
	withdrawn: '已撤回',
	expired: '已過期',
	rejected: '已拒絕',
	approving: '核准中',
	approved: '已核准',
	'approve-failed': '核准失敗'
};

/** What an approval committed to (核准中), saved whole in the result file: the task is made from
 *  this alone, never from the proposal file again, which may change or go afterwards. */
export interface Approval {
	/** Fixed by the proposal ID (`approvedTaskId`): one proposal, one task, however often it is retried. */
	taskId: string;
	/** The proposal file's SHA-256 the card showed and the passkey signed for. */
	contentHash: string;
	task: AutomationTaskInput;
	brief: ProposalFile['brief'];
	source: Omit<TaskSource, 'brief'>;
}

/** `<id>.result.json`: who took the proposal. Written by linking a finished temporary file into
 *  place, which fails when one is there already, so only the first result counts. */
export interface ResultFile {
	version: 1;
	id: string;
	status: ResultStatus;
	at: string;
	/** `invalid`: field → what is wrong, as the 新增任務 form words it. */
	errors?: Record<string, string>;
	/** `rejected`: the user's reason, when given; `approve-failed`: why. */
	reason?: string;
	/** `approved`: the task made from it. */
	taskId?: string;
	/** `rejected`: the logged-in device that rejected it. */
	deviceId?: string;
	/** `approving`, and `approved` or `approve-failed` after it: what was approved, and the SHA-256
	 *  of its JSON, which a damaged record no longer matches. */
	approval?: Approval;
	approvalHash?: string;
}

/** The task an approved proposal becomes: the same ID for the same proposal. */
export const approvedTaskId = (proposalId: string) => `proposal-${proposalId}`;

/** `<id>.notify.json`: the one HCOM message telling the proposer of a final result (結果通知).
 *  `sending` is written before it goes out; a board that restarts and finds it so never sends again
 *  and records `unknown` (通知結果不明). */
export interface NotifyFile {
	version: 1;
	id: string;
	/** Always 1: a proposal's message is tried at most once. */
	attempt: 1;
	status: 'sending' | 'sent' | 'failed' | 'unknown';
	at: string;
	/** `sent`: the HCOM name it went to; `failed`: why not. */
	to?: string;
	reason?: string;
}
export const NOTIFY_LABELS: Record<NotifyFile['status'], string> = { sending: '通知中', sent: '已通知', failed: '通知失敗', unknown: '通知結果不明' };

/** A waiting proposal as the list API sends it. `contentHash` is the proposal file's SHA-256: the
 *  card shown is the version an approval (#760) must match. */
export interface PendingProposal {
	id: string;
	createdAt: string;
	expiresAt: string;
	proposer: Proposer;
	task: AutomationTaskInput;
	brief: ProposalFile['brief'];
	contentHash: string;
}

/** One proposal by ID: the pending one, or its result, and how its proposer was told of it. */
export type ProposalDetail = Omit<PendingProposal, 'task'> & { task: AutomationTaskInput | null; status: ResultStatus | 'pending'; result: ResultFile | null; notify: NotifyFile | null };

/** The longest reason a rejection keeps. */
export const MAX_REJECT_REASON = 500;
/** How long a challenge to approve one proposal can be signed (核准挑戰). */
export const APPROVAL_CHALLENGE_MS = 5 * 60 * 1000;

/** 24 hours unanswered and a proposal expires; an ended one and its result go 7 days after the result. */
export const PROPOSAL_EXPIRY_MS = 24 * 60 * 60 * 1000;
export const PROPOSAL_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
export const PROPOSAL_ID = /^[a-f0-9]{12}$/;

/** What a page holds of the 任務提案 waiting: the list, and the board's own address, where alone
 *  its passkey works (null when the board has none set). Sent on the event stream as `proposals`. */
export interface ProposalsSnapshot {
	proposals: PendingProposal[];
	origin: string | null;
}

/** The proposer's name and client: <名稱>（<client>）. */
export const proposerName = (proposer: Pick<Proposer, 'name' | 'client'>) => `${proposer.name}（${proposer.client === 'codex' ? 'Codex' : 'Claude'}）`;
/** The verified proposer as a card and a push name them: 已查證：<名稱>（<client>）. */
export const VERIFIED = '已查證：';
export const proposerText = (proposer: Pick<Proposer, 'name' | 'client'>) => VERIFIED + proposerName(proposer);

/** The push for a new proposal: a set sentence and who proposed it, never the task, its command or a
 *  path, as it may show on a locked screen. Its click opens the board at the proposals. */
export function proposalPush(proposal: Pick<PendingProposal, 'id' | 'proposer'>) {
	const role = proposal.proposer.role === 'controller' ? ` · ${ROLE_LABELS.controller}` : '';
	return { title: '任務提案待核准', body: `有一筆新的任務提案等你核准\n${proposerText(proposal.proposer)}${role}`, alert: `task-proposal-${proposal.id}` };
}

/** How long a proposal has before it expires, as its card says it: 剩 23 時 12 分, 剩 8 分. */
export function timeLeftText(expiresAt: string, now: number): string {
	const minutes = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 60_000));
	if (minutes < 1) return '即將過期';
	const hours = Math.floor(minutes / 60);
	return hours ? `剩 ${hours} 時 ${String(minutes % 60).padStart(2, '0')} 分` : `剩 ${minutes} 分`;
}

/** Where the proposal window was moved to on a wide screen, kept in this browser. */
export const PROPOSALS_WINDOW_KEY = 'lat-board-proposals-window';
