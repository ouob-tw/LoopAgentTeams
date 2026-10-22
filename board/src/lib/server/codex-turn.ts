// One turn of a Codex app server started for the one request: speech tidying and transcript
// translation both ask Codex this way. The server speaks JSON-RPC over standard input and output;
// the thread is ephemeral, read-only, never asks for approval and starts none of Codex's MCP servers.
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { ownEnv } from './hcom.ts';

export type Outcome<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface CodexTurn {
	command: string[];
	timeoutMs: number;
	model: string;
	effort: string;
	/** The thread's developer instructions. */
	instructions: string;
	/** Replaces Codex's own coding-agent instructions for the thread when given. */
	baseInstructions?: string;
	/** Told the agent message so far each time Codex adds to it, before the turn ends. */
	onText?: (text: string) => void;
	/** The user message. */
	input: string;
	/** Taken out of the journal line should the child or an error message repeat them. */
	secrets: (string | null | undefined)[];
	/** Starts the journal line of a failure, e.g. `[voice] Codex tidy`. */
	journal: string;
}

/** End a Codex app server and everything it started. */
function end(child: ChildProcess): void {
	try {
		process.kill(-child.pid!, 'SIGKILL');
	} catch {
		// Already gone.
	}
}

/** How much of the end of Codex's own error output goes into the journal. */
const STDERR_TAIL = 300;
/** The least kept of stderr while reading. */
const STDERR_KEPT = 16_384;

/** Mark original character ranges before replacing anything, so overlaps cannot hide a match. */
function markSecrets(value: string, secrets: CodexTurn['secrets'], hidden: boolean[]): void {
	for (const secret of secrets) {
		if (!secret) continue;
		for (let at = value.indexOf(secret); at >= 0; at = value.indexOf(secret, at + 1)) hidden.fill(true, at, at + secret.length);
	}
}

/** The value with every secret taken out. */
function hide(turn: CodexTurn, value: string): string {
	const hidden = Array<boolean>(value.length).fill(false);
	markSecrets(value, turn.secrets, hidden);
	let clean = '';
	for (let at = 0; at < value.length; at++) {
		if (!hidden[at]) clean += value[at];
		else if (at === 0 || !hidden[at - 1]) clean += '…';
	}
	return clean;
}

/** One journal line for a failed turn: why, how the child ended, and the tail of what it wrote to stderr. */
function logFailure(turn: CodexTurn, reason: string, ended: string | null, stderr: string): void {
	const clean = (value: string) => hide(turn, value).replace(/\s+/g, ' ').trim();
	const tail = clean(stderr).slice(-STDERR_TAIL);
	console.error(`${turn.journal} failed: ${clean(reason)}${ended ? ` (${ended})` : ''}${tail ? ` stderr: ${tail}` : ''}`);
}

