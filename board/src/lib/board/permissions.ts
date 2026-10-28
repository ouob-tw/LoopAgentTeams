// Switching an agent's permission mode from its page: the three modes the board offers each client,
// how Claude's screen shows its mode, and the arguments that put a Codex session in one. Shared by
// the server and the page.
//
// Claude is never restarted for it: the board presses Shift+Tab in its pane and reads the mode line
// under its input box after each press, until the line shows the target (Claude Code 2.1.312 goes
// bypass permissions → auto mode → manual mode → accept edits → plan mode → bypass permissions,
// leaving out the ones the session cannot use). Codex is stopped and its conversation resumed with
// the mode's `-c` overrides, which put in the session's `turn_context` what its `/permissions`
// menu does for the same item (codex-cli 0.164.0, `.lat/runs/issue-360/codex-permissions-baseline.md`).

/** The Claude modes the board switches to. `manual` is what Claude Code calls `default` now. */
export const CLAUDE_MODES = ['bypassPermissions', 'auto', 'manual'] as const;
export type ClaudeMode = (typeof CLAUDE_MODES)[number];

/** Every mode Claude's mode line can show, the ones the board passes through included. */
export type ClaudeScreenMode = ClaudeMode | 'acceptEdits' | 'plan';

/** As Claude's mode line words them, e.g. `⏵⏵ auto mode on`. */
const SCREEN_WORDS: Record<ClaudeScreenMode, string> = {
	bypassPermissions: 'bypass permissions',
	auto: 'auto mode',
	manual: 'manual mode',
	acceptEdits: 'accept edits',
	plan: 'plan mode'
};

export const CLAUDE_MODE_LABEL: Record<ClaudeScreenMode, string> = SCREEN_WORDS;

/** The Codex modes, named as its `/permissions` menu names them. */
export const CODEX_MODES = ['full-access', 'approve-for-me', 'ask-for-approval'] as const;
export type CodexMode = (typeof CODEX_MODES)[number];

export const CODEX_MODE_LABEL: Record<CodexMode, string> = {
	'full-access': 'Full Access',
	'approve-for-me': 'Approve for me',
	'ask-for-approval': 'Ask for approval'
};

export const isClaudeMode = (value: unknown): value is ClaudeMode => (CLAUDE_MODES as readonly unknown[]).includes(value);
export const isCodexMode = (value: unknown): value is CodexMode => (CODEX_MODES as readonly unknown[]).includes(value);

/** What Claude's screen says: its mode, or why it is not read (then no key is pressed). */
export type ScreenRead = { mode: ClaudeScreenMode } | { mode: null; reason: string };

export const SCREEN_NO_INPUT_REASON = '畫面上沒有 Claude 的輸入框，可能正在顯示確認視窗或選單，沒有按鍵';
export const SCREEN_DIALOG_REASON = '畫面正在顯示選項（確認視窗或選單），沒有按鍵';
export const SCREEN_NO_MODE_REASON = '輸入框下方讀不到權限模式的提示（可能正在顯示選單），沒有按鍵';

const RULE = /^\s*─{8,}\s*$/;
const MODE_LINE = /(?:⏵⏵|⏸)\s+(bypass permissions|auto mode|manual mode|accept edits|plan mode) on\b/;
/** A numbered choice with the cursor on it, as Claude's dialogs and menus show one. */
const CHOICE = /^\s*[❯›>]\s*\d+\.\s/;

/**
 * The mode Claude's screen shows, from what `herdr pane read --source visible` prints: the line
 * under its input box (the `❯` line between two rules) that reads `⏵⏵ … on` or `⏸ … on`. A screen
 * with no input box at its bottom, a numbered choice from the box down, or no mode line under the
 * box is not read: a dialog or a menu is open, and a key could answer it. A numbered list higher
 * up is the conversation's.
 */
export function readClaudeScreen(screen: string): ScreenRead {
	const lines = screen.split('\n');
	const choice = (from: number) => lines.slice(from).some((line) => CHOICE.test(line));
	// The input box's bottom rule: the last rule with the `❯` line just above it, after a rule.
	let bottom = -1;
	for (let at = lines.length - 1; at >= 2; at--) {
		if (RULE.test(lines[at]) && lines[at - 1].trimStart().startsWith('❯')) {
			if (lines.slice(0, at - 1).some((line) => RULE.test(line))) bottom = at;
			break;
		}
	}
	if (bottom < 0) return { mode: null, reason: choice(0) ? SCREEN_DIALOG_REASON : SCREEN_NO_INPUT_REASON };
	if (choice(bottom - 2)) return { mode: null, reason: SCREEN_DIALOG_REASON };
	for (const line of lines.slice(bottom + 1)) {
		const words = MODE_LINE.exec(line)?.[1];
		if (words) return { mode: (Object.keys(SCREEN_WORDS) as ClaudeScreenMode[]).find((mode) => SCREEN_WORDS[mode] === words)! };
	}
	return { mode: null, reason: SCREEN_NO_MODE_REASON };
}

