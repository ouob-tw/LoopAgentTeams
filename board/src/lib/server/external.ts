// Runs the outside commands the board starts controllers with (hcom, Herdr, git). Every one is
// given as an argument list from the config, so tests can put fakes in their place.
import { execFile } from 'node:child_process';

export interface ExternalResult {
	/** The exit code; null when the command did not exit by itself or could not start. */
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	/** Why it did not succeed, in the command's own words where it gave any; null when it exited 0. */
	failure: string | null;
}

const firstLine = (text: string) => text.trim().split('\n')[0] ?? '';
const lastLine = (text: string) => text.trim().split('\n').at(-1) ?? '';

export function runExternal(
	command: string[],
	args: string[],
	options: { timeoutMs: number; env?: NodeJS.ProcessEnv; cwd?: string }
): Promise<ExternalResult> {
	const [program, ...prefix] = command;
	return new Promise((resolve) => {
		try {
			execFile(
				program,
				[...prefix, ...args],
				{ timeout: options.timeoutMs, env: options.env, cwd: options.cwd, maxBuffer: 16 * 1024 * 1024 },
				(error, stdout, stderr) => {
					if (!error) return resolve({ code: 0, stdout, stderr, timedOut: false, failure: null });
					const timedOut = error.killed === true && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
					const code = typeof error.code === 'number' ? error.code : null;
					const failure = timedOut
						? `逾時（${options.timeoutMs / 1000} 秒）`
						: lastLine(stderr) || firstLine(stdout) || error.message;
					resolve({ code, stdout, stderr, timedOut, failure });
				}
			);
		} catch (error) {
			// An argument that cannot be passed to a command at all, such as one holding a NUL character.
			resolve({ code: null, stdout: '', stderr: '', timedOut: false, failure: (error as Error).message });
		}
	});
}