/** Codex's last agent message of the turn, as it wrote it. */
export function codexTurn(turn: CodexTurn): Promise<Outcome<string>> {
	const [command, ...args] = turn.command;
	return new Promise((resolve) => {
		let child: ChildProcess;
		try {
			child = spawn(command, args, { cwd: tmpdir(), env: ownEnv(), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
		} catch (error) {
			logFailure(turn, (error as Error).message, null, '');
			return resolve({ ok: false, reason: (error as Error).message });
		}
		let settled = false;
		let ended: string | null = null;
		let stderr = '';
		let pendingStderr = '';
		let hidden: boolean[] = [];
		let lastHidden = false;
		const secrets = turn.secrets.filter((secret): secret is string => !!secret).sort((a, b) => b.length - a.length);
		const longest = secrets[0]?.length ?? 0;
		/** Keep the final longest-secret window raw, so future chunks can complete overlapping
		 *  secrets. Marked characters stay marked even after their matching prefix was emitted. */
		const flushStderr = (final: boolean) => {
			markSecrets(pendingStderr, secrets, hidden);
			const count = final ? pendingStderr.length : Math.max(0, pendingStderr.length - longest);
			for (let at = 0; at < count; at++) {
				if (!hidden[at]) stderr += pendingStderr[at];
				else if (!lastHidden) stderr += '…';
				lastHidden = hidden[at];
			}
			stderr = stderr.slice(-STDERR_KEPT);
			pendingStderr = pendingStderr.slice(count);
			hidden = hidden.slice(count);
		};
		/** `logged` stands in for the reason in the journal when the reason quotes what Codex sent. */
		const finish = (outcome: Outcome<string>, logged?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			end(child);
			if (!outcome.ok) {
				flushStderr(true);
				logFailure(turn, logged ?? outcome.reason, ended, stderr);
			}
			resolve(outcome);
		};
		const timer = setTimeout(() => finish({ ok: false, reason: `Codex 逾時（${turn.timeoutMs / 1000} 秒）` }), turn.timeoutMs);
		child.on('error', (error) => finish({ ok: false, reason: error.message }));
		// Not 'exit': that can come before its last lines are read.
		child.on('close', (code, signal) => {
			ended = code !== null ? `exit ${code}` : `signal ${signal}`;
			finish({ ok: false, reason: 'Codex 提前結束' });
		});
		// Decode as it comes, so a character split between chunks does not break a secret.
		child.stderr!.setEncoding('utf8');
		child.stderr!.on('data', (chunk: string) => {
			pendingStderr += chunk;
			hidden = hidden.concat(Array<boolean>(chunk.length).fill(false));
			flushStderr(false);
		});
		child.stderr!.on('error', () => {
			// The exit says why.
		});
		child.stdin!.on('error', () => {
			// The exit says why.
		});

		let lastId = 0;
		const waiting = new Map<number, (result: { result?: Record<string, unknown>; error?: { message?: string } }) => void>();
		const write = (message: object) => child.stdin!.write(JSON.stringify(message) + '\n');
		/** An `optional` request that fails is answered with nothing instead of failing the turn. */
		const request = (method: string, params: object, optional = false) =>
			new Promise<Record<string, unknown>>((answered) => {
				const id = ++lastId;
				waiting.set(id, (reply) =>
					reply.error || !reply.result
						? optional
							? answered({})
							: finish({ ok: false, reason: `Codex ${method}：${reply.error?.message ?? '沒有結果'}` })
						: answered(reply.result)
				);
				write({ id, method, params });
			});

		/** The last agent message so far; a finished turn may also list it. */
		let reply: string | undefined;
		/** The agent message being written, as its deltas came. */
		let streaming = { item: '', text: '' };
		const read = (line: string) => {
			// Lines after the end, read from the same chunk, change nothing.
			if (settled) return;
			const message: { id?: number; method?: string; params?: Record<string, any>; result?: Record<string, unknown>; error?: { message?: string } } = JSON.parse(line);
			if (message.method === undefined && message.id !== undefined) return waiting.get(message.id)?.(message);
			// A request of its own, such as an approval; nothing here can answer one.
			if (message.id !== undefined) return void write({ id: message.id, error: { code: -32601, message: 'not supported' } });
			if (message.method === 'item/agentMessage/delta' && turn.onText) {
				if (message.params?.itemId !== streaming.item) streaming = { item: message.params?.itemId, text: '' };
				streaming.text += message.params?.delta ?? '';
				turn.onText(streaming.text);
			}
			if (message.method === 'item/completed' && message.params?.item?.type === 'agentMessage') reply = message.params.item.text;
			if (message.method !== 'turn/completed') return;
			const done = message.params?.turn as { status: string; error: { message?: string } | null; items?: { type: string; text?: string }[] };
			const text = (done.items?.findLast((item) => item.type === 'agentMessage')?.text ?? reply)?.trim();
			if (done.status === 'completed' && text) finish({ ok: true, value: text });
			else finish({ ok: false, reason: `Codex 沒有完成：${done.error?.message ?? done.status}` });
		};
		createInterface({ input: child.stdout! }).on('line', (line) => {
			try {
				read(line);
			} catch (error) {
				finish({ ok: false, reason: `Codex 回應看不懂：${(error as Error).message}` }, 'Codex 回應看不懂');
			}
		});

		void (async () => {
			await request('initialize', { clientInfo: { name: 'lat-board', title: 'LAT 看板', version: '1' }, capabilities: null });
			write({ method: 'initialized' });
			// Each MCP server Codex is set up with would start, and be waited for, on every turn.
			const { config } = (await request('config/read', { cwd: tmpdir() }, true)) as { config?: { mcp_servers?: Record<string, unknown> | null } };
			const started = await request('thread/start', {
				ephemeral: true,
				model: turn.model,
				cwd: tmpdir(),
				sandbox: 'read-only',
				approvalPolicy: 'never',
				config: Object.fromEntries(Object.keys(config?.mcp_servers ?? {}).map((name) => [`mcp_servers.${name}.enabled`, false])),
				...(turn.baseInstructions === undefined ? {} : { baseInstructions: turn.baseInstructions }),
				developerInstructions: turn.instructions
			});
			const threadId = (started.thread as { id: string }).id;
			await request('turn/start', { threadId, model: turn.model, effort: turn.effort, input: [{ type: 'text', text: turn.input, text_elements: [] }] });
		})().catch((error: Error) => finish({ ok: false, reason: `Codex 回應看不懂：${error.message}` }, 'Codex 回應看不懂'));
	});
}
