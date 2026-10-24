// The board's side of the shared board-ask folder (format in `hooks/board-ask.py`): reading the
// asks the hook wrote, touching the heartbeat that tells the hook a board runs, taking an ask with
// the user's answer, which only one writer can do, sending an answer that came after the hook's
// deadline as a message, marking asks whose hook was ended in the terminal, telling Codex that a
// tool it was allowed after its turn ended has run, and removing asks 7 days after they ended.
import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAction } from '../board/agent-actions.ts';
import {
	answersText,
	ASK_INTERRUPTED_REASON,
	ASK_EXECUTION_WAIT_MS,
	ASK_RETENTION_MS,
	ASK_TAKEN_REASON,
	BOARD_ASK_STATE_TEXT,
	decisionText,
	ENDED_ASK_STATES,
	executedMessage,
	lateAnswerMessage,
	latePermissionMessage,
	NOT_ADOPTED_NOTE,
	PERMISSION_DECISION_TEXT,
	permissionSummary,
	pickComplete,
	pickText,
	type AskAnswerResponse,
	type AskPick,
	type AskQuestion,
	type BoardAsk,
	type BoardAskState,
	type PermissionDecision
} from '../board/board-asks.ts';
import type { Agent } from '../board/types.ts';
import { relayToAgent } from './agent-control.ts';
import type { Board } from './board.ts';
import type { BoardConfig } from './config.ts';
import { appendSent } from './sent-log.ts';

export const HEARTBEAT_FILE = 'heartbeat';
/** How often the heartbeat is touched; the hook takes one older than 90 seconds as no board. */
export const HEARTBEAT_MS = 30_000;

/** An ask's ID as a file name: nothing that leaves the folder. */
const safeId = (id: string) => /^[\w-]+$/.test(id);

/** The files of the folder that are the asks and their results, not the heartbeat or a file
 *  still being written. */
export const isAskFile = (name: string) => !name.startsWith('.') && name.endsWith('.json');

/** The files beside an ask's own, by what follows its ID. */
const ASK_SUFFIXES = ['.json', '.result.json', '.late.json', '.resend.json', '.observed.json', '.stopped.json', '.executed.json', '.notified.json', '.noted.json'];

/** A grace past the hook's watch of Claude's transcript, for a watcher that did not write. */
const OBSERVE_GRACE_MS = 10_000;

interface AskFile {
	id: string;
	client: string;
	session_id: string;
	cwd?: string;
	kind?: 'question' | 'permission';
	tool_name?: string;
	/** A question's questions, or a permission request's tool input. */
	tool_input: { questions: AskQuestion[] } | Record<string, unknown>;
	created_at: string;
	deadline_at: string;
	hook_pid?: number;
	outcome: 'filled' | 'timed_out' | 'handed_back' | 'terminal' | 'sent' | 'allowed' | null;
	outcome_at?: string | null;
	observe_until?: string;
}

type ResultFile =
	| { kind: 'answer'; answers?: Record<string, string>; picks?: AskPick[]; decision?: PermissionDecision; reason?: string; at?: string }
	| { kind: 'timeout'; at?: string }
	| { kind: 'handed_back'; at?: string }
	| { kind: 'terminal'; decision: PermissionDecision; at?: string }
	| { kind: 'interrupted'; at: string };

/** An answer to a timed-out ask: taken once, then written again with what its message came to. */
interface LateFile {
	kind: 'answer';
	/** A question's answers and picks, or a permission request's decision and reason. */
	answers?: Record<string, string>;
	picks?: AskPick[] | null;
	decision?: PermissionDecision;
	reason?: string;
	at: string;
	outcome?: 'relayed' | 'gone';
	outcome_at?: string;
}

