<script lang="ts">
	// One yellow card (等你回覆) in the content column: the task, whether the phones heard of it, and
	// the run with the question in full, the time it must be answered by and the box to answer it.
	// It goes by itself once the agent goes on or the run ends; opened from a push after that, it
	// says so and points to the task.
	import type { AutomationAlert } from '#lib/board/alerts.ts';
	import { clock } from '#lib/board/clock.svelte.ts';
	import { openAsk, timeFormat, type AutomationTaskView } from '#lib/board/automation.ts';
	import AutomationAsk from './AutomationAsk.svelte';
	import AutomationAsks from './AutomationAsks.svelte';
	import AutomationState from './AutomationState.svelte';
	import TestDenied from './TestDenied.svelte';

	let {
		alert,
		task,
		timeZone,
		onsettings,
		onchanged,
		onopenagent
	}: {
		alert: AutomationAlert;
		task: AutomationTaskView | undefined;
		timeZone: string;
		onsettings: (taskId: string) => void;
		onchanged: () => void;
		onopenagent: (sessionId: string) => void;
	} = $props();

	const at = $derived(timeFormat(timeZone));
	const run = $derived(task?.runs.find((candidate) => candidate.id === alert.runId));
	const waiting = $derived(run ? openAsk(run) : undefined);
	/** This card's question is the one the run waits on now. */
	const live = $derived(alert.dismissedAt === undefined && waiting !== undefined && run!.asks!.length - 1 === alert.ask);
	const answered = $derived(alert.resolved === 'answered' || (alert.ask !== undefined && run?.asks?.[alert.ask]?.answeredAt !== undefined));
	const minutes = $derived(run ? Math.max(0, Math.floor((clock.now - run.startedAt) / 60_000)) : 0);
</script>

<div class="card" data-alert={alert.id} data-kind="ask">
	<header>
		<h2>{alert.taskName}：等你回覆</h2>
		{#if live}<AutomationState state="asking" />{/if}
	</header>
	{#if !live && answered}
		<p data-closed="answered">這個問題已回覆，Agent 接著做了；問答留在執行紀錄。</p>
	{:else if !live}
		<p data-closed="ended">這次執行已結束，問題沒有等到回覆；結果在任務的執行紀錄。</p>
	{:else if alert.pushed?.devices}
		<p data-pushed>已推播到 {alert.pushed.devices} 台裝置（{at.full(alert.pushed.at)}）。回覆後這張黃卡自動消失。</p>
	{:else}
		<p data-pushed="none">沒有裝置收到推播：到設定按「允許通知」，之後就會推播到那台裝置。回覆後這張黃卡自動消失。</p>
	{/if}

	{#if live && run && waiting && task}
		<section class="record" data-run={run.id}>
			<div class="when">
				<b>{at.full(run.startedAt)} → 進行中</b>
				<AutomationState {run} />
			</div>
			<p>已跑 {minutes} 分鐘　上限 {task.task.limitMinutes} 分鐘</p>
			<AutomationAsks asks={run.asks ?? []} waiting {timeZone} />
			<AutomationAsk taskId={task.task.id} {run} ask={waiting} limitMinutes={task.task.limitMinutes} {timeZone} withControls {onopenagent} {onchanged} />
			<TestDenied />
		</section>
	{:else}
		{#if alert.question}
			<div class="question">
				<b>Agent 問你：</b>
				<p>{alert.question}</p>
			</div>
		{/if}
		<div class="actions">
			<button type="button" disabled={!task} onclick={() => onsettings(alert.taskId)}>打開自動化設定</button>
		</div>
	{/if}
</div>

<style>
	.card {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
		max-width: 46rem;
		line-height: 1.6;
	}
	header {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.3rem 0.6rem;
	}
	h2 {
		margin: 0;
		font-size: max(1.15rem, var(--min-font, 0px));
		overflow-wrap: anywhere;
	}
	p {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.record {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding: 0.5rem 0.8rem;
		border: 1px solid var(--line);
		border-left: 5px solid var(--ask-fill);
		border-radius: var(--radius);
		background: var(--surface);
		min-width: 0;
	}
	.when {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.2rem 0.6rem;
	}
	.question {
		padding: 0.4rem 0.8rem;
		border: 1px solid var(--line);
		border-radius: var(--radius);
	}
	.question p {
		white-space: pre-wrap;
	}
	.actions button {
		min-height: 48px;
	}
</style>
