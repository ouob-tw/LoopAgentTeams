// One text-only turn of the Claude CLI (`claude -p`) started for the one request: the stand-in for a
// Codex turn when Codex's quota has run out (luna-fallback.ts). The prompt goes in as the system
// prompt, the text on standard input; the answer is the `result` of the JSON the CLI prints at the
// end. The default command (config.ts `TEXT_ONLY_CLAUDE`) starts no tools, MCP servers, hooks or skills.
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { CLAUDE_USAGE_LIMIT } from './automation-agent.ts';
import { hide, type Outcome } from './codex-turn.ts';
import { ownEnv } from './hcom.ts';

export interface ClaudeTurn {
	command: string[];
	timeoutMs: number;
	/** The system prompt; it replaces Claude Code's own. */
	system: string;
	/** The user message. */
	input: string;
	/** Taken out of the journal line should the CLI or an error message repeat them. */
	secrets: (string | null | undefined)[];
	/** Starts the journal line of a failure, e.g. `[voice] Haiku tidy`. */
	journal: string;
}

/** How much of the end of the CLI's own error output goes into the journal. */
const STDERR_TAIL = 300;
/** Past this much stderr none of it is logged: a secret cut at the edge could not be found. */
const STDERR_MAX = 1_000_000;
/** How much of the CLI's own error text goes into a failure reason. */
const REASON_MAX = 200;
/** Past this much standard output the turn fails; a one-turn answer is far shorter. */
const STDOUT_MAX = 10_000_000;

function end(child: ChildProcess): void {
	try {
		process.kill(-child.pid!, 'SIGKILL');
	} catch {
		// Already gone.
	}
}

/** The CLI's last answer, as it wrote it. */
export function claudeTurn(turn: ClaudeTurn): Promise<Outcome<string>> {
	const [command, ...args] = turn.command;
	return new Promise((resolve) => {
		const log = (reason: string, ended: string | null, stderr: string) => {
			const clean = (value: string) => hide(turn, value).replace(/\s+/g, ' ').trim();
			const tail = clean(stderr).slice(-STDERR_TAIL);
			console.error(`${turn.journal} failed: ${clean(reason)}${ended ? ` (${ended})` : ''}${tail ? ` stderr: ${tail}` : ''}`);
		};
		let child: ChildProcess;
		try {
			child = spawn(command, [...args, '--system-prompt', turn.system], { cwd: tmpdir(), env: ownEnv(), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
		} catch (error) {
			log((error as Error).message, null, '');
			return resolve({ ok: false, reason: `Haiku 沒有完成：${(error as Error).message}` });
		}
		let settled = false;
		let stdout = '';
		let stderr = '';
		let stderrTooLong = false;
		/** `logged` stands in for the reason in the journal when the reason quotes what the CLI sent. */
		const finish = (outcome: Outcome<string>, ended: string | null = null, logged?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			end(child);
			if (!outcome.ok) log(logged ?? outcome.reason, ended, stderrTooLong ? '' : stderr);
			resolve(outcome);
		};
		const timer = setTimeout(() => finish({ ok: false, reason: `Haiku 逾時（${turn.timeoutMs / 1000} 秒）` }), turn.timeoutMs);
		child.on('error', (error) => finish({ ok: false, reason: `Haiku 沒有完成：${error.message}` }));
		child.stdout!.setEncoding('utf8');
		child.stdout!.on('data', (chunk: string) => {
			stdout += chunk;
			if (stdout.length > STDOUT_MAX) finish({ ok: false, reason: 'Haiku 回應太長' });
		});
		child.stderr!.setEncoding('utf8');
		child.stderr!.on('data', (chunk: string) => {
			if (stderrTooLong) return;
			stderr += chunk;
			if (stderr.length > STDERR_MAX) stderrTooLong = true;
		});
		for (const stream of [child.stdout!, child.stderr!, child.stdin!]) {
			stream.on('error', () => {
				// The exit says why.
			});
		}
		// Not 'exit': that can come before the last of its output is read.
		child.on('close', (code, signal) => {
			const ended = code !== null ? `exit ${code}` : `signal ${signal}`;
			const text = stdout.trim();
			if (!text) return finish({ ok: false, reason: 'Haiku 提前結束' }, ended);
			let answer: { is_error?: unknown; result?: unknown; subtype?: unknown };
			try {
				answer = JSON.parse(text.slice(text.lastIndexOf('\n') + 1));
			} catch {
				return finish({ ok: false, reason: 'Haiku 回應看不懂' }, ended);
			}
			const result = typeof answer.result === 'string' ? answer.result.trim() : '';
			// Claude Code may put its usage-limit notice in place of the answer without marking an error.
			if (answer.is_error === true || code !== 0 || !result || CLAUDE_USAGE_LIMIT.test(result)) {
				const full = result || (answer.is_error === true && typeof answer.subtype === 'string' ? answer.subtype : '沒有回覆');
				const why = full.length > REASON_MAX ? `${full.slice(0, REASON_MAX)}…` : full;
				// Only Claude Code's own error text goes in the journal: a result that is not one may be
				// Haiku's translation or tidied speech, which no secret covers.
				const ownError = answer.is_error === true || CLAUDE_USAGE_LIMIT.test(result) || !result;
				return finish({ ok: false, reason: `Haiku 沒有完成：${why}` }, ended, ownError ? undefined : 'Haiku 沒有完成：結束碼不是 0');
			}
			finish({ ok: true, value: result }, ended);
		});
		child.stdin!.end(turn.input);
	});
}
