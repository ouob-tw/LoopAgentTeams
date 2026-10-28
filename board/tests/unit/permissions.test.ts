// Reading Claude's mode off its screen, pressing Shift+Tab round to a mode, and the Codex arguments
// for each of its three modes.
import { expect, test } from 'bun:test';
import {
	codexMode,
	codexPermissionArgs,
	cycleTo,
	MAX_PRESSES,
	readClaudeScreen,
	SCREEN_DIALOG_REASON,
	SCREEN_NO_INPUT_REASON,
	SCREEN_NO_MODE_REASON,
	withoutPermissionFlags,
	type ClaudeScreenMode,
	type ScreenRead
} from '../../src/lib/board/permissions.ts';

const RULE = '─'.repeat(62);
/** Claude Code 2.1.312's bottom lines as `herdr pane read --source visible` printed them. */
const screen = (modeLine: string | null, extra: string[] = []) =>
	[
		' ▐▛███▛█   Claude Code v2.1.312',
		'',
		RULE,
		'❯ ',
		RULE,
		'  Sonnet 5.5 M · ~/projects/alpha',
		...(modeLine === null ? [] : [modeLine]),
		...extra
	].join('\n');

test('each mode line Claude shows is read as its mode', () => {
	expect(readClaudeScreen(screen('  ⏵⏵ bypass permissions on (shift+tab to cycle)', ["  You've used 92% of your weekly limit"]))).toEqual({ mode: 'bypassPermissions' });
	expect(readClaudeScreen(screen('  ⏵⏵ auto mode on (shift+tab to cycle)'))).toEqual({ mode: 'auto' });
	// Manual mode has a line of its own in 2.1.312, without the cycle hint.
	expect(readClaudeScreen(screen('  ⏸ manual mode on'))).toEqual({ mode: 'manual' });
	expect(readClaudeScreen(screen('  ⏵⏵ accept edits on (shift+tab to cycle)'))).toEqual({ mode: 'acceptEdits' });
	expect(readClaudeScreen(screen('  ⏸ plan mode on (shift+tab to cycle)'))).toEqual({ mode: 'plan' });
});

test('a screen with a dialog, a menu or no mode line is not read', () => {
	// A tool approval replaces the input box with numbered choices.
	const dialog = ['Bash command', '  rm -rf build', 'Do you want to proceed?', '❯ 1. Yes', '  2. No'].join('\n');
	expect(readClaudeScreen(dialog)).toEqual({ mode: null, reason: SCREEN_DIALOG_REASON });
	expect(readClaudeScreen('Starting Claude...\n')).toEqual({ mode: null, reason: SCREEN_NO_INPUT_REASON });
	// A slash-command menu takes the place of the lines under the box.
	expect(readClaudeScreen(screen(null, ['  /model     Set the AI model', '  /permissions  Manage rules']))).toEqual({ mode: null, reason: SCREEN_NO_MODE_REASON });
	// A mode line above the input box (in the conversation) is not the footer.
	const quoted = [RULE, '❯ ⏵⏵ auto mode on', RULE].join('\n');
	expect(readClaudeScreen(`${quoted}\nsome output\n${screen(null)}`)).toEqual({ mode: null, reason: SCREEN_NO_MODE_REASON });
});

/** A Claude whose Shift+Tab goes round `order`; `answer` may change what a read gives. */
function fakeClaude(order: ClaudeScreenMode[], start: ClaudeScreenMode, answer?: (mode: ClaudeScreenMode, presses: number) => ScreenRead | null) {
	let at = order.indexOf(start);
	let presses = 0;
	return {
		get presses() {
			return presses;
		},
		press: async () => {
			presses++;
			at = (at + 1) % order.length;
			return null;
		},
		read: async (): Promise<ScreenRead> => answer?.(order[at], presses) ?? { mode: order[at] }
	};
}
const FULL: ClaudeScreenMode[] = ['bypassPermissions', 'auto', 'manual', 'acceptEdits', 'plan'];

test('presses stop at the target, passing the modes on the way', async () => {
	const claude = fakeClaude(FULL, 'bypassPermissions');
	expect(await cycleTo('bypassPermissions', 'manual', claude.press, claude.read)).toEqual({
		outcome: 'reached',
		mode: 'manual',
		presses: 2,
		seen: ['bypassPermissions', 'auto', 'manual']
	});
	// From manual, bypass permissions is three presses on, through accept edits and plan.
	const back = fakeClaude(FULL, 'manual');
	expect((await cycleTo('manual', 'bypassPermissions', back.press, back.read)).presses).toBe(3);
});