/** The files the hook writes beside a permission ask after it took its answer. */
interface ObservedFile {
	decision?: PermissionDecision;
	kind?: 'unknown';
	at: string;
}
interface ExecutedFile {
	kind: 'executed' | 'ambiguous';
	at: string;
}
/** The board's message that Codex's allowed tool ran: taken once, then written with its outcome. */
interface NotifiedFile {
	at: string;
	outcome?: 'relayed' | 'gone';
	outcome_at?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isDecision = (value: unknown): value is PermissionDecision => value === 'allow' || value === 'deny';

function isAsk(value: unknown): value is AskFile {
	const ask = value as Partial<AskFile> | null;
	if (typeof ask?.id !== 'string' || typeof ask.session_id !== 'string' || typeof ask.client !== 'string' || typeof ask.created_at !== 'string' || typeof ask.deadline_at !== 'string') return false;
	if (ask.kind === 'permission') return typeof ask.tool_name === 'string' && isRecord(ask.tool_input);
	const questions = (ask.tool_input as { questions?: unknown } | undefined)?.questions;
	return Array.isArray(questions) && questions.every((question) => typeof question?.question === 'string' && Array.isArray(question.options));
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return null;
	}
}

/** A resend of a late answer the board may not have sent: taken once, then written again with
 *  what its message came to. The answer is the late file's. */
interface ResendFile {
	kind: 'resend';
	at: string;
	outcome?: 'relayed' | 'gone';
	outcome_at?: string;
}

/** Asks whose late answer this board is sending now. A late or resend file without an outcome
 *  that is not one of them was left by a board that stopped while sending: whether it typed the
 *  message in is not known, so the ask reads `relay_unknown`, is not sent again by itself, and the
 *  user may resend it. */
const relaying = new Set<string>();

/** An ask's files as last read. */
interface AskFiles {
	ask: AskFile;
	result: ResultFile | null;
	late: LateFile | null;
	resend: ResendFile | null;
	observed: ObservedFile | null;
	stopped: boolean;
	executed: ExecutedFile | null;
	notified: NotifiedFile | null;
}

/** A message the board sends for an ask (`taken`, the late or notified file), as far as it went:
 *  `idle` before it is taken; `sent` once it went. */
function relayState(id: string, taken: { outcome?: 'relayed' | 'gone' } | null, resend: ResendFile | null, idle: BoardAskState, sent: BoardAskState): BoardAskState {
	if (!taken) return idle;
	const outcome = taken.outcome ?? (relaying.has(id) ? null : resend?.outcome);
	if (outcome) return outcome === 'relayed' ? sent : 'gone';
	return relaying.has(id) ? 'relaying' : 'relay_unknown';
}

function standing(files: AskFiles, now: number, executionWaitMs: number): { state: BoardAskState; endedAt: string | null } {
	const { ask, result, late, resend, observed, executed, notified } = files;
	const at = (state: BoardAskState, endedAt: string | null | undefined) => ({ state, endedAt: ENDED_ASK_STATES.has(state) ? (endedAt ?? ask.created_at) : null });
	const relayEnd = (taken: { at: string; outcome_at?: string } | null) => resend?.outcome_at ?? taken?.outcome_at ?? taken?.at;
	if (!result) return at('waiting', null);
	if (result.kind === 'interrupted' || result.kind === 'handed_back' || result.kind === 'terminal') return at(result.kind, result.at);
	if (result.kind === 'timeout') return at(relayState(ask.id, late, resend, 'timed_out', 'relayed'), relayEnd(late));
	if (allowedLate(files)) {
		const expires = Date.parse(ask.outcome_at ?? result.at ?? ask.created_at) + executionWaitMs;
		// Seen run after the wait ended counts for nothing: the card already said no one was told.
		if (executed && Date.parse(executed.at) < expires) {
			if (executed.kind === 'ambiguous') return at('allowed_unmatched', executed.at);
			return at(relayState(ask.id, notified, resend, 'executed', 'notified'), relayEnd(notified));
		}
		return now >= expires ? at('allowed_expired', new Date(expires).toISOString()) : at('allowed_waiting', null);
	}
	if (ask.outcome === 'filled') return at('filled', ask.outcome_at ?? result.at);
	if (ask.kind !== 'permission') return at('answered', null);
	if (ask.outcome === 'sent') {
		if (observed?.decision) return at(observed.decision === result.decision ? 'filled' : 'terminal', observed.at);
		const until = Date.parse(ask.observe_until ?? '') + OBSERVE_GRACE_MS;
		if (observed?.kind === 'unknown') return at('result_unknown', observed.at);
		if (now >= until) return at('result_unknown', new Date(until).toISOString());
		return at('sent', null);
	}
	return at('answered', null);
}

