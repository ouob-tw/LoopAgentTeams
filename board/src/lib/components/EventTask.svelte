<script lang="ts">
	// An event task in the content column (#765): its name with 一次性／可重複 and 詳細資料 on the
	// title row (as a 週期任務's page, #756), what it waits for or how it ended, and its actions:
	// 立即觸發 while waiting, 重試接手 after 接手失敗 or 接手結果不明 (with the warning that the last
	// one may have arrived), 停止這次 while its new Agent runs, 暫停／恢復 and 刪除. 詳細資料 holds the
	// trigger, deadline, 次數, handoff, the verified controller and the passkey approval. Below, one
	// record per handoff, newest first. There is no 編輯: a change is a new proposal.
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import { clock } from '#lib/board/clock.svelte.ts';
	import { clientName, EFFORT_TEXT, isOpen, runLabel, runReason, timeFormat, workedText, type AutomationRun } from '#lib/board/automation.ts';
	import { deleteTask, pauseTask, retryHandoff, stopTask, triggerTask } from '#lib/board/automation-actions.ts';
	import { attemptText, controllerOf, eventLines, type EventTaskViewOf } from '#lib/board/event-task-view.ts';
	import { attemptMark, CAUSE_TEXT, closingOf, eventRows, isEnded, repeatText, UNKNOWN_RETRY_WARNING, type RunHandoff } from '#lib/board/event-tasks.ts';
	import { proposerName, ROLE_LABELS, VERIFIED } from '#lib/board/task-proposals.ts';
	import { testDevice } from '#lib/board/test-device.svelte.ts';
	import EventMark from './EventMark.svelte';
	import TestDenied from './TestDenied.svelte';

	let {
		view,
		timeZone,
		onchanged,
		onopenagent,
		ondeleted
	}: {
		view: EventTaskViewOf;
		timeZone: string;
		onchanged: () => void;
		onopenagent: (sessionId: string) => void;
		ondeleted: () => void;
	} = $props();

	const task = $derived(view.task);
	const settings = $derived(view.task.event);
	const phase = $derived(view.event.state);
	const taskId = $derived(view.task.id);
	const at = $derived(timeFormat(timeZone));
	const lines = $derived(eventLines(view, timeZone));
	const ended = $derived(isEnded(phase));
	const runningRun = $derived(view.runs.find(isOpen));
	const handoffs = $derived(view.runs.filter((run): run is AutomationRun & { handoff: RunHandoff } => run.handoff !== undefined));
	const lastAttempt = $derived(handoffs[0]);
	const controller = $derived(controllerOf(view));
	const testing = $derived(testDevice.view !== null);

	/** 詳細資料 is open; another task starts closed. */
	let details = $derived.by(() => {
		void taskId;
		return false;
	});
	/** 刪除 was pressed and waits for 確定刪除. */
	let confirmingDelete = $derived.by(() => {
		void taskId;
		return false;
	});
	/** What the last button pressed here answered, when it was refused. */
	let notice = $state<string | null>(null);
	let busy = $state(false);
	/** The attempt 重試接手 was pressed on: the button is off until a later attempt is on record
	 *  (it may fail again at once, and is offered again then). */
	let retriedFrom = $state<number | null>(null);
	const retrying = $derived(retriedFrom !== null && (lastAttempt?.handoff.attempt ?? 0) <= retriedFrom);

	async function act(step: () => Promise<{ ok: boolean; message?: string }>) {
		busy = true;
		notice = null;
		const done = await step();
		busy = false;
		if (!done.ok) notice = done.message ?? null;
		onchanged();
		return done.ok;
	}
	async function retry() {
		retriedFrom = lastAttempt?.handoff.attempt ?? 0;
		if (!(await act(() => retryHandoff(task.id)))) retriedFrom = null;
	}
	let deleting = $state(false);
	async function remove() {
		deleting = true;
		notice = null;
		const done = await deleteTask(task.id);
		deleting = false;
		if (!done.ok) {
			notice = done.message;
			confirmingDelete = false;
			onchanged();
			return;
		}
		ondeleted();
	}

	const trigger = $derived(eventRows(settings.event, at.full));
	/** Where a record's link goes: the new Agent's conversation, or the controller's. */
	function sessionOf(run: AutomationRun & { handoff: RunHandoff }): string | undefined {
		if (settings.handoff === 'new-agent') return run.sessionId;
		if (run.handoff.status !== 'handed') return undefined;
		return run.handoff.evidence?.sessionId ?? task.source?.proposer.sessionId ?? undefined;
	}
	/** A reusable task's attempt that was handed over and whose run is over: it waits again from there. */
	const waitedAgain = (run: AutomationRun & { handoff: RunHandoff }) =>
		settings.repeat && run.handoff.status === 'handed' && run.endedAt !== undefined && closingOf(settings, run.handoff, view.event.deadlineAt) === null;
	const openAgent = (sessionId: string, event: MouseEvent) => {
		event.preventDefault();
		onopenagent(sessionId);
	};
