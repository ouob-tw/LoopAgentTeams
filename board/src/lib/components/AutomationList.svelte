<script lang="ts">
	// The 自動化 tab: one card per scheduled task with its state this period, its run window, the
	// next automatic try and how the latest run ended. A task file the board cannot read is a red
	// card of its own, never left out. Picking a card opens the task in the content column.
	import Plus from '@lucide/svelte/icons/plus';
	import { clock } from '#lib/board/clock.svelte.ts';
	import { kindText, lastRunText, scheduleText, timeFormat, type AutomationSnapshot } from '#lib/board/automation.ts';
	import AutomationState from './AutomationState.svelte';

	let { automation, currentId, onopen, onnew }: { automation: AutomationSnapshot; currentId: string | null; onopen: (id: string) => void; onnew: () => void } = $props();

	const at = $derived(timeFormat(automation.timeZone));
</script>

<div class="automation">
	<div class="head">
		<p class="lead">看板自己排時間，不用另外設排程。</p>
		<button type="button" class="add" onclick={onnew}><Plus size="1.1em" />新增任務</button>
	</div>
	{#each automation.broken as broken (broken.file)}
		<p class="broken" role="alert" data-broken={broken.file}>
			<strong>設定檔讀不出來：{broken.file}</strong>
			<span>{broken.error}</span>
		</p>
	{/each}
	{#if automation.tasks.length === 0 && automation.broken.length === 0}
		<p class="none">還沒有任務。</p>
	{/if}
	<ul>
		{#each automation.tasks as view (view.task.id)}
			<li>
				<button type="button" class="card" class:current={view.task.id === currentId} aria-current={view.task.id === currentId ? 'true' : undefined} data-task={view.task.id} onclick={() => onopen(view.task.id)}>
					<strong class="ell name">{view.task.name}</strong>
					<span class="state"><AutomationState state={view.state} /></span>
					<span class="ell muted">{kindText(view.task.kind)} · {scheduleText(view.task.schedule, view.task.time)}</span>
					<span class="ell next"><span class="muted">下次</span> {view.nextAt === null ? (view.task.paused ? '暫停中不會自動跑' : '—') : `${at.full(view.nextAt)}${view.nextAt <= clock.now ? '（已到時間）' : ''}`}</span>
					<span class="ell muted last">{lastRunText(view.runs[0], automation.timeZone)}</span>
				</button>
			</li>
		{/each}
	</ul>
</div>

<style>
	.automation {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		min-width: 0;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.4rem 0.6rem;
	}
	.lead,
	.none {
		margin: 0;
		color: var(--muted);
	}
	.add {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		min-height: 44px;
	}
	ul {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.card {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 0.1rem;
		width: 100%;
		min-width: 0;
		padding: 0.5rem 0.7rem;
		text-align: left;
		background: var(--surface);
		border: 1px solid var(--line);
	}
	.card.current {
		border: 2px solid var(--text);
		padding: calc(0.5rem - 1px) calc(0.7rem - 1px);
	}
	.ell {
		display: block;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		min-width: 0;
	}
	.state {
		margin: 0.15rem 0;
	}
	.muted {
		color: var(--muted);
	}
	.broken {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0.5rem 0.7rem;
		border: 1px solid var(--danger);
		border-left-width: 5px;
		border-radius: var(--radius);
		overflow-wrap: anywhere;
	}
	.broken strong {
		color: var(--danger);
	}
</style>
