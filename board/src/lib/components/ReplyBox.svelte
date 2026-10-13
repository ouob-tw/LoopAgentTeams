<script lang="ts">
	// Sends a message to one controller. The text stays in the box unless it was delivered.
	import { ENDED_REASON } from '#lib/board/messages.ts';
	import { enterMakesNewline, messaging, type Outcome } from '#lib/board/messaging.svelte.ts';
	import type { Controller } from '#lib/board/types.ts';
	import MessageBox from './MessageBox.svelte';

	let { controller }: { controller: Controller } = $props();

	const ended = $derived(controller.status === 'ended');
	const text = $derived(messaging.drafts[controller.id] ?? '');
	// Both by controller ID: the box is reused when another controller is opened.
	let inFlight = $state<Record<string, boolean>>({});
	const sending = $derived(inFlight[controller.id] ?? false);
	let outcomes = $state<Record<string, Outcome>>({});
	const outcome = $derived(outcomes[controller.id]);

	function edit(value: string) {
		messaging.drafts[controller.id] = value;
		delete outcomes[controller.id];
	}

	async function submit() {
		if (sending || ended || !text.trim()) return;
		const id = controller.id;
		const sentText = text;
		inFlight[id] = true;
		delete outcomes[id];
		const result = await messaging.send(id, sentText);
		inFlight[id] = false;
		// Only what was delivered leaves the box; anything typed meanwhile stays too.
		if (result.ok && messaging.drafts[id] === sentText) messaging.drafts[id] = '';
		outcomes[id] = result;
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
		label="傳話給 @{controller.hcomName}"
		placeholder={ended
			? ENDED_REASON
			: `傳話給 @${controller.hcomName}（${enterMakesNewline.current ? 'Enter 換行，按鈕送出' : 'Enter 送出，Shift+Enter 換行'}）`}
		disabled={ended}
		onsend={submit}
	/>
	<button class="primary" disabled={ended || sending || !text.trim()}>{sending ? '送出中…' : '送出'}</button>
	{#if ended}
		<p class="note">{ENDED_REASON}</p>
	{:else if outcome?.ok}
		<p class="note" role="status">✓ 已送出{outcome.reason ?? ''}</p>
	{:else if outcome}
		<p class="note failed" role="alert">✗ {outcome.reason}（文字還在輸入框裡）</p>
	{/if}
</form>

<style>
	.reply {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 0.5rem;
		align-items: end;
	}
	.note {
		grid-column: 1 / -1;
		margin: 0;
		font-size: 0.8rem;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.failed {
		color: var(--danger);
	}
</style>