/** Codex allowed after its turn ended: its Stop came while the request waited, so its mark counts
 *  even when written after the hook took the allow and called the ask filled. Not before the hook
 *  handed the allow back. */
function allowedLate({ ask, result, stopped }: Pick<AskFiles, 'ask' | 'result' | 'stopped'>): boolean {
	return ask.client === 'codex' && ask.kind === 'permission' && result?.kind === 'answer' && result.decision === 'allow' && (ask.outcome === 'allowed' || (ask.outcome === 'filled' && stopped));
}

/** Every ask in the folder that can be read, oldest first; a folder that does not exist holds none.
 *  `executionWaitMs` is how long a tool Codex was allowed after its turn ended is waited for. */
export function readAsks(dir: string, { now = Date.now(), executionWaitMs = ASK_EXECUTION_WAIT_MS }: { now?: number; executionWaitMs?: number } = {}): BoardAsk[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const asks: BoardAsk[] = [];
	for (const name of names) {
		// An ask's own file is its ID and `.json`; the IDs have no dots.
		if (!isAskFile(name) || name.split('.').length !== 2) continue;
		const ask = readJson(join(dir, name));
		if (!isAsk(ask) || `${ask.id}.json` !== name) continue;
		const file = (suffix: string) => readJson(join(dir, `${ask.id}${suffix}`));
		const result = file('.result.json') as ResultFile | null;
		const late = result?.kind === 'timeout' ? (file('.late.json') as LateFile | null) : null;
		const permission = ask.kind === 'permission';
		const answered = result?.kind === 'answer' ? result : null;
		const stopped = permission && file('.stopped.json') !== null;
		const afterTurn = allowedLate({ ask, result, stopped });
		const notified = afterTurn ? (file('.notified.json') as NotifiedFile | null) : null;
		const relayed = late ?? notified;
		const files: AskFiles = {
			ask,
			result,
			late,
			resend: relayed && !relayed.outcome ? (file('.resend.json') as ResendFile | null) : null,
			observed: permission && ask.outcome === 'sent' ? (file('.observed.json') as ObservedFile | null) : null,
			stopped,
			executed: afterTurn ? (file('.executed.json') as ExecutedFile | null) : null,
			notified
		};
		const { state, endedAt } = standing(files, now, executionWaitMs);
		const taken = answered ?? late;
		const decision = permission && isDecision(taken?.decision) ? taken.decision : null;
		asks.push({
			id: ask.id,
			sessionId: ask.session_id,
			client: ask.client,
			kind: permission ? 'permission' : 'question',
			tool: permission ? ask.tool_name! : null,
			folder: typeof ask.cwd === 'string' && ask.cwd ? ask.cwd : null,
			questions: permission ? [] : (ask.tool_input as { questions: AskQuestion[] }).questions,
			toolInput: permission ? (ask.tool_input as Record<string, unknown>) : null,
			decision,
			reason: decision === 'deny' && typeof taken?.reason === 'string' && taken.reason ? taken.reason : null,
			actual: result?.kind === 'terminal' && isDecision(result.decision) ? result.decision : isDecision(files.observed?.decision) ? files.observed.decision : null,
			notAdopted: state === 'terminal' && answered !== null,
			turnEnded: files.stopped,
			createdAt: ask.created_at,
			deadlineAt: ask.deadline_at,
			state,
			endedAt,
			answers: !permission && taken ? (taken.answers ?? null) : null,
			picks: !permission && taken && Array.isArray(taken.picks) ? taken.picks : null
		});
	}
	return asks.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** Tell the hook a board runs. A folder that cannot be written leaves it without one: the hook
 *  then shows the client's own menu. */
export function touchHeartbeat(dir: string): void {
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		writeFileSync(join(dir, HEARTBEAT_FILE), new Date().toISOString() + '\n', { mode: 0o600 });
	} catch {
		// Tried again at the next beat.
	}
}

