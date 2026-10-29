<script lang="ts">
	// The open agent's permission mode, for a Claude or Codex agent: a section of the command line's
	// options pop-up listing the three modes the board switches between, the current one marked; a
	// click on another switches at once. Claude's mode is what its screen shows (read again whenever
	// the agent's state changes), and a switch presses Shift+Tab there; Codex's is its latest turn's,
	// and a switch resumes it, as a model switch does (its ⚠ beside the model handles one left unfinished).
	import { agentControl } from '#lib/board/agent-control.svelte.ts';
	import { AGENT_BUSY_REASON, AGENT_SWITCH_UNFINISHED_TEXT } from '#lib/board/models.ts';
	import {
		CLAUDE_MODE_LABEL,
		CODEX_MODE_LABEL,
		PERMISSION_HCOM_UNKNOWN_REASON,
		PERMISSION_NOT_LINKED_REASON,
		PERMISSION_PAUSED_REASON,
		type ClaudeScreenMode,
		type CodexMode
	} from '#lib/board/permissions.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';
	import type { KnownAgent } from '#lib/board/types.ts';

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
		if (status.blocked) return status.blocked;
		if (client === 'claude' && status.reason) return status.reason;
		if (sending) return '切換中…';
		return null;
	});

	async function pick(mode: string) {
		if (blocked || mode === status?.current) return;
		const { id: target, name } = agent;
		sending = true;
		const result = await agentControl.switchPermission(target, mode);
		sending = false;
		const done = client === 'codex' ? `已切換 ${name} 的權限，等它接回並跑完確認的一回合。` : `已把 ${name} 切換為 ${label(mode)}。`;
		toasts.show(result.ok ? 'ok' : 'failed', result.ok ? `${done}${result.reason ?? ''}` : (result.reason ?? '切換失敗'));
	}
</script>

{#if client}
	<section class="permission" aria-label="權限">
		<h3>權限{#if status?.reason && client === 'codex' && !blocked}<small>（{status.reason}）</small>{/if}</h3>
		<div class="modes">
			{#each status?.modes ?? [] as mode (mode.id)}
				<button
					type="button"
					data-mode={mode.id}
					aria-current={status?.current === mode.id}
					aria-disabled={!!blocked || !!mode.reason}
					title={mode.reason ?? mode.label}
					onclick={() => !mode.reason && pick(mode.id)}
				>
					{mode.label}{#if mode.reason}<small>不能選</small>{/if}
				</button>
			{/each}
		</div>
		{#if blocked}<p class="note blocked">{blocked}</p>{/if}
		{#each status?.modes.filter((mode) => mode.reason) ?? [] as mode (mode.id)}
			<p class="note">{mode.reason}</p>
		{/each}
		<p class="note">
			{client === 'claude'
				? '點一下就切換：看板在它的畫面按 Shift+Tab，看到選的模式就停，不會重開；目前模式以畫面為準。'
				: '點一下就切換：看板會停止它，再以新權限在同一個位置接回同一段對話；要等它這一回合做完才能切換。'}
		</p>
	</section>
{/if}

<style>
	.permission {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		width: 100%;
	}
	h3 {
		margin: 0;
		font-size: max(0.8rem, var(--min-font, 0px));
		font-weight: normal;
		color: var(--muted);
	}
	.modes {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.modes button {
		display: flex;
		gap: 0.5rem;
		align-items: baseline;
		padding: 0.4rem 0.6rem;
		font-size: max(0.85rem, var(--min-font, 0px));
		text-align: left;
	}
	.modes button[aria-current='true'] {
		border: 2px solid var(--text);
		font-weight: 700;
	}
	.modes button[aria-current='true']::before {
		content: '✓';
	}
	.modes small {
		margin-left: auto;
		font-size: max(0.75rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.modes button[aria-disabled='true'] {
		opacity: var(--disabled-opacity);
		cursor: not-allowed;
	}
	/* Without translucency a mode that cannot be picked is grey and struck through, like a disabled
	   button there; the current one stays readable. */
	:root[data-theme='light'] .modes button[aria-disabled='true']:not([aria-current='true']) {
		color: var(--muted);
		text-decoration: line-through;
	}
	.note {
		margin: 0;
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.note.blocked {
		color: var(--text);
	}
</style>
