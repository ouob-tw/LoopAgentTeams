<script lang="ts">
	// The controller's model and effort on its information page: what the latest turn used, whether
	// the last switch took, an open Codex switch to continue, and the form to change them.
	import { messaging, type Outcome } from '#lib/board/messaging.svelte.ts';
	import {
		BUSY_REASON,
		choiceText,
		FIXED_MODEL_REASON,
		lastApplied,
		LOCK_UNKNOWN_TEXT,
		NOT_RUNNING_REASON,
		settingsText,
		SWITCH_MISSED_TEXT,
		SWITCH_STATE_TEXT,
		SWITCH_WAITING_TEXT,
		switchCheck,
		type SwitchView
	} from '#lib/board/models.ts';
	import { switching } from '#lib/board/switching.svelte.ts';
	import type { Controller } from '#lib/board/types.ts';
	import { ABANDON_CONFIRM_TEXT } from '#lib/board/wake.ts';

	let { controller }: { controller: Controller } = $props();

	const id = $derived(controller.id);
	const status = $derived(switching.status[id]);
	const current = $derived(switching.current[id]);
	const entries = $derived(messaging.sent[id] ?? []);
	const open = $derived(entries.find((entry): entry is SwitchView => entry.kind === 'switch' && entry.open));
	const check = $derived(switchCheck(lastApplied(entries), current ?? null));
	const codex = $derived(controller.client === 'codex');
	const modelFixed = $derived(status?.lock === 'fixed');

	// All by controller ID: the block is reused when another controller is opened.
	let editing = $state<Record<string, boolean>>({});
	/** '' keeps the current value. */
	let model = $state<Record<string, string>>({});
	let effort = $state<Record<string, string>>({});
	let inFlight = $state<Record<string, boolean>>({});
	let outcomes = $state<Record<string, Outcome>>({});
	let confirming = $state<Record<string, string>>({});
	let abandoned = $state<Record<string, Outcome>>({});
	const sending = $derived(inFlight[id] ?? false);
	const outcome = $derived(outcomes[id]);
	const chosen = $derived(!!(model[id] || effort[id]));

	// Read again when another controller is opened, or this one starts or ends.
	$effect(() => {
		void controller.status;
		const abort = new AbortController();
		void switching.load(id, abort.signal);
		return () => abort.abort();
	});

	/** Send the form, or continue the open switch as it is when nothing is chosen. */
	async function submit(continuing: boolean) {
		if (sending) return;
		const target = id;
		const choice = continuing && !editing[target] ? { model: null, effort: null } : { model: model[target] || null, effort: effort[target] || null };
		inFlight[target] = true;
		delete outcomes[target];
		delete confirming[target];
		delete abandoned[target];
		const result = await switching.switch(target, choice);
		inFlight[target] = false;
		outcomes[target] = result;
		if (result.ok) {
			editing[target] = false;
			delete model[target];
			delete effort[target];
		}
	}

	async function abandon(wakeId: string) {
		const target = id;
		delete confirming[target];
		abandoned[target] = await messaging.abandon(target, wakeId);
		if (abandoned[target].ok) delete outcomes[target];
	}
</script>

