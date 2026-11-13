<script lang="ts">
	// One task in the content column: its settings, the checklist, and every run kept, newest
	// first, each with how it was started, when, how it ended and why, the fixed checks one by one
	// and the output it left. 立即執行, 暫停／恢復 and 編輯 sit at the top; missed periods above them,
	// with 立即執行 and 這期就算了.
	import { clock } from '#lib/board/clock.svelte.ts';
	import {
		clientName,
		EFFORT_TEXT,
		kindText,
		MISSED_NAMED,
		runReason,
		scheduleText,
		TRIGGER_TEXT,
		timeFormat,
		missedNames,
		type AutomationRun,
		type AutomationTaskView
	} from '#lib/board/automation.ts';
	import { dismissMissed, pauseTask, readOutput, runTask } from '#lib/board/automation-actions.ts';
	import AutomationState from './AutomationState.svelte';

	let { view, timeZone, onedit, onchanged }: { view: AutomationTaskView; timeZone: string; onedit: () => void; onchanged: () => void } = $props();

	const task = $derived(view.task);
	const at = $derived(timeFormat(timeZone));
	const running = $derived(view.runs.some((run) => run.status === 'running'));
	/** What the last button pressed here answered, when it was refused. */
	let notice = $state<string | null>(null);
	let busy = $state(false);

	async function act(step: () => Promise<{ ok: boolean; message?: string }>) {
		busy = true;
		notice = null;
		const done = await step();
		busy = false;
		if (!done.ok) notice = done.message ?? null;
		onchanged();
	}

	/** Each run's output once opened, read when its box is first opened. */
	let outputs = $state<Record<string, string>>({});
	async function openOutput(run: AutomationRun, event: Event) {
		if (!(event.currentTarget as HTMLDetailsElement).open || outputs[run.id] !== undefined) return;
		const read = await readOutput(task.id, run.id);
		outputs[run.id] = read.ok ? read.value : read.message;
	}

	const minutes = (from: number, to: number) => Math.max(0, Math.floor((to - from) / 60_000));
	const sameDay = (a: number, b: number) => at.day(a) === at.day(b);
</script>