/** Write the record to the file only if nobody has: true when this call did. The record is
 *  written whole and then linked into place, which fails when the file exists. */
function claim(dir: string, name: string, record: object): boolean {
	const temporary = join(dir, `.${name}.${randomUUID()}.tmp`);
	writeFileSync(temporary, JSON.stringify(record) + '\n', { mode: 0o600 });
	try {
		linkSync(temporary, join(dir, name));
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
		throw error;
	} finally {
		rmSync(temporary, { force: true });
	}
}

/** The record as the file's whole content: a temporary file renamed into place. */
function writeWhole(dir: string, name: string, record: object): void {
	const temporary = join(dir, `.${name}.${randomUUID()}.tmp`);
	writeFileSync(temporary, JSON.stringify(record) + '\n', { mode: 0o600 });
	renameSync(temporary, join(dir, name));
}

/** Take the ask with these answers, and the picks they came from for the board to show: true when
 *  this call did, false when someone (another device, or the hook at its deadline) took it first. */
export function takeAsk(dir: string, id: string, answers: Record<string, string>, picks: AskPick[] | null = null): boolean {
	if (!safeId(id)) throw new Error(`ask ID ${id} 不能當檔名`);
	return claim(dir, `${id}.result.json`, { kind: 'answer', answers, picks, at: new Date().toISOString() });
}

/** Take a permission ask with the user's allow or deny: true when this call did. */
export function takePermission(dir: string, id: string, decision: PermissionDecision, reason: string | null = null): boolean {
	if (!safeId(id)) throw new Error(`ask ID ${id} 不能當檔名`);
	return claim(dir, `${id}.result.json`, { kind: 'answer', decision, reason: reason ?? '', at: new Date().toISOString() });
}

/** Whether a process with this ID still runs; a zombie, ended but not yet reaped, does not. */
function running(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
	try {
		// `/proc/<pid>/stat`: `<pid> (<name>) <state> …`; the name may hold spaces and parentheses.
		const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
		return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
	} catch {
		return true;
	}
}

/** What an ask's entries in the operation record name: its questions, or the tool it asked for. */
function askText(ask: BoardAsk): string {
	if (ask.kind === 'permission') return `${ask.tool} ${permissionSummary(ask.toolInput!)}`;
	return ask.questions.map((question) => question.question).join('\n');
}

/** Why a permission ask that ended without the board's answer being used says so in the operation
 *  record, by the state it ended in; the states not here need no entry of their own. */
function endNote(ask: BoardAsk): string | null {
	const actual = ask.actual ? PERMISSION_DECISION_TEXT[ask.actual] : '';
	switch (ask.state) {
		case 'terminal':
			return ask.notAdopted ? `${NOT_ADOPTED_NOTE}：已在終端機回答（${actual}）` : `已在終端機回答（${actual}），看板沒有作答`;
		case 'result_unknown':
			return ask.decision ? `${BOARD_ASK_STATE_TEXT.result_unknown}：看不到 Claude 採用了哪個答案` : null;
		case 'handed_back':
			return '已交回終端機，看板沒有作答';
		case 'allowed_expired':
		case 'allowed_unmatched':
			return BOARD_ASK_STATE_TEXT[ask.state];
		default:
			return null;
	}
}

/** Write an entry the board itself makes for an ask in its agent's operation record. */
function logEnd(stateDir: string, ask: BoardAsk, agents: Agent[], at: number, error: string): void {
	const agent = agents.find((candidate) => candidate.id === ask.sessionId);
	try {
		appendSent(stateDir, {
			id: randomUUID(),
			kind: 'agent-action',
			action: 'board-ask',
			time: new Date(at).toISOString(),
			agentId: ask.sessionId,
			name: agent?.name ?? '',
			route: null,
			pane: agent?.herdr.pane ?? null,
			text: askText(ask),
			ok: false,
			error
		});
	} catch {
		// The card says it all the same.
	}
}

