// Keeping a Claude session's permission mode across a resume. Claude does not take the mode back
// from its record when it resumes: it starts in the one its arguments give, or else the user's
// default. hcom repeats the arguments it stored for the session's last launch and adds the
// board's after them, and those lack the mode of a session started outside hcom, or changed in it
// since. So the board adds `--permission-mode` with the mode the record last had, unless the
// stored arguments give that mode already. `--dangerously-skip-permissions` wins over any
// `--permission-mode`, wherever it comes, and hcom has no way to leave a stored argument out: a
// session stored with it that was in another mode gets a setting that turns bypass permissions
// off as well (`DISABLE_BYPASS`; the user chose that, TOSE-262-AC4), so it cannot be switched
// into it in that session either (Claude Code 2.1.308).
import type { BoardConfig } from './config.ts';
import { storedLaunchArgs } from './hcom.ts';
import { readTranscript } from './helper.ts';

/** The modes `claude --permission-mode` takes, and `default`, which its record writes for `manual`. */
const MODES = new Set(['acceptEdits', 'auto', 'bypassPermissions', 'default', 'manual', 'dontAsk', 'plan']);

/** The settings that make `--permission-mode` win over `--dangerously-skip-permissions`. */
const DISABLE_BYPASS = '{"permissions":{"disableBypassPermissionsMode":"disable"}}';

/** The value the last `name` option of these arguments gives, as `name value` or `name=value`;
 *  null when they give none. */
function lastValue(args: readonly string[], name: string): string | null {
	let value: string | null = null;
	args.forEach((arg, index) => {
		if (arg === name) value = args[index + 1] ?? null;
		else if (arg.startsWith(`${name}=`)) value = arg.slice(name.length + 1);
	});
	return value;
}

/** Whether these launch arguments turn bypass permissions off for the session, so Shift+Tab never
 *  reaches it. */
export const bypassTurnedOff = (args: readonly string[]) => lastValue(args, '--settings') === DISABLE_BYPASS;

/** What to add to the stored arguments so a resume starts in `mode`: nothing when they give it
 *  already or the mode is not known; for a mode other than bypass permissions, which the stored
 *  bypass flag forces, the setting that turns it off too. */
export function permissionArgs(stored: readonly string[], mode: string | null): string[] {
	if (mode === null || !MODES.has(mode)) return [];
	const forced = stored.includes('--dangerously-skip-permissions');
	if (forced && mode === 'bypassPermissions') return [];
	const disable = forced && lastValue(stored, '--settings') !== DISABLE_BYPASS ? ['--settings', DISABLE_BYPASS] : [];
	return lastValue(stored, '--permission-mode') === mode && !disable.length ? [] : [...disable, '--permission-mode', mode];
}

/** The arguments that keep this session's permission mode on a resume: none but for Claude.
 *  Stored arguments that cannot be read count as none, which at worst repeats the mode they give. */
export async function keepPermission(config: BoardConfig, client: string, sessionId: string): Promise<string[]> {
	if (client !== 'claude') return [];
	const read = await readTranscript(config, client, sessionId);
	const permission = read.ok ? read.page.usage?.permission : null;
	const mode = permission && 'mode' in permission ? permission.mode : null;
	if (mode === null) return [];
	return permissionArgs((await storedLaunchArgs(config, sessionId)) ?? [], mode);
}