<div class="task" data-task={task.id}>
	<header>
		<h2>{task.name}</h2>
		<AutomationState state={view.state} />
	</header>
	{#if view.missed.length}
		<section class="missed" data-missed={view.missed.length}>
			<b>{task.name}：{view.missed.length === 1 ? '本期錯過' : `錯過 ${view.missed.length} 期`}</b>
			<p>
				{#each missedNames(view.missed) as name, index (index)}{index ? '、' : ''}<span class="window">{name}</span>{/each}{view.missed.length > MISSED_NAMED ? ` 等共 ${view.missed.length} 期` : ''}
				看板都沒開，所以沒跑。不會自動補跑。
			</p>
			<div class="actions">
				<button type="button" class="primary" disabled={busy || running || task.kind !== 'command'} onclick={() => act(() => runTask(task.id))}>立即執行</button>
				<button type="button" disabled={busy} onclick={() => act(() => dismissMissed(task.id))}>這期就算了</button>
			</div>
		</section>
	{/if}
	<div class="actions">
		{#if !view.missed.length}
			<button type="button" class="primary" disabled={busy || running || task.kind !== 'command'} onclick={() => act(() => runTask(task.id))}>立即執行</button>
		{/if}
		<button type="button" disabled={busy} onclick={() => act(() => pauseTask(task.id, !task.paused))}>{task.paused ? '恢復' : '暫停'}</button>
		<button type="button" onclick={onedit}>編輯</button>
	</div>
	{#if notice}
		<p class="notice" role="alert">{notice}</p>
	{:else if running}
		<p class="hint">正在跑，這次結束後才能再按立即執行。</p>
	{:else if task.kind !== 'command'}
		<p class="hint">Agent 任務還不能從看板執行，設定先存著。</p>
	{/if}

	<dl class="kv">
		<dt>種類</dt>
		<dd>
			{#if task.kind === 'agent' && task.agent}
				Agent · {clientName(task.agent.client)} {task.agent.model} · 強度{EFFORT_TEXT[task.agent.effort]}
			{:else}
				{kindText(task.kind)}
			{/if}
		</dd>
		<dt>排程</dt>
		<dd>{scheduleText(task.schedule, task.time)}，成功後本期不再跑</dd>
		{#if task.command}
			<dt>指令</dt>
			<dd class="mono">{task.command.command}</dd>
			<dt>資料夾</dt>
			<dd class="mono">{task.command.folder}</dd>
			<dt>固定檢查</dt>
			<dd>
				{#if task.command.checks.length}
					<ul class="plain">
						{#each task.command.checks as check, index (index)}
							<li>{check.type === 'file' ? `檔案存在：${check.path}` : `輸出含「${check.text}」`}</li>
						{/each}
					</ul>
				{:else}
					沒有
				{/if}
			</dd>
		{:else if task.agent}
			<dt>資料夾</dt>
			<dd class="mono">{task.agent.folder}</dd>
			<dt>任務說明檔</dt>
			<dd class="mono">{task.agent.brief}</dd>
		{/if}
		<dt>跑完後請 Agent 檢查</dt>
		<dd>{task.review.enabled ? `開，用 ${clientName(task.review.client)} ${task.review.model} · 強度${EFFORT_TEXT[task.review.effort]}` : '關'}</dd>
		<dt>最久跑多久</dt>
		<dd>{task.limitMinutes} 分鐘</dd>
		<dt>下次</dt>
		<dd>{view.nextAt === null ? (task.paused ? '暫停中不會自動跑' : '—') : `${at.full(view.nextAt)}${view.nextAt <= clock.now ? '（已到時間）' : ''}`}</dd>
	</dl>

	{#if task.review.checklist.length}
		<h3>驗收清單</h3>
		<ul class="checklist">
			{#each task.review.checklist as line, index (index)}<li>{line}</li>{/each}
		</ul>
	{/if}

	<h3>執行紀錄</h3>
	{#if view.runs.length === 0}
		<p class="hint">還沒跑過。</p>
	{/if}
	{#each view.runs as run (run.id)}
		{@const live = run.status === 'running'}
		<section class="run" class:bad={!live && run.status !== 'success' && run.status !== 'skipped'} class:skip={run.status === 'skipped'} class:live data-run={run.id} data-status={run.status}>
			<div class="when">
				<b>{at.full(run.startedAt)}{run.endedAt === undefined || run.status === 'skipped' || run.trigger === 'carried' ? '' : ` → ${sameDay(run.startedAt, run.endedAt) ? at.clock(run.endedAt) : at.full(run.endedAt)}`}</b>
				<AutomationState status={run.status} />
				<span class="trigger">{TRIGGER_TEXT[run.trigger]}</span>
			</div>
			{#if live}
				<p>已跑 {minutes(run.startedAt, clock.now)} 分鐘，上限 {task.limitMinutes} 分鐘</p>
			{:else}
				<p class="reason">{runReason(run)}</p>
			{/if}
			{#if run.checks?.length}
				<ul class="checks">
					{#each run.checks as check, index (index)}
						<li class:failed={!check.ok}><b aria-label={check.ok ? '通過' : '沒過'}>{check.ok ? '✓' : '✕'}</b><span>{check.label}{check.detail ? `：${check.detail}` : ''}</span></li>
					{/each}
				</ul>
			{/if}
			{#if run.output}
				<details ontoggle={(event) => openOutput(run, event)}>
					<summary>看指令輸出{run.outputTruncated ? '（只留最後一段）' : ''}</summary>
					<p class="where">存在看板設定資料夾的 <span class="mono">automation/{run.output}</span></p>
					<pre>{outputs[run.id] ?? '讀取中…'}</pre>
				</details>
			{/if}
		</section>
	{/each}
</div>

<style>
	.task {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
		max-width: 46rem;
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
	h3 {
		margin: 0.4rem 0 0;
		font-size: inherit;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.actions button {
		min-height: 48px;
	}
	.notice {
		margin: 0;
		color: var(--danger);
		font-weight: 600;
	}
	.hint,
	.where {
		margin: 0;
		color: var(--muted);
	}
	.kv {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.2rem 1rem;
		margin: 0.2rem 0;
	}
	.kv dt {
		color: var(--muted);
	}
	.kv dd {
		margin: 0;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.mono,
	pre {
		font-family: var(--mono);
	}
	.plain {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.checklist {
		margin: 0;
		padding-left: 1.3rem;
	}
	.run {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		padding: 0.5rem 0.8rem;
		border: 1px solid var(--line);
		border-left: 5px solid var(--ok);
		border-radius: var(--radius);
		background: var(--surface);
		min-width: 0;
	}
	.run.bad {
		border-left-color: var(--danger);
	}
	.run.live {
		border-left-color: var(--accent);
	}
	.run.skip {
		border-left-color: var(--line);
	}
	.missed {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		padding: 0.5rem 0.8rem;
		border: 2px solid var(--warn);
		border-radius: var(--radius);
		background: var(--surface);
		overflow-wrap: anywhere;
	}
	.missed p {
		margin: 0;
	}
	.window {
		white-space: nowrap;
	}
	.run p {
		margin: 0;
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
	.checks li.failed {
		color: var(--danger);
	}
	summary {
		min-height: 44px;
		display: flex;
		align-items: center;
		color: var(--accent);
		cursor: pointer;
	}
	pre {
		margin: 0.3rem 0 0;
		padding: 0.5rem;
		max-height: 24rem;
		overflow: auto;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		font-size: max(0.85rem, var(--min-font, 0px));
	}
	@media (max-width: 600px) {
		.kv {
			grid-template-columns: 1fr;
		}
		.kv dt {
			margin-top: 0.3rem;
		}
	}
</style>
