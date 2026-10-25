// Runs the outside commands the board reads and acts through (the panel helper, hcom, Herdr,
// claude-swap, the input command, git). They are argument lists from the config, so tests put
// fakes in their place; tests run the real `git init`, in temporary folders only.
import { spawn, type ChildProcess } from 'node:child_process';

export interface ExternalResult {
	/** The exit code; null when the command did not exit by itself or could not start. */
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	/** Why it did not succeed, in the command's own words where it gave any; null when it exited 0. */
	failure: string | null;
	/** How it ended when it did not succeed: it exited (by itself or by a signal from outside), ran
	 *  out of time, was aborted, printed too much, or could not start. Null when it exited 0. */
	ended: 'exit' | 'timeout' | 'aborted' | 'too-large' | 'not-started' | null;
	/** The signal that ended it, when one did. */
	signal: NodeJS.Signals | null;
}

interface RunOptions {
	timeoutMs: number;
	/** Bytes each of standard output and error may hold; 16 MB unless given. */
	maxBuffer?: number;
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	/** Aborting it ends the command as running out of time does. */
	signal?: AbortSignal;
	/** Run the command as its own process group and end the whole group with SIGKILL, for a
	 *  wrapper (`uv run`) whose child would otherwise keep running. Otherwise only the command
	 *  itself gets SIGTERM. */
	killGroup?: boolean;
	/** Which of its words a command that failed gives as the reason, the other stream's being the
	 *  fallback: the last line of standard error (the default), or the first line of standard
	 *  output, for a command that prints its reason there and only notices on standard error. */
	failureFrom?: 'stderr-last' | 'stdout-first';
	/** Gets all of standard output so far each time more of it comes, while the command runs. */
	onStdout?: (stdout: string) => void;
}

const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

const firstLine = (text: string) => text.trim().split('\n')[0] ?? '';
const lastLine = (text: string) => text.trim().split('\n').at(-1) ?? '';

export function runCommand(command: string[], args: string[], options: RunOptions): Promise<ExternalResult> {
	const [program, ...prefix] = command;
	const argv = [...prefix, ...args];
	const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
	const { signal } = options;
	return new Promise((resolve) => {
		let child: ChildProcess;
		try {
			child = spawn(program, argv, {
				env: options.env,
				cwd: options.cwd,
				detached: options.killGroup === true,
				stdio: ['ignore', 'pipe', 'pipe']
			});
		} catch (error) {
			// An argument that cannot be passed to a command at all, such as one holding a NUL character.
			const failure = (error as Error).message;
			return resolve({ code: null, stdout: '', stderr: '', timedOut: false, failure, ended: 'not-started', signal: null });
		}
		const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
		const bytes = { stdout: 0, stderr: 0 };
		let stopped: { ended: 'timeout' | 'aborted' | 'too-large'; failure: string } | null = null;
		let settled = false;
		const text = (stream: 'stdout' | 'stderr') => Buffer.concat(output[stream]).toString('utf8');
		const kill = () => {
			try {
				if (options.killGroup) process.kill(-child.pid!, 'SIGKILL');
				else child.kill();
			} catch {
				// Already gone.
			}
		};
		const stop = (ended: 'timeout' | 'aborted' | 'too-large', failure: string) => {
			stopped ??= { ended, failure };
			kill();
		};
		const onAbort = () => stop('aborted', '已取消');
		const finish = (result: ExternalResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
			resolve(result);
		};
		for (const stream of ['stdout', 'stderr'] as const) {
			child[stream]!.on('data', (chunk: Buffer) => {
				if (bytes[stream] > maxBuffer) return;
				bytes[stream] += chunk.length;
				if (bytes[stream] <= maxBuffer) {
					output[stream].push(chunk);
					if (stream === 'stdout') options.onStdout?.(text('stdout'));
					return;
				}
				stop('too-large', `輸出過大（${stream} 超過 ${maxBuffer / 1024 / 1024} MB）`);
			});
		}
		const timer = setTimeout(() => stop('timeout', `逾時（${options.timeoutMs / 1000} 秒）`), options.timeoutMs);
		child.on('error', (error) => {
			// A command that could not start may never close.
			finish({ code: null, stdout: text('stdout'), stderr: text('stderr'), timedOut: false, failure: error.message, ended: 'not-started', signal: null });
		});
		child.on('close', (code, killedBy) => {
			const stdout = text('stdout');
			const stderr = text('stderr');
			const base = { code: stopped ? null : code, stdout, stderr, signal: killedBy };
			if (stopped) return finish({ ...base, timedOut: stopped.ended === 'timeout', failure: stopped.failure, ended: stopped.ended });
			if (code === 0) return finish({ ...base, timedOut: false, failure: null, ended: null });
			const said = options.failureFrom === 'stdout-first' ? firstLine(stdout) || lastLine(stderr) : lastLine(stderr) || firstLine(stdout);
			// As `execFile` words a command that failed without a word of its own.
			const failure = said || `Command failed: ${[program, ...argv].join(' ')}\n${stderr}`;
			finish({ ...base, timedOut: false, failure, ended: 'exit' });
		});
		if (!signal || child.pid === undefined) return;
		if (signal.aborted) onAbort();
		else signal.addEventListener('abort', onAbort, { once: true });
	});
}

/** What a command printed as JSON, or why there is none: the command's own failure, or else
 *  `fallbackReason` for output that is not JSON. The value is not checked beyond being JSON. */
export function parseJsonOutput<T>(
	run: { stdout: string; failure: string | null },
	fallbackReason: string
): { ok: true; value: T } | { ok: false; reason: string } {
	try {
		return { ok: true, value: JSON.parse(run.stdout) as T };
	} catch {
		return { ok: false, reason: run.failure ?? fallbackReason };
	}
}