test('a whole round without the target ends in the starting mode', async () => {
	// Started without bypass permissions allowed: it is not in the round.
	const claude = fakeClaude(['manual', 'acceptEdits', 'plan', 'auto'], 'auto');
	const result = await cycleTo('auto', 'bypassPermissions', claude.press, claude.read);
	expect(result).toEqual({ outcome: 'back', mode: 'auto', presses: 4, seen: ['auto', 'manual', 'acceptEdits', 'plan'] });
	expect(claude.presses).toBe(4);
});

test('the presses never go past the limit', async () => {
	// A round that never comes back to where it started (the screen misreads one mode as another).
	let next = 0;
	const modes: ClaudeScreenMode[] = ['auto', 'manual', 'acceptEdits', 'plan'];
	const press = async () => null;
	const read = async (): Promise<ScreenRead> => ({ mode: modes[next++ % modes.length] });
	const result = await cycleTo('bypassPermissions', 'manual', press, async () => {
		const answer = await read();
		return answer.mode === 'manual' ? { mode: 'plan' } : answer;
	});
	expect(result.outcome).toBe('stopped');
	expect(result.presses).toBe(MAX_PRESSES);
});

test('a screen that cannot be read, a press that fails or does not change the mode stops at once', async () => {
	const dialog = fakeClaude(FULL, 'bypassPermissions', (_, presses) => (presses === 1 ? { mode: null, reason: SCREEN_DIALOG_REASON } : null));
	const stopped = await cycleTo('bypassPermissions', 'manual', dialog.press, dialog.read);
	expect(stopped).toMatchObject({ outcome: 'stopped', mode: null, presses: 1 });
	expect(dialog.presses).toBe(1);

	const failing = await cycleTo('auto', 'manual', async () => 'Herdr 沒有送出按鍵', async () => ({ mode: 'manual' }));
	expect(failing).toMatchObject({ outcome: 'stopped', presses: 1, reason: 'Herdr 沒有送出按鍵' });

	const stuck = await cycleTo('auto', 'manual', async () => null, async () => ({ mode: 'auto' }));
	expect(stuck).toMatchObject({ outcome: 'stopped', mode: 'auto', presses: 1 });
});

test('each Codex mode resumes with what its /permissions item writes', () => {
	expect(codexPermissionArgs('full-access')).toEqual(['-c', 'default_permissions=":danger-full-access"', '-c', 'approval_policy="never"', '-c', 'approvals_reviewer="user"']);
	expect(codexPermissionArgs('approve-for-me')).toEqual(['-c', 'default_permissions=":workspace"', '-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="auto_review"']);
	expect(codexPermissionArgs('ask-for-approval')).toEqual(['-c', 'default_permissions=":workspace"', '-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="user"']);
});

test("a Codex turn's permission is named after the /permissions item", () => {
	expect(codexMode({ approval: 'never', sandbox: 'danger-full-access', reviewer: 'user' })).toBe('full-access');
	expect(codexMode({ approval: 'on-request', sandbox: 'workspace-write', reviewer: 'auto_review' })).toBe('approve-for-me');
	expect(codexMode({ approval: 'on-request', sandbox: 'workspace-write', reviewer: 'user' })).toBe('ask-for-approval');
	// Read Only and other settings are none of the three; a record without the reviewer cannot tell two of them apart.
	expect(codexMode({ approval: 'on-request', sandbox: 'read-only', reviewer: 'user' })).toBeNull();
	expect(codexMode({ approval: 'on-request', sandbox: 'workspace-write' })).toBeNull();
});

test('the stored Codex arguments lose what fixes the permission, nothing else', () => {
	expect(
		withoutPermissionFlags(['resume', 's-1', '--no-daemon', '--model', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="low"', '--yolo', '-s', 'workspace-write', '-a', 'on-request', '-c', 'approvals_reviewer="user"'])
	).toEqual(['--no-daemon', '--model', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="low"', '-c', 'approvals_reviewer="user"']);
	expect(withoutPermissionFlags(['--dangerously-bypass-approvals-and-sandbox', '--sandbox=read-only', '--ask-for-approval=never', '--full-auto', '--add-dir', '/x'])).toEqual(['--add-dir', '/x']);
	// What follows `--` is the client's own, left as it is.
	expect(withoutPermissionFlags(['--', '--yolo'])).toEqual(['--', '--yolo']);
});
