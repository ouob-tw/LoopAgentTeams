// The board's side of the shared board-ask folder (format in `hooks/board-ask.py`): reading the
// asks the hook wrote, touching the heartbeat that tells the hook a board runs, and taking an ask
// with the user's answer, which only one writer can do.
import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAction } from '../board/agent-actions.ts';
import {
	answersText,
	ASK_TAKEN_REASON,
	pickComplete,
	pickText,
	type AskAnswerResponse,
	type AskPick,
	type AskQuestion,
	type BoardAsk,
	type BoardAskState
} from '../board/board-asks.ts';
import type { Board } from './board.ts';
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
	tool_input: { questions: AskQuestion[] };
	created_at: string;
	deadline_at: string;
	outcome: 'filled' | 'timed_out' | null;
}

type ResultFile = { kind: 'answer'; answers: Record<string, string>; picks?: AskPick[] } | { kind: 'timeout' };

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

function stateOf(ask: AskFile, result: ResultFile | null): BoardAskState {
	if (result?.kind === 'timeout') return 'timed_out';
	if (result?.kind === 'answer') return ask.outcome === 'filled' ? 'filled' : 'answered';
	return 'waiting';
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
		asks.push({
			id: ask.id,
			sessionId: ask.session_id,
			client: ask.client,
			questions: ask.tool_input.questions,
			createdAt: ask.created_at,
			deadlineAt: ask.deadline_at,
			state: stateOf(ask, result),
			answers: result?.kind === 'answer' ? result.answers : null,
			picks: result?.kind === 'answer' && Array.isArray(result.picks) ? result.picks : null
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

/** Take the ask with these answers, and the picks they came from for the board to show: true when
 *  this call did, false when someone (another device, or the hook at its deadline) took it first.
 *  The file is written whole and then linked into place, which fails when it exists. */
export function takeAsk(dir: string, id: string, answers: Record<string, string>, picks: AskPick[] | null = null): boolean {
	if (!safeId(id)) throw new Error(`ask ID ${id} 不能當檔名`);
	const result = join(dir, `${id}.result.json`);
	const temporary = join(dir, `.${id}.result.${randomUUID()}.tmp`);
	writeFileSync(temporary, JSON.stringify({ kind: 'answer', answers, picks, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
	try {
		linkSync(temporary, result);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
		throw error;
	} finally {
		rmSync(temporary, { force: true });
	}
}

/**
 * Answer a waiting board ask with the user's picks, one per question in order. Taken or not, the
 * attempt goes in the asking agent's operation record as 看板提問; a request that is not an answer
 * to the ask is refused before that.
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
	try {
		taken = ask.state === 'waiting' && takeAsk(config.asksDir, id, answers, picks);
	} catch (error) {
		return { status: 500, body: { status: 'error', reason: `答案寫不進共用目錄：${(error as Error).message}`, logError: null } };
	}
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
		text: answersText(answers),
		ok: taken,
		error: taken ? null : ASK_TAKEN_REASON
	};
	let logError: string | null = null;
	try {
		appendSent(config.stateDir, entry);
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