/**
 * Bring the folder up to date before it is read: an ask whose hook process is gone with nothing
 * taken was ended in the terminal (Esc, or the agent closed), so it is taken as interrupted, takes
 * no answer, and goes in its agent's operation record; so does, once, a permission ask that ended
 * without the board's answer being used (see `endNote`); an ask that ended at least 7 days ago is
 * removed with its files. `agents` are the agents as listed now, for the record's name and pane.
 */
export function settleAsks(config: Pick<BoardConfig, 'asksDir' | 'stateDir' | 'askExecutionWaitMs'>, agents: Agent[], now = Date.now()): void {
	const dir = config.asksDir;
	for (const ask of readAsks(dir, { now, executionWaitMs: config.askExecutionWaitMs })) {
		if (ask.endedAt !== null && now - Date.parse(ask.endedAt) >= ASK_RETENTION_MS) {
			for (const suffix of ASK_SUFFIXES) rmSync(join(dir, `${ask.id}${suffix}`), { force: true });
			continue;
		}
		const note = ask.kind === 'permission' ? endNote(ask) : null;
		if (note !== null) {
			try {
				if (claim(dir, `${ask.id}.noted.json`, { at: new Date(now).toISOString() })) logEnd(config.stateDir, ask, agents, now, note);
			} catch {
				// Tried again at the next read.
			}
			continue;
		}
		if (ask.state !== 'waiting') continue;
		const pid = (readJson(join(dir, `${ask.id}.json`)) as AskFile | null)?.hook_pid;
		if (!Number.isInteger(pid) || running(pid!)) continue;
		let interrupted: boolean;
		try {
			// Lost to an answer or the deadline that came first: that one stands.
			interrupted = claim(dir, `${ask.id}.result.json`, { kind: 'interrupted', at: new Date(now).toISOString() });
		} catch {
			// Tried again at the next read.
			continue;
		}
		if (interrupted) logEnd(config.stateDir, ask, agents, now, ASK_INTERRUPTED_REASON);
	}
}

/** The message the board sends for an ask: the answer to a timed-out one, or for Codex (which never
 *  times out into a message) the word that the tool it was allowed after its turn ended has run. */
function relayMessage(ask: BoardAsk): string {
	if (ask.kind !== 'permission') return lateAnswerMessage(ask.answers ?? {});
	if (ask.client === 'codex') return executedMessage(ask.tool!, ask.toolInput!);
	return latePermissionMessage(ask.tool!, ask.toolInput!, ask.decision ?? 'allow', ask.reason);
}

/**
 * Send a message for an ask through the same relay as any text for the agent, once `file` (the
 * late, notified or resend file) was taken for it, so of two devices only one sends. Sent, or the
 * agent read off Herdr's list, `file` is written again with that; not sent this time, `file` is
 * given up again so the user can retry, or the board tries again.
 */
async function relayFor(board: Board, ask: BoardAsk, message: string, file: string): Promise<{ status: number; body: AskAnswerResponse }> {
	const dir = board.config.asksDir;
	relaying.add(ask.id);
	try {
		const relayed = await relayToAgent(board, ask.sessionId, 'board-ask', message);
		if (relayed.outcome === 'failed') rmSync(join(dir, file), { force: true });
		else {
			const taken = readJson(join(dir, file)) as object | null;
			writeWhole(dir, file, { ...taken, outcome: relayed.outcome === 'sent' ? 'relayed' : 'gone', outcome_at: new Date().toISOString() });
		}
		const { reason, logError } = relayed.body;
		if (relayed.outcome === 'sent') return { status: 200, body: { status: 'accepted', reason: null, logError } };
		return { status: relayed.status, body: { status: relayed.outcome === 'gone' ? 'agent_gone' : 'error', reason, logError } };
	} finally {
		relaying.delete(ask.id);
		void board.refresh();
	}
}

