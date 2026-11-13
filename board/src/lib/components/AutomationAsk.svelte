<script lang="ts">
	// The question an agent task's agent waits on (等你回覆) and the box to answer it: 送出回覆 sends
	// the answer to the agent, which goes on. On the yellow card it also has 打開 Agent 看即時畫面 and
	// 停止這次; on the task's page those sit with the run already.
	import { timeFormat, type AutomationRun, type RunAsk } from '#lib/board/automation.ts';
	import { replyTask, stopTask } from '#lib/board/automation-actions.ts';
	import { testDevice } from '#lib/board/test-device.svelte.ts';

	let {
		taskId,
		run,
		ask,
		limitMinutes,
		timeZone,
		withControls = false,
		onopenagent,
		onchanged
	}: {
		taskId: string;
		run: AutomationRun;
		ask: RunAsk;
		limitMinutes: number;
		timeZone: string;
		/** 打開 Agent 看即時畫面 and 停止這次 beside 送出回覆. */
		withControls?: boolean;
		onopenagent: (sessionId: string) => void;
		onchanged: () => void;
	} = $props();

	const at = $derived(timeFormat(timeZone));
	const deadline = $derived(run.startedAt + limitMinutes * 60_000);
	let text = $state('');
	let busy = $state(false);
	let stopping = $state(false);
	let notice = $state<string | null>(null);

	async function send() {
		if (!text.trim()) {
			notice = '請先寫回覆內容';
			return;
		}
		busy = true;
		notice = null;
		const done = await replyTask(taskId, text);
		busy = false;
		if (done.ok) text = '';
		else notice = done.message;
		onchanged();
	}

	async function stop() {
		stopping = true;
		notice = null;
		const done = await stopTask(taskId);
		if (!done.ok) {
			stopping = false;
			notice = done.message;
		}
		onchanged();
	}
</script>

<div class="ask" data-ask={run.id}>
	<div class="question">
		<b>Agent 問你（{at.clock(ask.askedAt)}）：</b>
		<p>{ask.question}</p>
	</div>
	<label for="reply-{run.id}">你的回覆：送給這個 Agent，它收到就接著做</label>
	<textarea id="reply-{run.id}" bind:value={text} rows="3" disabled={busy || testDevice.view !== null}></textarea>
	<div class="actions">
		<button type="button" class="primary" disabled={busy || stopping || testDevice.view !== null} onclick={send}>{busy ? '送出中…' : '送出回覆'}</button>
		{#if withControls}
			{#if run.sessionId}
				<button type="button" onclick={() => onopenagent(run.sessionId!)}>打開 Agent 看即時畫面</button>
			{/if}
			<button type="button" class="danger" disabled={busy || stopping || testDevice.view !== null} onclick={stop}>{stopping ? '停止中…' : '停止這次'}</button>
		{/if}
	</div>
	{#if notice}
		<p class="notice" role="alert">{notice}</p>
	{/if}
	<p class="hint">還沒回覆前，Agent 開著等你，不算失敗；超過上限（{limitMinutes} 分鐘，<span class="keep">{at.day(deadline) === at.day(ask.askedAt) ? at.clock(deadline) : at.full(deadline)} 前要回覆</span>）才算失敗並關掉。</p>
</div>

<style>
	.ask {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		min-width: 0;
		line-height: 1.6;
		overflow-wrap: anywhere;
	}
	.question {
		padding: 0.5rem 0.8rem;
		border: 2px solid var(--ask);
		border-radius: var(--radius);
		background: color-mix(in srgb, var(--ask-fill) 12%, var(--surface));
		min-width: 0;
	}
	.question p,
	.hint,
	.notice {
		margin: 0;
	}
	.question p {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	label {
		font-weight: 700;
	}
	textarea {
		width: 100%;
		min-height: 5rem;
		font: inherit;
		line-height: 1.6;
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
	.notice {
		color: var(--danger);
		font-weight: 700;
	}
	.hint {
		color: var(--muted);
	}
	.keep {
		white-space: nowrap;
	}
</style>
