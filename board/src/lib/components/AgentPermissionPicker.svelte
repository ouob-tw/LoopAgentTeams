<script lang="ts">
	// The open agent's permission mode beside its model and effort, for a Claude or Codex agent: one
	// part that opens the three modes the board switches between, a pick confirmed before it is sent.
	// Claude's mode is what its screen shows (read again whenever the agent's state changes), and a
	// switch presses Shift+Tab there; Codex's is its latest turn's, and a switch resumes it, as a
	// model switch does (its ⚠ beside the model handles one left unfinished).
	import { agentControl } from '#lib/board/agent-control.svelte.ts';
	import { AGENT_BUSY_REASON, AGENT_SWITCH_UNFINISHED_TEXT } from '#lib/board/models.ts';
	import {
		CLAUDE_MODE_LABEL,
		CODEX_MODE_LABEL,
		PERMISSION_CONFIRM_TEXT,
		PERMISSION_HCOM_UNKNOWN_REASON,
		PERMISSION_NOT_LINKED_REASON,
		PERMISSION_PAUSED_REASON,
		type ClaudeScreenMode,
		type CodexMode
	} from '#lib/board/permissions.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';
	import type { KnownAgent } from '#lib/board/types.ts';
	import { focusFirst } from './PickerMenu.svelte';
	import './model-picker.css';

	let { agent }: { agent: KnownAgent } = $props();

	const id = $derived(agent.id);
	const client = $derived(agent.client === 'claude' || agent.client === 'codex' ? agent.client : null);
	const status = $derived(agentControl.permission[id]);
	let sending = $state(false);

	// Read again for another agent, and whenever its state or its switch moves on; not for each
	// board read that leaves them as they were.
	const watchedState = $derived(`${agent.inHerdr}|${agent.status}|${agent.switch?.state ?? ''}`);
	$effect(() => {
		if (!client || !watchedState.startsWith('true')) return;
		const abort = new AbortController();
		void agentControl.loadPermission(id, abort.signal);
		return () => abort.abort();
	});

	const label = (mode: string | null | undefined) =>
		!mode ? null : client === 'claude' ? (CLAUDE_MODE_LABEL[mode as ClaudeScreenMode] ?? mode) : (CODEX_MODE_LABEL[mode as CodexMode] ?? mode);

	/** Why nothing can be picked now; null when the modes can. */
	const blocked = $derived.by((): string | null => {
		if (agent.switch) return AGENT_SWITCH_UNFINISHED_TEXT;
		if (!agent.inHerdr) return 'Herdr 的清單上已經沒有這個 Agent，不能切換權限';
		if (client === 'codex') {
			if (agent.hcom === 'none') return PERMISSION_NOT_LINKED_REASON;
			if (agent.hcom === 'paused') return PERMISSION_PAUSED_REASON;
			if (agent.hcom === 'unknown') return PERMISSION_HCOM_UNKNOWN_REASON;
			if (agent.status !== 'idle') return AGENT_BUSY_REASON;
		}
		if (!status) return '讀取中…';
		if (client === 'claude' && status.reason) return status.reason;
		if (sending) return '切換中…';
		return null;
	});

	const current = $derived(label(status?.current));
	const text = $derived(current ?? '權限');
	const title = $derived(blocked ?? `權限：${current ?? '不明'}${status?.reason && client === 'codex' ? `（${status.reason}）` : ''}（點選可切換）`);

	let menu = $state<'modes' | 'confirm' | null>(null);
	let picked = $state<string | null>(null);
	let root = $state<HTMLElement>();
	let trigger = $state<HTMLButtonElement>();

	// The menus belong to one agent: another one closes them.
	$effect.pre(() => {
		void id;
		menu = null;
	});

	// A click anywhere else closes the open menu.
	$effect(() => {
		if (!menu) return;
		const outside = (event: PointerEvent) => {
			if (!root?.contains(event.target as Node)) menu = null;
		};
		addEventListener('pointerdown', outside, true);
		return () => removeEventListener('pointerdown', outside, true);
	});

	function close(focus = false) {
		menu = null;
		if (focus) trigger?.focus();
	}

	function keys(event: KeyboardEvent) {
		const items = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
		const at = items.indexOf(document.activeElement as HTMLElement);
		const move = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
		if (move !== undefined) {
			event.preventDefault();
			items[(move + items.length) % items.length]?.focus();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			close(true);
		} else if (event.key === 'Tab') close();
	}

	function pick(mode: string) {
		if (mode === status?.current) return close(true);
		picked = mode;
		menu = 'confirm';
	}

	async function run() {
		const mode = picked;
		const { id: target, name } = agent;
		close();
		if (!mode) return;
		sending = true;
		const result = await agentControl.switchPermission(target, mode);
		sending = false;
		const done = client === 'codex' ? `已切換 ${name} 的權限，等它接回並跑完確認的一回合。` : `已把 ${name} 切換為 ${label(mode)}。`;
		toasts.show(result.ok ? 'ok' : 'failed', result.ok ? `${done}${result.reason ?? ''}` : (result.reason ?? '切換失敗'));
	}
</script>

{#if client}
	<span class="picker permission" bind:this={root}>
		<button
			bind:this={trigger}
			type="button"
			class="part"
			data-pick="permission"
			class:unknown={!current}
			aria-label="權限模式：{current ?? '不明'}"
			aria-haspopup="menu"
			aria-expanded={menu === 'modes'}
			aria-disabled={!!blocked}
			{title}
			onclick={() => (menu ? close() : !blocked && (menu = 'modes'))}
		>
			{text}
		</button>

		{#if menu === 'modes' && status}
			<div class="menu">
				<div class="items" role="menu" aria-label="權限模式" tabindex="-1" onkeydown={keys} {@attach focusFirst}>
					{#each status.modes as mode (mode.id)}
						<button
							type="button"
							role="menuitemradio"
							aria-checked={status.current === mode.id}
							aria-disabled={!!mode.reason}
							title={mode.reason ?? mode.label}
							onclick={() => !mode.reason && pick(mode.id)}
						>
							{mode.label}{#if mode.reason}<small>不能選</small>{/if}
						</button>
					{/each}
				</div>
				{#each status.modes.filter((mode) => mode.reason) as mode (mode.id)}
					<p class="note">{mode.reason}</p>
				{/each}
				<p class="note">
					{client === 'claude'
						? '看板在它的畫面按 Shift+Tab，看到選的模式就停，不會重開；目前模式以畫面為準。'
						: '看板會停止它，再以新權限在同一個位置接回同一段對話；要等它這一回合做完才能切換。'}
				</p>
			</div>
		{:else if menu === 'confirm' && picked}
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<div
				class="menu status"
				role="dialog"
				aria-label="確認切換權限"
				tabindex="-1"
				onkeydown={(event) => event.key === 'Escape' && (event.preventDefault(), close(true))}
				{@attach focusFirst}
			>
				<p>{PERMISSION_CONFIRM_TEXT[client](label(picked) ?? picked)}</p>
				<button type="button" class="wide primary" data-action="confirm-permission" onclick={run}>確認切換</button>
				<button type="button" class="wide" onclick={() => close(true)}>取消</button>
			</div>
		{/if}
	</span>
{/if}

<style>
	.permission .menu button[aria-disabled='true'] {
		opacity: 0.55;
		cursor: not-allowed;
	}
</style>