/** How many presses a switch may take: one more than a whole round of every mode. */
export const MAX_PRESSES = 6;

/** What a switch of Claude's mode came to. `reached` is the target seen; `back` a whole round
 *  went by without it and the screen is in the starting mode again; `stopped` the screen could not
 *  be read on the way, or the presses ran out, and the mode it was left in is `mode` (null when not
 *  known). `seen` is every mode the screen showed, the start included. */
export type CycleResult =
	| { outcome: 'reached'; mode: ClaudeScreenMode; presses: number; seen: ClaudeScreenMode[] }
	| { outcome: 'back'; mode: ClaudeScreenMode; presses: number; seen: ClaudeScreenMode[] }
	| { outcome: 'stopped'; mode: ClaudeScreenMode | null; presses: number; seen: ClaudeScreenMode[]; reason: string };

/**
 * Press Shift+Tab until the screen shows `target`. `read` reads the screen once a press has had
 * time to show; `press` presses once and answers why it could not, or null. Starts from a screen
 * already read in `start`. A press the screen does not answer with another mode stops it: a key
 * that did not land can not be told from one a dialog took.
 */
export async function cycleTo(
	start: ClaudeScreenMode,
	target: ClaudeMode,
	press: () => Promise<string | null>,
	read: (previous: ClaudeScreenMode) => Promise<ScreenRead>
): Promise<CycleResult> {
	const seen: ClaudeScreenMode[] = [start];
	let mode = start;
	for (let presses = 1; presses <= MAX_PRESSES; presses++) {
		const failed = await press();
		if (failed) return { outcome: 'stopped', mode: null, presses, seen, reason: failed };
		const screen = await read(mode);
		if (screen.mode === null) return { outcome: 'stopped', mode: null, presses, seen, reason: `按了 ${presses} 次後${screen.reason.replace(/，沒有按鍵$/, '')}，停下來沒有再按` };
		if (screen.mode === mode) return { outcome: 'stopped', mode, presses, seen, reason: `按了 Shift+Tab 畫面上的模式沒有變（仍是 ${CLAUDE_MODE_LABEL[mode]}），停下來沒有再按` };
		mode = screen.mode;
		if (mode === target) return { outcome: 'reached', mode, presses, seen: [...seen, mode] };
		if (mode === start) return { outcome: 'back', mode, presses, seen };
		seen.push(mode);
	}
	return { outcome: 'stopped', mode, presses: MAX_PRESSES, seen, reason: `按了 ${MAX_PRESSES} 次都沒有看到 ${CLAUDE_MODE_LABEL[target]}，也沒有回到原本的模式，停在 ${CLAUDE_MODE_LABEL[mode]}` };
}

const notOfferedHint = (mode: ClaudeMode) =>
	mode === 'bypassPermissions' ? '（這個 Agent 啟動時可能沒有允許免確認）' : '（這個 Agent 的 Claude 可能不提供這個模式）';

/** Why a whole round went by without the target, as the page shows it. */
export const notOfferedReason = (target: ClaudeMode) => `按完一整輪都沒有出現 ${CLAUDE_MODE_LABEL[target]}，已停回原本的模式${notOfferedHint(target)}`;

export const BYPASS_TURNED_OFF_REASON = '這個 Agent 啟動時的設定關掉了 bypass permissions（disableBypassPermissionsMode），按 Shift+Tab 也切不到';

/** Why a mode the latest whole round left out cannot be picked. */
export const leftOutReason = (mode: ClaudeMode) => `上次按完一整輪沒有出現 ${CLAUDE_MODE_LABEL[mode]}${notOfferedHint(mode)}`;

/** The `-c` overrides that put a Codex session in this mode. `approval_policy` is given each time:
 *  the profile alone keeps the thread's earlier one. */
export function codexPermissionArgs(mode: CodexMode): string[] {
	const [profile, approval, reviewer] = {
		'full-access': [':danger-full-access', 'never', 'user'],
		'approve-for-me': [':workspace', 'on-request', 'auto_review'],
		'ask-for-approval': [':workspace', 'on-request', 'user']
	}[mode];
	return ['-c', `default_permissions=${JSON.stringify(profile)}`, '-c', `approval_policy=${JSON.stringify(approval)}`, '-c', `approvals_reviewer=${JSON.stringify(reviewer)}`];
}

