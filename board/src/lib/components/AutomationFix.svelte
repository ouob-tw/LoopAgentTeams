<script lang="ts">
	// The round a first check that judged FAIL opened (#690): while the task's agent works on it, how
	// long and a link to its live screen; once it replied, its reply item by item; when it ended with no
	// reply, why, the first check's FAIL standing.
	import type { RunFix } from '#lib/board/automation.ts';

	let { fix, sessionId, now, onopenagent }: { fix: RunFix; sessionId: string | undefined; now: number; onopenagent: (sessionId: string) => void } = $props();

	const open = (event: MouseEvent) => {
		event.preventDefault();
		onopenagent(sessionId!);
	};
</script>

<div class="fix" data-fix={fix.status}>
	{#if fix.status === 'fixing'}
		<b>已交回任務 Agent 修正</b>
		<p>已修正 {Math.max(0, Math.floor((now - fix.startedAt) / 60_000))} 分鐘，上限 {fix.limitMinutes} 分鐘</p>
		{#if sessionId}
			<a href={`?agent=${encodeURIComponent(sessionId)}`} onclick={open}>打開任務 Agent 看即時畫面 ›</a>
		{/if}
	{:else if fix.status === 'replied'}
		<b>任務 Agent 的回應</b>
		<p class="reply">{fix.reply}</p>
	{:else}
		<b class="bad">交回修正沒有完成</b>
		<p>{fix.reason ? `${fix.reason}。` : ''}結果維持第一次的沒過。</p>
	{/if}
	{#each fix.accountSwitches ?? [] as note, index (index)}
		<p class="hint">換帳號：{note}</p>
	{/each}
	{#if fix.closeError}
		<p class="bad">{fix.closeError}</p>
	{/if}
</div>

<style>
	.fix {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		min-width: 0;
	}
	p {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.reply {
		white-space: pre-wrap;
		max-height: 18rem;
		overflow-y: auto;
		padding: 0.4rem 0.6rem;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		text-spacing-trim: space-all;
	}
	.bad {
		color: var(--danger);
	}
	.hint {
		color: var(--muted);
	}
	a {
		align-self: flex-start;
		min-height: 44px;
		display: inline-flex;
		align-items: center;
		color: var(--accent);
		font-weight: 700;
	}
</style>
