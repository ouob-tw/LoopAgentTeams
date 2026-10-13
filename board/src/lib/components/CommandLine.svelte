<script lang="ts">
	// The command line fixed at the bottom of the wide layout: `@name message` goes to that
	// controller, a line without a name to the controller that is open.
	import { parseCommand } from '#lib/board/messages.ts';
	import { enterMakesNewline, messaging, type Outcome } from '#lib/board/messaging.svelte.ts';
	import type { Controller } from '#lib/board/types.ts';
	import MessageBox from './MessageBox.svelte';

	let { controllers, target }: { controllers: Controller[]; target: Controller | undefined } = $props();

	let text = $state('');
	let sending = $state(false);
	let outcome = $state<(Outcome & { to?: string }) | null>(null);
	const command = $derived(parseCommand(text, controllers, target));
	const recipient = $derived(command.ok ? command.controller : text.trimStart().startsWith('@') ? undefined : target);

	async function submit() {
		if (sending || !text.trim()) return;
		// Names are checked against the board's data at the moment of sending.
		const parsed = command;
		if (!parsed.ok) {
			outcome = { ok: false, reason: parsed.reason };
			return;
		}
		const sentText = text;
		sending = true;
		outcome = null;
		const result = await messaging.send(parsed.controller.id, parsed.text);
		sending = false;
		if (result.ok && text === sentText) text = '';
		outcome = { ...result, to: parsed.controller.hcomName };
	}
</script>

<form
	class="cmd"
	onsubmit={(event) => {
		event.preventDefault();
		void submit();
	}}
>
	{#if outcome?.ok}
		<p class="note" role="status">✓ 已送給 @{outcome.to}{outcome.reason ?? ''}</p>
	{:else if outcome}
		<p class="note failed" role="alert">✗ {outcome.reason}{outcome.to ? '（文字還在輸入框裡）' : ''}</p>
	{/if}
	<span class="to">→ {recipient ? `@${recipient.hcomName}` : '@名稱'}</span>
	<MessageBox
		bind:value={() => text, (value) => ((text = value), (outcome = null))}
		label="指令列"
		placeholder="直接下指示；用 @名稱 指定主控（{enterMakesNewline.current ? 'Enter 換行，按鈕送出' : 'Enter 送出，Shift+Enter 換行'}）"
		onsend={submit}
	/>
	<button class="primary" disabled={sending || !text.trim()}>{sending ? '送出中…' : '送出'}</button>
</form>

<style>
	.cmd {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 10;
		display: grid;
		grid-template-columns: auto 1fr auto;
		gap: 0.6rem;
		align-items: end;
		padding: 0.6rem 1rem;
		background: var(--surface);
		border-top: 1px solid var(--line);
	}
	.to {
		padding-bottom: 0.5rem;
		font-family: var(--mono);
		font-size: 0.8rem;
		color: var(--muted);
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
	/* The narrow layout has no command line. */
	@media (max-width: 760px) {
		.cmd {
			display: none;
		}
	}
</style>