/** Write an attempt the board did not act on, or handed to the hook, in the asking agent's
 *  operation record, and answer the page with it. */
async function logAttempt(board: Board, ask: BoardAsk, text: string, taken: boolean): Promise<{ status: number; body: AskAnswerResponse }> {
	const agent = (await board.current()).agents.find((candidate) => candidate.id === ask.sessionId);
	const entry: AgentAction = {
		id: randomUUID(),
		kind: 'agent-action',
		action: 'board-ask',
		time: new Date().toISOString(),
		agentId: ask.sessionId,
		name: agent?.name ?? '',
		route: null,
		pane: agent?.herdr.pane ?? null,
		text,
		ok: taken,
		error: taken ? null : ASK_TAKEN_REASON
	};
	let logError: string | null = null;
	try {
		appendSent(board.config.stateDir, entry);
	} catch (error) {
		// Taken or not either way; that outcome is what the page must show.
		logError = (error as Error).message;
	}
	board.agentActed(ask.sessionId);
	void board.refresh();
	return taken
		? { status: 200, body: { status: 'accepted', reason: null, logError } }
		: { status: 409, body: { status: 'taken', reason: ASK_TAKEN_REASON, logError } };
}

const findAsk = (board: Board, id: string) => readAsks(board.config.asksDir, { executionWaitMs: board.config.askExecutionWaitMs }).find((candidate) => candidate.id === id);

/**
 * Send again the message of an ask whose message may or may not have gone (`relay_unknown`), as
 * the user asked: the same message through the same relay. Taken once through the resend file, so
 * of two devices only one sends; a resend file left by a board that stopped while sending is taken
 * again, the ask being `relay_unknown` once more.
 */
export async function resendAsk(board: Board, id: string): Promise<{ status: number; body: AskAnswerResponse }> {
	const dir = board.config.asksDir;
	const ask = findAsk(board, id);
	if (!ask) return { status: 404, body: { status: 'gone', reason: '這一題已經不在看板上。', logError: null } };
	const name = `${id}.resend.json`;
	let taken = false;
	try {
		if (ask.state === 'relay_unknown' && !relaying.has(id)) {
			const record: ResendFile = { kind: 'resend', at: new Date().toISOString() };
			taken = claim(dir, name, record);
			if (!taken && !(readJson(join(dir, name)) as ResendFile | null)?.outcome) {
				rmSync(join(dir, name), { force: true });
				taken = claim(dir, name, record);
			}
		}
	} catch (error) {
		return { status: 500, body: { status: 'error', reason: `寫不進共用目錄：${(error as Error).message}`, logError: null } };
	}
	if (taken) return relayFor(board, ask, relayMessage(ask), name);
	return logAttempt(board, ask, ask.kind === 'permission' ? askText(ask) : answersText(ask.answers ?? {}), false);
}

/**
 * Answer a board ask with the user's picks, one per question in order: handed to the hook while it
 * waits, sent as a message once its wait ran out. Either way, taken or not, the attempt goes in the
 * asking agent's operation record as 看板提問; a request that is not an answer to the ask is
 * refused before that.
 */
