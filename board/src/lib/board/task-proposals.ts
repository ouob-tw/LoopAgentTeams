// 任務提案: an agent's request for a new automation task, kept by the board until the user decides
// it (#699). The proposal and result files' shapes, shared by the server, the pages and the agent's
// command (skills/local/task-proposal/scripts/task-proposal.py reads the same result files).
import type { AutomationTaskInput } from './automation.ts';

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
 *  other status is written once and never changes. */
export type ResultStatus = 'invalid' | 'withdrawn' | 'expired' | 'rejected' | 'approving' | 'approved' | 'approve-failed';
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

/** `<id>.result.json`: who took the proposal. Written by linking a finished temporary file into
 *  place, which fails when one is there already, so only the first result counts. */
export interface ResultFile {
	version: 1;
	id: string;
	status: ResultStatus;
	at: string;
	/** `invalid`: field → what is wrong, as the 新增任務 form words it. */
	errors?: Record<string, string>;
	/** `rejected`: the user's reason; `approve-failed`: why. */
	reason?: string;
	/** `approved`: the task made from it. */
	taskId?: string;
}

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

/** One proposal by ID: the pending one, or its result. */
export type ProposalDetail = Omit<PendingProposal, 'task'> & { task: AutomationTaskInput | null; status: ResultStatus | 'pending'; result: ResultFile | null };

/** 24 hours unanswered and a proposal expires; an ended one and its result go 7 days after the result. */
export const PROPOSAL_EXPIRY_MS = 24 * 60 * 60 * 1000;
export const PROPOSAL_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
export const PROPOSAL_ID = /^[a-f0-9]{12}$/;
