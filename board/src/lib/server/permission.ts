// Keeping a Claude session's permission mode across a resume. Claude does not take the mode back
// from its record when it resumes: it starts in the one its arguments give, or else the user's
// default. hcom repeats the arguments it stored for the session's last launch and adds the
// board's after them, and those lack the mode of a session started outside hcom, or changed in it
// since. So the board adds `--permission-mode` with the mode the record last had, unless the
// stored arguments give that mode already. `--dangerously-skip-permissions` wins over any
// `--permission-mode`, wherever it comes: a session stored with it comes back in bypass
// permissions whatever is added.
import type { BoardConfig } from './config.ts';
import { storedLaunchArgs } from './hcom.ts';
import { readTranscript } from './helper.ts';

/** The modes `claude --permission-mode` takes, and `default`, which its record writes for `manual`. */
const MODES = new Set(['acceptEdits', 'auto', 'bypassPermissions', 'default', 'manual', 'dontAsk', 'plan']);

/** The mode the last `--permission-mode` of these arguments gives; null when they give none. */
function argsMode(args: readonly string[]): string | null {
	let mode: string | null = null;
	args.forEach((arg, index) => {
		if (arg === '--permission-mode') mode = args[index + 1] ?? null;
		else if (arg.startsWith('--permission-mode=')) mode = arg.slice('--permission-mode='.length);
	});
	return mode;
}

/** What to add to the stored arguments so a resume starts in `mode`: nothing when they give it
 *  already, when the mode is not known, or when they hold the bypass flag no argument overrides. */
export function permissionArgs(stored: readonly string[], mode: string | null): string[] {
	if (mode === null || !MODES.has(mode)) return [];
	if (stored.includes('--dangerously-skip-permissions') || argsMode(stored) === mode) return [];
	return ['--permission-mode', mode];
}

/** The arguments that keep this session's permission mode on a resume: none but for Claude. The
 *  stored arguments are hcom's for the session unless given; ones that cannot be read count as
 *  none, which at worst repeats the mode they give. */
export async function keepPermission(config: BoardConfig, client: string, sessionId: string, stored?: readonly string[]): Promise<string[]> {
	if (client !== 'claude') return [];
	const read = await readTranscript(config, client, sessionId);
	const permission = read.ok ? read.page.usage?.permission : null;
	const mode = permission && 'mode' in permission ? permission.mode : null;
	if (mode === null) return [];
	return permissionArgs(stored ?? (await storedLaunchArgs(config, sessionId)) ?? [], mode);
}