</script>

<div class="task" data-task={task.id} data-event-task>
	<header>
		<div class="title">
			<h2>{task.name}</h2>
			<span class="chip" data-repeat>{repeatText(settings.repeat)}</span>
		</div>
		<button type="button" class="more" aria-expanded={details} onclick={() => ((details = !details), (confirmingDelete = false))}>
			詳細資料<span class="chevron" class:open={details}><ChevronDown size="1em" /></span>
		</button>
	</header>
	<div class="status">
		<EventMark mark={lines.mark} state={phase} />
		<p class="line" data-line>{lines.line}</p>
		{#if (phase === 'failed' || phase === 'unknown') && lastAttempt?.handoff.reason}
			<p class="reason">原因：{lastAttempt.handoff.reason}</p>
		{/if}
		{#if view.event.readError}
			<p class="warn" data-read-error>{view.event.readError}</p>
		{/if}
	</div>

	{#if phase === 'unknown'}
		<p class="caution" data-unknown-warning role="note"><b>⚠ 重試前請先確認</b>{UNKNOWN_RETRY_WARNING}</p>
	{/if}
	{#if confirmingDelete}
		<div class="confirm" role="group" aria-label="確認刪除任務">
			<p><b>要刪除「{task.name}」嗎？</b>設定和全部紀錄會一起移除，不能復原。</p>
			<div class="actions">
				<button type="button" class="remove" disabled={deleting || testing} onclick={remove}>{deleting ? '刪除中…' : '確定刪除'}</button>
				<button type="button" disabled={deleting} onclick={() => (confirmingDelete = false)}>取消</button>
			</div>
		</div>
	{:else}
		<div class="actions">
			{#if phase === 'waiting'}
				<button type="button" class="primary" data-action="trigger" disabled={busy || !view.event.canTrigger || testing} onclick={() => act(() => triggerTask(task.id))}>立即觸發</button>
			{:else if phase === 'failed' || phase === 'unknown' || (phase === 'handing' && (lastAttempt?.handoff.attempt ?? 1) > 1)}
				<button type="button" class="primary" data-action="retry" disabled={busy || retrying || !view.event.canRetry || testing} onclick={retry}>{phase === 'handing' || retrying ? '重試中…' : '重試接手'}</button>
			{/if}
			{#if runningRun && settings.handoff === 'new-agent'}
				<button type="button" class="danger" data-action="stop" disabled={busy} onclick={() => act(() => stopTask(task.id))}>停止這次</button>
			{/if}
			{#if !ended}
				<button type="button" data-action="pause" disabled={busy} onclick={() => act(() => pauseTask(task.id, !task.paused))}>{task.paused ? '恢復' : '暫停'}</button>
			{/if}
			<button type="button" class="danger" data-action="delete" disabled={busy || runningRun !== undefined || testing} onclick={() => (confirmingDelete = true)}>刪除</button>
		</div>
		{#if runningRun}
			<p class="hint">Agent 還在跑，等它結束或按「停止這次」之後才能刪除。</p>
		{/if}
		<TestDenied />
	{/if}
	{#if notice}
		<p class="notice" role="alert">{notice}</p>
	{/if}

	{#if details}
		<dl class="kv" data-details>
			<dt>觸發條件</dt>
			<dd>
				<b>{trigger.kind}</b>
				{#each trigger.rows as row (row.label)}
					<br /><span class="muted">{row.label}</span> <span class:mono={row.mono}>{row.value}</span>
				{/each}
			</dd>
			<dt>期限</dt>
			<dd>{at.full(view.event.deadlineAt)}</dd>
			<dt>次數</dt>
			<dd>{repeatText(settings.repeat)}</dd>
			<dt>接手方式</dt>
			<dd>
				{#if settings.handoff === 'resume'}
					接回原主控{#if controller}{' '}<span class="mono">{controller}</span>{/if}{' '}的對話
				{:else if task.agent}
					開新 Agent<br />{clientName(task.agent.client)} · 強度{EFFORT_TEXT[task.agent.effort]}<br /><span class="mono">{task.agent.model}</span>
					<br /><span class="muted">資料夾</span> <span class="mono">{task.agent.folder}</span>
					<br /><span class="muted">說明檔</span> <span class="mono">{task.agent.brief}</span>{#if task.source?.brief && task.source.brief.path === task.agent.brief}<span class="muted">（核准時的版本）</span>{/if}
					<br /><span class="muted">最久跑多久</span> {task.limitMinutes} 分鐘
				{:else}
					開新 Agent
				{/if}
			</dd>
			{#if task.source}
				{@const proposer = task.source.proposer}
				<dt>註冊者</dt>
				<dd>
					<span class="who">{VERIFIED}<span class="nw">{proposerName(proposer)}</span>{#if proposer.role !== 'agent'}<span class="role" class:boss={proposer.role === 'controller'}>{ROLE_LABELS[proposer.role]}</span>{/if}</span>
					<br /><span class="muted">已查證送出的程序，非防竄改</span>
				</dd>
				<dt>核准</dt>
				<dd>以 passkey 核准於 {at.full(Date.parse(task.source.approvedAt))}</dd>
			{/if}
		</dl>
	{/if}

	<h3>執行紀錄</h3>
	{#if handoffs.length === 0}
		<p class="hint">還沒觸發過。</p>
	{/if}
	{#each handoffs as run (run.id)}
		{@const handoff = run.handoff}
		{@const mark = attemptMark(handoff)}
		{@const session = sessionOf(run)}
		{@const live = run.status === 'running'}
		{#if waitedAgain(run)}
			<section class="run idle" data-waited-again>
				<div class="when"><b>{at.full(run.endedAt!)}</b></div>
				<p>重新開始等待</p>
			</section>
		{/if}
		<section class="run tone-{mark.tone}" data-run={run.id} data-handoff={handoff.status}>
			<div class="when">
				<b>{at.full(run.startedAt)}</b>
				<EventMark {mark} state={handoff.status} />
				{#if handoff.attempt > 1}<span class="chip">第 {handoff.attempt} 次</span>{/if}
			</div>
			<p>{CAUSE_TEXT[handoff.event.cause]}</p>
			{#each handoff.event.details as detail, index (index)}
				<p class="detail-line">{detail}</p>
			{/each}
			<p>{attemptText(view, handoff)}{handoff.reason ? `：${handoff.reason}` : ''}</p>
			{#if settings.handoff === 'new-agent' && handoff.status === 'handed'}
				<p class="agent-run">
					{#if live}Agent {workedText(run, clock.now)}，上限 {task.limitMinutes} 分鐘{:else}Agent {runLabel(run).text.slice(2)}：{runReason(run)}{/if}
				</p>
			{/if}
			{#if session}
				<a class="agent-link" href={`?agent=${encodeURIComponent(session)}`} onclick={(event) => openAgent(session, event)}
					>{settings.handoff === 'resume' ? '打開主控看對話' : live ? '打開 Agent 看即時畫面' : '打開 Agent 看對話'} ›</a
				>
			{/if}
		</section>
	{/each}
</div>

<style>
	.task {
		display: flex;
		flex-direction: column;
		line-height: 1.6;
		gap: 0.5rem;
		min-width: 0;
		max-width: 46rem;
	}
	/* 詳細資料 never takes a line of its own: the name and its 次數 wrap beside it. */
	header {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
	}
	.title {
		flex: 1;
		min-width: 0;
	}
	h2 {
		display: inline;
		margin: 0 0.6rem 0 0;
		font-size: max(1.15rem, var(--min-font, 0px));
		overflow-wrap: anywhere;
	}
	h3 {
		margin: 0.4rem 0 0;
		font-size: inherit;
	}
	.more {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		min-height: 44px;
		margin: -0.5rem 0;
		padding: 0;
		border: 0;
		background: none;
		font-size: max(1rem, var(--min-font, 0px));
		color: var(--accent);
		white-space: nowrap;
	}
	.chevron {
		display: inline-flex;
		transition: transform 0.15s;
	}
	.chevron.open {
		transform: rotate(180deg);
	}
	@media (prefers-reduced-motion: reduce) {
		.chevron {
			transition: none;
		}
	}
	.chip {
		display: inline-block;
		padding: 0 0.6rem;
		border-radius: var(--radius-pill);
		background: color-mix(in srgb, var(--text) 10%, var(--bg));
		white-space: nowrap;
	}
	.status {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.2rem;
		min-width: 0;
	}
	.status p,
	.run p {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.reason,
	.notice {
		color: var(--danger);
		font-weight: 700;
	}
	.notice {
		margin: 0;
	}
	.warn {
		color: var(--warn);
		font-weight: 700;
	}
	.caution {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0.5rem 0.8rem;
		border: 2px solid var(--warn);
		border-radius: var(--radius);
		background: var(--surface);
		overflow-wrap: anywhere;
	}
	.caution b {
		color: var(--warn);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.actions button {
		min-height: 48px;
	}
	.actions button.primary,
	.actions button.danger {
		font-weight: 700;
	}
	.actions button.danger:not(:disabled) {
		color: var(--danger);
		border-color: var(--danger);
	}
	.actions button:disabled {
		color: var(--muted);
		border-style: dashed;
	}
	.confirm {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.6rem 0.8rem;
		border: 2px solid var(--danger);
		border-radius: var(--radius);
		background: var(--surface);
		overflow-wrap: anywhere;
	}
	.confirm p {
		margin: 0;
	}
	.actions button.remove {
		font-weight: 700;
		background: var(--danger);
		border-color: var(--danger);
		color: var(--bg);
	}
	.hint {
		margin: 0;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.kv {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.2rem 1rem;
		margin: 0.2rem 0;
		padding: 0.5rem 0.8rem;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--surface);
	}
	.kv dt {
		color: var(--muted);
	}
	.kv dd {
		margin: 0;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.muted {
		color: var(--muted);
	}
	.mono {
		font-family: var(--mono);
	}
	.who {
		overflow-wrap: anywhere;
	}
	.nw {
		display: inline-block;
		max-width: 100%;
	}
	.role {
		display: inline-block;
		margin-left: 0.4rem;
		padding: 0 0.5rem;
		border: 1px solid var(--muted);
		border-radius: var(--radius-pill);
		color: var(--muted);
		font-weight: 700;
		white-space: nowrap;
	}
	.role.boss {
		border-color: var(--accent);
		color: var(--accent);
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
	.run.tone-bad {
		border-left-color: var(--danger);
	}
	.run.tone-warn {
		border-left-color: var(--warn);
	}
	.run.tone-going {
		border-left-color: var(--accent);
	}
	.run.idle {
		border-left-color: var(--line);
	}
	.when {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.2rem 0.6rem;
		min-width: 0;
	}
	.agent-run,
	.detail-line {
		color: var(--muted);
	}
	.agent-link {
		align-self: flex-start;
		min-height: 44px;
		display: inline-flex;
		align-items: center;
		color: var(--accent);
		font-weight: 700;
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