<section class="model" data-block="model">
	<h3>模型與思考強度</h3>
	<p class="current">
		上一回合使用：{current === undefined ? '讀取中…' : current ? settingsText(current) : '不明'}
	</p>
	{#if check === 'waiting'}
		<p class="note" role="status">{SWITCH_WAITING_TEXT}</p>
	{:else if check === 'missed'}
		<p class="failed" role="alert">
			{SWITCH_MISSED_TEXT}：下一回合實際是 {settingsText(current)}{codex ? '（常見原因：當初啟動時指定了 --model）' : ''}
		</p>
	{/if}

	{#if open}
		<div class="open" role="group" aria-label="切換尚未完成">
			<p><strong>切換尚未完成：{SWITCH_STATE_TEXT[open.state]}</strong></p>
			{#if open.error}<p class="failed">{open.error}</p>{/if}
			<p class="note">舊設定：{open.from ? settingsText(open.from) : '不明'}</p>
			<p class="note">新設定：{choiceText(open.to)}</p>
			<button type="button" class="primary" disabled={sending} onclick={() => submit(true)}>
				{sending ? '處理中…' : '繼續切換'}
			</button>
		</div>
	{/if}

	{#if switching.loadFailed[id] && !status}
		<p class="failed" role="alert">讀不到能不能切換，請重新整理。</p>
	{:else if status && !status.options}
		<p class="note">看板不會切換 {controller.client} 主控的模型與思考強度。</p>
	{:else if status?.options}
		{#if status.running === false && !open}
			<p class="note">{NOT_RUNNING_REASON}。</p>
		{:else if !editing[id]}
			{#if status.running === null}
				<p class="note">{status.reason}</p>
			{:else if codex && status.status !== 'listening' && !open}
				<p class="note">{BUSY_REASON}。</p>
			{/if}
			<button type="button" onclick={() => (editing[id] = true)}>修改</button>
		{:else}
			<form
				class="edit"
				onsubmit={(event) => {
					event.preventDefault();
					void submit(!!open);
				}}
			>
				<label>
					模型
					<select bind:value={() => model[id] ?? '', (value) => (model[id] = value)} disabled={modelFixed}>
						<option value="">保持目前</option>
						{#each status.options.models as option (option)}
							<option value={option}>{option}</option>
						{/each}
					</select>
				</label>
				<label>
					思考強度
					<select bind:value={() => effort[id] ?? '', (value) => (effort[id] = value)}>
						<option value="">保持目前</option>
						{#each status.options.efforts as option (option)}
							<option value={option}>{option}</option>
						{/each}
					</select>
				</label>
				{#if modelFixed}
					<p class="note">{FIXED_MODEL_REASON}。</p>
				{:else if status.lock === 'unknown'}
					<p class="note">{LOCK_UNKNOWN_TEXT}（{status.lockReason}），送出後以下一回合核對結果。</p>
				{/if}
				{#if codex}
					<p class="note">Codex 會關掉原本的分頁，用新設定在新分頁接回同一段對話；只在主控等待時可以改。</p>
				{/if}
				<div class="actions">
					<button class="primary" disabled={sending || !chosen}>{sending ? '送出中…' : '送出切換'}</button>
					<button type="button" onclick={() => (editing[id] = false)}>取消</button>
				</div>
			</form>
		{/if}
	{/if}

	{#if outcome?.ok}
		<p class="note" role="status">✓ {open ? SWITCH_STATE_TEXT[open.state] : '已送出切換'}{outcome.reason ?? ''}</p>
	{:else if outcome}
		<p class="failed" role="alert">✗ {outcome.reason}</p>
		{#if outcome.abandon && confirming[id] !== outcome.abandon}
			<button type="button" onclick={() => (confirming[id] = outcome.abandon!)}>放棄前一次接回</button>
		{/if}
	{/if}
	{#if confirming[id]}
		<div class="confirm" role="alertdialog" aria-label="放棄前一次接回">
			<p>{ABANDON_CONFIRM_TEXT}</p>
			<div class="actions">
				<button type="button" class="danger" onclick={() => abandon(confirming[id])}>確認放棄</button>
				<button type="button" onclick={() => delete confirming[id]}>取消</button>
			</div>
		</div>
	{/if}
	{#if abandoned[id]?.ok}
		<p class="note" role="status">✓ 已放棄前一次接回，可以再按「繼續切換」。</p>
	{:else if abandoned[id]}
		<p class="failed" role="alert">✗ {abandoned[id].reason}</p>
	{/if}
</section>

<style>
	.model {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		align-items: flex-start;
	}
	h3 {
		margin: 0;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--muted);
	}
	p {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.note {
		font-size: 0.85rem;
		color: var(--muted);
	}
	.failed {
		color: var(--danger);
	}
	.open,
	.confirm {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		align-items: flex-start;
		align-self: stretch;
		border: 1px solid var(--danger);
		border-radius: var(--radius);
		padding: 0.6rem 0.7rem;
	}
	.edit {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1rem;
		align-items: flex-end;
		align-self: stretch;
	}
	.edit label {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: 0.85rem;
	}
	.edit .note {
		flex-basis: 100%;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	button.danger {
		color: var(--danger);
		border-color: var(--danger);
	}
</style>
