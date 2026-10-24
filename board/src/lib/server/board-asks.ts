// The board's side of the shared board-ask folder (format in `hooks/board-ask.py`): reading the
// asks the hook wrote, touching the heartbeat that tells the hook a board runs, taking an ask with
// the user's answer, which only one writer can do, sending an answer that came after the hook's
// deadline as a message, marking asks whose hook was ended in the terminal, and removing asks
// 7 days after they ended.
import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAction } from '../board/agent-actions.ts';
import {
	answersText,
	ASK_INTERRUPTED_REASON,
	ASK_RETENTION_MS,
	ASK_TAKEN_REASON,
	ENDED_ASK_STATES,
	lateAnswerMessage,
	pickComplete,
	pickText,
	type AskAnswerResponse,
	type AskPick,
	type AskQuestion,
	type BoardAsk,
	type BoardAskState
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

interface AskFile {
	id: string;
	client: string;
	session_id: string;
	cwd?: string;
	tool_input: { questions: AskQuestion[] };
	created_at: string;
	deadline_at: string;
	hook_pid?: number;
	outcome: 'filled' | 'timed_out' | null;
	outcome_at?: string | null;
}

type ResultFile =
	| { kind: 'answer'; answers: Record<string, string>; picks?: AskPick[]; at?: string }
	| { kind: 'timeout'; at?: string }
	| { kind: 'interrupted'; at: string };

/** An answer to a timed-out ask: taken once, then written again with what its message came to. */
interface LateFile {
	kind: 'answer';
	answers: Record<string, string>;
	picks: AskPick[] | null;
	at: string;
	outcome?: 'relayed' | 'gone';
	outcome_at?: string;
}

function isAsk(value: unknown): value is AskFile {
	const ask = value as Partial<AskFile> | null;
	return (
		typeof ask?.id === 'string' &&
		typeof ask.session_id === 'string' &&
		typeof ask.client === 'string' &&
		Array.isArray(ask.tool_input?.questions) &&
		ask.tool_input.questions.every((question) => typeof question?.question === 'string' && Array.isArray(question.options)) &&
		typeof ask.created_at === 'string' &&
		typeof ask.deadline_at === 'string'
	);
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

function stateOf(ask: AskFile, result: ResultFile | null, late: LateFile | null, resend: ResendFile | null): BoardAskState {
	if (result?.kind === 'interrupted') return 'interrupted';
	if (result?.kind === 'timeout') {
		if (late?.outcome) return late.outcome;
		if (!late) return 'timed_out';
		if (relaying.has(ask.id)) return 'relaying';
		return resend?.outcome ?? 'relay_unknown';
	}
	if (result?.kind === 'answer') return ask.outcome === 'filled' ? 'filled' : 'answered';
	return 'waiting';
}

function endedAt(state: BoardAskState, ask: AskFile, result: ResultFile | null, late: LateFile | null, resend: ResendFile | null): string | null {
	if (!ENDED_ASK_STATES.has(state)) return null;
	if (state === 'filled') return ask.outcome_at ?? result?.at ?? ask.created_at;
	if (state === 'interrupted') return result?.at ?? ask.created_at;
	return resend?.outcome_at ?? late?.outcome_at ?? late?.at ?? ask.created_at;
}

/** Every ask in the folder that can be read, oldest first; a folder that does not exist holds none. */
export function readAsks(dir: string): BoardAsk[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const asks: BoardAsk[] = [];
	for (const name of names) {
		if (!isAskFile(name) || name.endsWith('.result.json')) continue;
		const ask = readJson(join(dir, name));
		if (!isAsk(ask) || `${ask.id}.json` !== name) continue;
		const result = readJson(join(dir, `${ask.id}.result.json`)) as ResultFile | null;
		const late = result?.kind === 'timeout' ? (readJson(join(dir, `${ask.id}.late.json`)) as LateFile | null) : null;
		const resend = late && !late.outcome ? (readJson(join(dir, `${ask.id}.resend.json`)) as ResendFile | null) : null;
		const state = stateOf(ask, result, late, resend);
		const taken = result?.kind === 'answer' ? result : late;
		asks.push({
			id: ask.id,
			sessionId: ask.session_id,
			client: ask.client,
			kind: 'question',
			tool: null,
			folder: typeof ask.cwd === 'string' && ask.cwd ? ask.cwd : null,
			questions: ask.tool_input.questions,
			createdAt: ask.created_at,
			deadlineAt: ask.deadline_at,
			state,
			endedAt: endedAt(state, ask, result, late, resend),
			answers: taken ? taken.answers : null,
			picks: taken && Array.isArray(taken.picks) ? taken.picks : null
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

/**
 * Bring the folder up to date before it is read: an ask whose hook process is gone with nothing
 * taken was ended in the terminal (Esc, or the agent closed), so it is taken as interrupted, takes
 * no answer, and goes in its agent's operation record; an ask that ended at least 7 days ago is
 * removed with its files. `agents` are the agents as listed now, for the record's name and pane.
 */
export function settleAsks(config: Pick<BoardConfig, 'asksDir' | 'stateDir'>, agents: Agent[], now = Date.now()): void {
	const dir = config.asksDir;
	for (const ask of readAsks(dir)) {
		if (ask.endedAt !== null && now - Date.parse(ask.endedAt) >= ASK_RETENTION_MS) {
			for (const suffix of ['.json', '.result.json', '.late.json', '.resend.json']) rmSync(join(dir, `${ask.id}${suffix}`), { force: true });
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
		if (!interrupted) continue;
		const agent = agents.find((candidate) => candidate.id === ask.sessionId);
		try {
			appendSent(config.stateDir, {
				id: randomUUID(),
				kind: 'agent-action',
				action: 'board-ask',
				time: new Date(now).toISOString(),
				agentId: ask.sessionId,
				name: agent?.name ?? '',
				route: null,
				pane: agent?.herdr.pane ?? null,
				text: ask.questions.map((question) => question.question).join('\n'),
				ok: false,
				error: ASK_INTERRUPTED_REASON
			});
		} catch {
			// The card says it all the same.
		}
	}
}

/** Take a timed-out ask with an answer to send as a message: true when this call did. */
function takeLate(dir: string, id: string, answers: Record<string, string>, picks: AskPick[]): boolean {
	const name = `${id}.late.json`;
	return claim(dir, name, { kind: 'answer', answers, picks, at: new Date().toISOString() } satisfies LateFile);
}

/**
 * Send an answer to a timed-out ask as a message, through the same relay as any text for the agent,
 * once `file` (the late file, or the resend file) was taken for it, so of two devices only one
 * sends. Sent, or the agent read off Herdr's list, `file` is written again with that; not sent this
 * time, `file` is given up again so the user can retry.
 */
async function relayLate(board: Board, ask: BoardAsk, answers: Record<string, string>, file: string): Promise<{ status: number; body: AskAnswerResponse }> {
	const dir = board.config.asksDir;
	relaying.add(ask.id);
	try {
		const relayed = await relayToAgent(board, ask.sessionId, 'board-ask', lateAnswerMessage(answers));
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

/**
 * Send again the late answer of an ask whose message may or may not have gone (`relay_unknown`),
 * as the user asked: the same message through the same relay. Taken once through the resend file,
 * so of two devices only one sends; a resend file left by a board that stopped while sending is
 * taken again, the ask being `relay_unknown` once more.
 */
export async function resendAsk(board: Board, id: string): Promise<{ status: number; body: AskAnswerResponse }> {
	const dir = board.config.asksDir;
	const ask = readAsks(dir).find((candidate) => candidate.id === id);
	if (!ask) return { status: 404, body: { status: 'gone', reason: '這一題已經不在看板上。', logError: null } };
	const answers = ask.answers ?? {};
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
	if (taken) return relayLate(board, ask, answers, name);
	return logAttempt(board, ask, answersText(answers), false);
}

/**
 * Answer a board ask with the user's picks, one per question in order: handed to the hook while it
 * waits, sent as a message once its wait ran out. Either way, taken or not, the attempt goes in the
 * asking agent's operation record as 看板提問; a request that is not an answer to the ask is
 * refused before that.
 */
export async function answerAsk(board: Board, id: string, picks: AskPick[]): Promise<{ status: number; body: AskAnswerResponse }> {
	const { config } = board;
	const ask = readAsks(config.asksDir).find((candidate) => candidate.id === id);
	if (!ask) return { status: 404, body: { status: 'gone', reason: '這一題已經不在看板上。', logError: null } };
	const texts = picks.length === ask.questions.length && ask.questions.every((question, index) => pickComplete(question, picks[index]))
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
		late = !taken && readAsks(config.asksDir).find((candidate) => candidate.id === id)?.state === 'timed_out';
		if (late) taken = takeLate(config.asksDir, id, answers, picks);
	} catch (error) {
		return { status: 500, body: { status: 'error', reason: `答案寫不進共用目錄：${(error as Error).message}`, logError: null } };
	}
	if (late && taken) return relayLate(board, ask, answers, `${id}.late.json`);
	return logAttempt(board, ask, answersText(answers), taken);
}
