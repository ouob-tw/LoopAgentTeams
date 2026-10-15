<script lang="ts">
	// Sends a message to one controller, or wakes an ended one. The text stays in the box unless it
	// was delivered.
	import { enterMakesNewline, messaging, type Outcome } from '#lib/board/messaging.svelte.ts';
	import { EFFORT_UNKNOWN_TEXT, FIXED_MODEL_REASON, LOCK_UNKNOWN_TEXT } from '#lib/board/models.ts';
	import { switching } from '#lib/board/switching.svelte.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';
	import type { Controller } from '#lib/board/types.ts';
	import { ABANDON_CONFIRM_TEXT } from '#lib/board/wake.ts';
	import MessageBox from './MessageBox.svelte';

	let { controller }: { controller: Controller } = $props();

	const ended = $derived(controller.status === 'ended');
	const text = $derived(messaging.drafts[controller.id] ?? '');
	// All by controller ID: the box is reused when another controller is opened.
	let inFlight = $state<Record<string, boolean>>({});
	const sending = $derived(inFlight[controller.id] ?? false);
	let outcomes = $state<Record<string, Outcome>>({});
	const outcome = $derived(outcomes[controller.id]);
	// 「開新一輪 LAT」 starts unticked and is not remembered once a wake went through.
	let newRound = $state<Record<string, boolean>>({});
	/** The resume attempt whose abandon confirmation is open. */
	let confirming = $state<Record<string, string>>({});
	// A resume may take a new model and effort; '' keeps the current one. Only offered when the
	// client is known not to be running: a running one is typed into and keeps its settings.
	let model = $state<Record<string, string>>({});
	let effort = $state<Record<string, string>>({});
	const status = $derived(switching.status[controller.id]);
	const resumes = $derived(ended && status?.running === false && status.options !== null);

	function edit(value: string) {
		messaging.drafts[controller.id] = value;
		delete outcomes[controller.id];
	}

	async function submit() {
		if (sending || !text.trim()) return;
		const id = controller.id;
		const sentText = text;
		const waking = ended;
		inFlight[id] = true;
		delete outcomes[id];
		delete confirming[id];
		const choice = resumes
			? { model: status?.lock === 'fixed' ? null : model[id] || null, effort: effort[id] || null }
			: { model: null, effort: null };
		const result = waking ? await messaging.wake(id, sentText, newRound[id] ?? false, choice) : await messaging.send(id, sentText);
		inFlight[id] = false;
		// Only what was delivered leaves the box; anything typed meanwhile stays too.
		if (result.ok && messaging.drafts[id] === sentText) messaging.drafts[id] = '';
		if (result.ok) {
			delete newRound[id];
			delete model[id];
			delete effort[id];
		}
		outcomes[id] = result;
		toasts.show(
			result.ok ? 'ok' : 'failed',
			result.ok ? `${result.woke ? '' : '已送出'}${result.reason ?? ''}` : `${result.reason}（文字還在輸入框裡）`
		);
	}

	async function abandon(wakeId: string) {
		const id = controller.id;
		delete confirming[id];
		const result = await messaging.abandon(id, wakeId);
		if (result.ok) delete outcomes[id];
		toasts.show(result.ok ? 'ok' : 'failed', result.ok ? '已放棄前一次接回，可以再按「喚醒並送出」。' : (result.reason ?? '放棄失敗'));
	}
</script>

<form
	class="reply"
	onsubmit={(event) => {
		event.preventDefault();
		void submit();
	}}
>
	<MessageBox
		bind:value={() => text, edit}
		label="{ended ? '喚醒' : '傳話給'} @{controller.hcomName}"
		placeholder="{ended ? '喚醒' : '傳話給'} @{controller.hcomName}（{enterMakesNewline.current
			? 'Enter 換行，按鈕送出'
			: 'Enter 送出，Shift+Enter 換行'}）"
		onsend={submit}
	/>
	<button class="primary" disabled={sending || !text.trim()}>
		{sending ? '送出中…' : ended ? '喚醒並送出' : '送出'}
	</button>
	{#if ended}
		<label class="round">
			<input type="checkbox" bind:checked={() => newRound[controller.id] ?? false, (value) => (newRound[controller.id] = value)} />
			開新一輪 LAT
		</label>
		{#if resumes && status?.options}
			<div class="choice">
				<label>
					模型
					<select bind:value={() => model[controller.id] ?? '', (value) => (model[controller.id] = value)} disabled={status.lock === 'fixed'}>
						<option value="">保持目前</option>
						{#each status.options.models as option (option)}
							<option value={option}>{option}</option>
						{/each}
					</select>
				</label>
				<label>
					思考強度
					<select bind:value={() => effort[controller.id] ?? '', (value) => (effort[controller.id] = value)}>
						<option value="">保持目前</option>
						{#each status.options.efforts as option (option)}
							<option value={option}>{option}</option>
						{/each}
					</select>
				</label>
			</div>
			{#if model[controller.id] && status.lock !== 'fixed' && !effort[controller.id] && !switching.current[controller.id]?.effort}
				<p class="note">{EFFORT_UNKNOWN_TEXT}。</p>
			{/if}
			{#if status.lock === 'fixed'}
				<p class="note">{FIXED_MODEL_REASON}。</p>
			{:else if status.lock === 'unknown'}
				<p class="note">{LOCK_UNKNOWN_TEXT}（{status.lockReason}），接回後以下一回合核對結果。</p>
			{/if}
		{/if}
		<p class="note">
			主控已結束。它的分頁還開著就直接送進去；分頁已關會在 Herdr 開新分頁接回這段對話，並開始消耗額度。勾選「開新一輪 LAT」會在前面加上 LAT
			啟動指令。
		</p>
	{/if}
	{#if outcome && !outcome.ok && outcome.abandon && confirming[controller.id] !== outcome.abandon}
		<button type="button" class="abandon" onclick={() => (confirming[controller.id] = outcome.abandon!)}>放棄前一次接回</button>
	{/if}
	{#if confirming[controller.id]}
		<div class="confirm" role="alertdialog" aria-label="放棄前一次接回">
			<p>{ABANDON_CONFIRM_TEXT}</p>
			<div class="actions">
				<button type="button" class="danger" onclick={() => abandon(confirming[controller.id])}>確認放棄</button>
				<button type="button" onclick={() => delete confirming[controller.id]}>取消</button>
			</div>
		</div>
	{/if}
</form>

<style>
	.reply {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 0.5rem;
		align-items: end;
	}
	.note,
	.round,
	.choice,
	.abandon,
	.confirm {
		grid-column: 1 / -1;
	}
	.choice {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1rem;
	}
	.choice label {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: max(0.85rem, var(--min-font, 0px));
	}
	.note {
		margin: 0;
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.round {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		font-size: max(0.85rem, var(--min-font, 0px));
	}
	.abandon {
		justify-self: start;
	}
	.confirm {
		border: 1px solid var(--danger);
		border-radius: var(--radius);
		padding: 0.6rem 0.7rem;
	}
	.confirm p {
		margin: 0 0 0.5rem;
		overflow-wrap: anywhere;
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