/** Which of the three a Codex turn's permission is, from its `turn_context`; null for another. */
export function codexMode(permission: { approval: string; sandbox: string | null; reviewer?: string | null }): CodexMode | null {
	if (permission.approval === 'never' && permission.sandbox === 'danger-full-access') return 'full-access';
	if (permission.approval !== 'on-request' || permission.sandbox !== 'workspace-write') return null;
	if (permission.reviewer === 'auto_review') return 'approve-for-me';
	return permission.reviewer === 'user' ? 'ask-for-approval' : null;
}

/** `--add-dir <dir>` for hcom's folder, unless these arguments give it already: hcom keeps what
 *  each resume adds, and a second one would not be what `/permissions` writes. */
export function addHcomDir(args: readonly string[], dir: string): string[] {
	const given = args.some((arg, at) => (arg === '--add-dir' && args[at + 1] === dir) || arg === `--add-dir=${dir}`);
	return given ? [] : ['--add-dir', dir];
}

/** Stored Codex launch options that fix the permission whatever `-c` says, and those that take a value. */
const FIXING_FLAGS = new Set(['--yolo', '--dangerously-bypass-approvals-and-sandbox', '--full-auto', '--approve-for-me']);
const FIXING_VALUED = new Set(['-s', '--sandbox', '-a', '--ask-for-approval']);

/**
 * The arguments hcom stored for a Codex session, without what would keep it from taking a new
 * mode: the bypass and sandbox flags beat any `-c` (and `-s`, `-a` are refused next to `--yolo`),
 * and the `resume <session>` hcom adds on a resume, which the relaunch gives itself.
 */
export function withoutPermissionFlags(args: readonly string[], session: string): string[] {
	const kept: string[] = [];
	for (let at = 0; at < args.length; at++) {
		const arg = args[at];
		if (arg === '--') {
			kept.push(...args.slice(at));
			break;
		}
		if (FIXING_FLAGS.has(arg)) continue;
		if (FIXING_VALUED.has(arg) || (arg === 'resume' && args[at + 1] === session)) {
			at++;
			continue;
		}
		if ([...FIXING_VALUED].some((name) => name.startsWith('--') && arg.startsWith(`${name}=`))) continue;
		kept.push(arg);
	}
	return kept;
}

/** What `GET /api/agents/permission` answers for one agent. */
export interface PermissionStatus {
	client: 'claude' | 'codex' | null;
	/** The mode now: Claude's from its screen read just now, Codex's from its latest turn; null when not known. */
	current: string | null;
	/** Why the current mode is not known, or why nothing can be switched now; null otherwise. */
	reason: string | null;
	/** Why no switch is offered at all, whatever the mode (the board's own pane); null otherwise. */
	blocked: string | null;
	/** The three modes, each with why it cannot be picked (null when it can). */
	modes: { id: string; label: string; reason: string | null }[];
}

/** Text the Codex relaunch sends as its first turn: hcom and Herdr only tell which session a fresh
 *  Codex resumes once it has had one, and the turn records the new mode in `turn_context`. */
export const codexFirstTurnText = (mode: CodexMode) =>
	`（看板訊息）權限已切換為 ${CODEX_MODE_LABEL[mode]}。這則只是讓這段對話接回，不需要做任何事，回覆「ok」即可。`;

export const PERMISSION_CONFIRM_TEXT = {
	claude: (label: string) => `切換為 ${label}？看板會在這個 Agent 的畫面按 Shift+Tab，每按一次就看畫面底部的模式，看到 ${label} 就停；不會重開它。`,
	codex: (label: string) =>
		`切換為 ${label}？看板會停止這個 Agent，再以新權限在同一個位置接回同一段對話，並送一則很短的訊息讓它跑一回合來確認新權限。`
};

export const PERMISSION_NOT_LINKED_REASON = '這個 Agent 沒有接 HCOM，看板只能替有接 HCOM 的 Codex 切換權限';
export const PERMISSION_PAUSED_REASON = '這個 Agent 暫停通訊中，先按「恢復通訊」接回 HCOM 才能切換權限';
export const PERMISSION_HCOM_UNKNOWN_REASON = 'HCOM 連線無法確認：hcom 的清單讀不到，不知道這個 Agent 有沒有接 HCOM，現在不能切換權限';