export async function answerAsk(board: Board, id: string, picks: AskPick[]): Promise<{ status: number; body: AskAnswerResponse }> {
	const { config } = board;
	const ask = findAsk(board, id);
	if (!ask) return { status: 404, body: { status: 'gone', reason: '這一題已經不在看板上。', logError: null } };
	const texts = ask.kind === 'question' && picks.length === ask.questions.length && ask.questions.every((question, index) => pickComplete(question, picks[index]))
		? ask.questions.map((question, index) => pickText(question, picks[index]))
		: null;
	if (!texts || texts.some((text) => text === null)) {
		return { status: 400, body: { status: 'invalid', reason: '每一題都要作答，答案才能送出。', logError: null } };
	}
	const answers = Object.fromEntries(ask.questions.map((question, index) => [question.question, texts[index]!]));
	let taken: boolean;
	let late = false;
	try {
		taken = ask.state === 'waiting' && takeAsk(config.asksDir, id, answers, picks);
		// The hook's wait ran out, now or before: the answer goes as a message.
		late = !taken && findAsk(board, id)?.state === 'timed_out';
		if (late) taken = claim(config.asksDir, `${id}.late.json`, { kind: 'answer', answers, picks, at: new Date().toISOString() } satisfies LateFile);
	} catch (error) {
		return { status: 500, body: { status: 'error', reason: `答案寫不進共用目錄：${(error as Error).message}`, logError: null } };
	}
	if (late && taken) return relayFor(board, ask, lateAnswerMessage(answers), `${id}.late.json`);
	return logAttempt(board, ask, answersText(answers), taken);
}

/**
 * Answer a permission ask with allow or deny, and with a deny the user's reason if any: handed to
 * the hook while it waits; once Claude's wait ran out, sent as a message (an allow asks it to try
 * again). Codex's request handed back to its terminal, or answered in Claude's, takes none. The
 * attempt goes in the agent's operation record as for a question.
 */
export async function answerPermission(board: Board, id: string, decision: PermissionDecision, rawReason: string): Promise<{ status: number; body: AskAnswerResponse }> {
	const { config } = board;
	const ask = findAsk(board, id);
	if (!ask) return { status: 404, body: { status: 'gone', reason: '這一題已經不在看板上。', logError: null } };
	if (ask.kind !== 'permission') return { status: 400, body: { status: 'invalid', reason: '這一題不是權限確認。', logError: null } };
	const reason = decision === 'deny' ? rawReason.trim() || null : null;
	let taken: boolean;
	let late = false;
	try {
		taken = ask.state === 'waiting' && takePermission(config.asksDir, id, decision, reason);
		late = !taken && findAsk(board, id)?.state === 'timed_out';
		if (late) taken = claim(config.asksDir, `${id}.late.json`, { kind: 'answer', decision, reason: reason ?? '', at: new Date().toISOString() } satisfies LateFile);
	} catch (error) {
		return { status: 500, body: { status: 'error', reason: `答案寫不進共用目錄：${(error as Error).message}`, logError: null } };
	}
	if (late && taken) return relayFor(board, ask, latePermissionMessage(ask.tool!, ask.toolInput!, decision, reason), `${id}.late.json`);
	return logAttempt(board, ask, decisionText(ask.tool!, ask.toolInput!, decision, reason), taken);
}

/** When the board last tried, and failed, to tell Codex an allowed tool ran, by ask ID. */
const notifyTried = new Map<string, number>();
const NOTIFY_RETRY_MS = 60_000;

/**
 * Tell Codex, through the same relay as any text for it, that each tool it was allowed after its
 * turn ended has now been seen run, once: the notified file is taken first. One that could not be
 * sent (Herdr's list unreadable) is tried again a minute later; one whose agent left Herdr's list
 * reads Agent 已不在.
 */
export async function notifyExecuted(board: Board, now = Date.now()): Promise<void> {
	const dir = board.config.asksDir;
	for (const ask of readAsks(dir, { now, executionWaitMs: board.config.askExecutionWaitMs })) {
		if (ask.state !== 'executed' || relaying.has(ask.id) || now - (notifyTried.get(ask.id) ?? -Infinity) < NOTIFY_RETRY_MS) continue;
		const name = `${ask.id}.notified.json`;
		try {
			if (!claim(dir, name, { at: new Date(now).toISOString() } satisfies NotifiedFile)) continue;
		} catch {
			continue;
		}
		// Set before the send: the refresh it ends with may come back here before it returns.
		notifyTried.set(ask.id, now);
		const sent = await relayFor(board, ask, relayMessage(ask), name);
		if (sent.body.status !== 'error') notifyTried.delete(ask.id);
	}
}
