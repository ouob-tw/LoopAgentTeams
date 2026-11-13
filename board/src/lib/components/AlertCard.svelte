<script lang="ts">
	// One automation red card in the content column: the task and how it ended, whether the phones
	// heard of it, the run it is about (or the periods missed), and 重跑一次, 打開自動化設定 and
	// 知道了，關掉紅卡. Closing the card leaves the run records as they are.
	import { ALERT_KIND_TEXT, type AutomationAlert } from '#lib/board/alerts.ts';
	import { MISSED_NAMED, missedNames, runReason, TRIGGER_TEXT, timeFormat, type AutomationTaskView } from '#lib/board/automation.ts';
	import { runTask } from '#lib/board/automation-actions.ts';
	import { dismissAlert } from '#lib/board/alert-actions.ts';
	import { testDevice } from '#lib/board/test-device.svelte.ts';
	import AutomationState from './AutomationState.svelte';
	import TestDenied from './TestDenied.svelte';

	let {
		alert,
		task,
		timeZone,
		onsettings,
		onchanged
	}: {
		alert: AutomationAlert;
		/** The task as the board has it now; undefined once it was deleted. */
		task: AutomationTaskView | undefined;
		timeZone: string;
		onsettings: (taskId: string) => void;
		onchanged: () => void;
	} = $props();

	const at = $derived(timeFormat(timeZone));
	const run = $derived(alert.runId === undefined ? undefined : task?.runs.find((candidate) => candidate.id === alert.runId));
	const running = $derived(task?.runs.some((candidate) => candidate.status === 'running') ?? false);
	const closed = $derived(alert.dismissedAt !== undefined);

	let busy = $state(false);
	/** What the last button answered: refused in red, started in plain words. */
	let notice = $state<{ text: string; bad: boolean } | null>(null);

	async function rerun() {
		busy = true;
		notice = null;
		const done = await runTask(alert.taskId);
		busy = false;
		notice = done.ok ? { text: '已開始執行，結果會記在這個任務的執行紀錄。', bad: false } : { text: done.message, bad: true };
		onchanged();
	}

	async function dismiss() {
		busy = true;
		notice = null;
		const failed = await dismissAlert(alert.id);
		busy = false;
		if (failed) notice = { text: failed, bad: true };
		onchanged();
	}
</script>

<div class="card" data-alert={alert.id} data-kind={alert.kind}>
	<header>
		<h2>{alert.taskName}：{ALERT_KIND_TEXT[alert.kind]}</h2>
		<span class="pill">✕ {ALERT_KIND_TEXT[alert.kind]}</span>
	</header>
	{#if closed}
		<p class="muted" data-closed>這張紅卡已在 {at.full(alert.dismissedAt!)} 關掉，執行紀錄仍在任務裡。</p>
	{:else if alert.pushed?.devices}
		<p data-pushed>已推播到 {alert.pushed.devices} 台裝置（{at.full(alert.pushed.at)}）。這張紅卡留在待辦，直到你關掉。</p>
	{:else}
		<p data-pushed="none">沒有裝置收到推播：到設定按「允許通知」，之後的紅卡就會推播到那台裝置。</p>
	{/if}

	{#if alert.kind === 'missed' && alert.periods?.length}
		<section class="record" data-missed={alert.periods.length}>
			{#if alert.periods.length > 1}<b>錯過 {alert.periods.length} 期</b>{/if}
			<p>
				{#each missedNames(alert.periods) as name, index (index)}{index ? '、' : ''}<span class="window">{name}</span>{/each}{alert.periods.length > MISSED_NAMED ? ` 等共 ${alert.periods.length} 期` : ''}
				看板都沒開，所以沒跑。不會自動補跑。
			</p>
		</section>
	{:else if run}
		<section class="record" data-run={run.id}>
			<div class="when">
				<b>{at.full(run.startedAt)}{run.endedAt === undefined ? '' : ` → ${at.day(run.startedAt) === at.day(run.endedAt) ? at.clock(run.endedAt) : at.full(run.endedAt)}`}</b>
				<AutomationState status={run.status} />
				<span class="trigger">{TRIGGER_TEXT[run.trigger]}</span>
			</div>
			<p>{runReason(run)}</p>
			{#if run.review?.verdict === 'fail'}
				<p class="bad">檢查沒過{run.review.summary ? `：${run.review.summary}` : ''}</p>
			{/if}
			{#if run.checks?.length}
				<ul class="checks">
					{#each run.checks as check, index (index)}
						<li class:failed={!check.ok}><b aria-label={check.ok ? '通過' : '沒過'}>{check.ok ? '✓' : '✕'}</b><span>{check.label}{check.detail ? `：${check.detail}` : ''}</span></li>
					{/each}
				</ul>
			{/if}
		</section>
	{:else}
		<p class="muted">{task ? '這次執行已不在最近的紀錄裡，打開自動化設定看全部紀錄。' : '這個任務已經不在了。'}</p>
	{/if}

	<div class="actions">
		{#if !closed}
			<button type="button" class="primary" disabled={busy || running || !task || testDevice.view !== null} onclick={rerun}>重跑一次</button>
		{/if}
		<button type="button" disabled={!task} onclick={() => onsettings(alert.taskId)}>打開自動化設定</button>
		{#if !closed}
			<button type="button" disabled={busy || testDevice.view !== null} onclick={dismiss}>知道了，關掉紅卡</button>
		{/if}
	</div>
	{#if !closed}
		<TestDenied />
	{/if}
	{#if notice}
		<p class={notice.bad ? 'bad' : 'muted'} role={notice.bad ? 'alert' : 'status'}>{notice.text}</p>
	{:else if running && !closed}
		<p class="muted">這個任務正在跑，這次結束後才能重跑。</p>
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
	.pill {
		padding: 0 0.6rem;
		border: 2px solid var(--danger);
		border-radius: var(--radius-pill);
		color: var(--danger);
		font-weight: 700;
		white-space: nowrap;
	}
	.record {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		padding: 0.5rem 0.8rem;
		border: 1px solid var(--line);
		border-left: 5px solid var(--danger);
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
	.trigger {
		padding: 0 0.6rem;
		border-radius: var(--radius-pill);
		background: color-mix(in srgb, var(--text) 10%, var(--bg));
		white-space: nowrap;
	}
	.window {
		white-space: nowrap;
	}
	.checks {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.checks li {
		display: flex;
		gap: 0.5rem;
		overflow-wrap: anywhere;
	}
	.checks b {
		flex: none;
		width: 1.2rem;
	}
	.checks li.failed,
	.bad {
		color: var(--danger);
	}
	.bad {
		font-weight: 700;
	}
	.muted {
		color: var(--muted);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.actions button {
		min-height: 48px;
	}
	.actions button.primary {
		font-weight: 700;
	}
</style>
