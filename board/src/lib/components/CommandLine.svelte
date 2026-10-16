<script lang="ts">
	// The command line at the bottom of the wide layout: `@name message` goes to that controller,
	// a line without a name to the controller that is open. An ended or closed controller is woken
	// instead; the wake's options sit in a pop-up behind a button that is always there, so the line
	// keeps its size whoever it is for.
	import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
	import { parseCommand } from '#lib/board/messages.ts';
	import { enterMakesNewline, messaging } from '#lib/board/messaging.svelte.ts';
	import { EFFORT_UNKNOWN_TEXT, FIXED_MODEL_REASON, LOCK_UNKNOWN_TEXT } from '#lib/board/models.ts';
	import { switching } from '#lib/board/switching.svelte.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';
	import { isInactive, type Controller } from '#lib/board/types.ts';
	import { ABANDON_CONFIRM_TEXT } from '#lib/board/wake.ts';
	import MessageBox from './MessageBox.svelte';
	import SendButton from './SendButton.svelte';

	let { controllers, target }: { controllers: Controller[]; target: Controller | undefined } = $props();

	let text = $state('');
	let sending = $state(false);
	let sent = $state(0);
	let optionsOpen = $state(false);
	const command = $derived(parseCommand(text, controllers, target, true));
	const recipient = $derived(command.ok ? command.controller : text.trimStart().startsWith('@') ? undefined : target);
	const waking = $derived(recipient !== undefined && isInactive(recipient.status));

	// The wake's options, by controller ID. '' keeps the current model or effort.
	let newRound = $state<Record<string, boolean>>({});
	let model = $state<Record<string, string>>({});
	let effort = $state<Record<string, string>>({});
	/** The resume attempt that stopped the last wake and may be given up, by controller ID. */
	let abandonable = $state<Record<string, string>>({});
	/** Controllers whose abandon confirmation is open. */
	let confirming = $state<Record<string, boolean>>({});

	const id = $derived(recipient?.id ?? '');
	const status = $derived(waking ? switching.status[id] : undefined);
	// A new model and effort only apply when the client is known not to be running: a running one
	// is typed into and keeps its settings.
	const resumes = $derived(waking && status?.running === false && status.options !== null);

	// The pop-up belongs to one recipient: another one closes it.
	$effect.pre(() => {
		void id;
		optionsOpen = false;
	});

	$effect(() => {
		if (!waking) return;
		const abort = new AbortController();
		void switching.load(id, abort.signal);
		return () => abort.abort();
	});

	async function submit() {
		if (sending || !text.trim()) return;
		// Names are checked against the board's data at the moment of sending.
		const parsed = command;
		if (!parsed.ok) return toasts.show('failed', parsed.reason);
		const to = parsed.controller;
		const wake = isInactive(to.status);
		const sentText = text;
		sending = true;
		const choice = wake && resumes
			? { model: status?.lock === 'fixed' ? null : model[to.id] || null, effort: effort[to.id] || null }
			: { model: null, effort: null };
		const result = wake
			? await messaging.wake(to.id, parsed.text, newRound[to.id] ?? false, choice)
			: await messaging.send(to.id, parsed.text);
		sending = false;
		if (result.ok && text === sentText) text = '';
		if (result.ok) {
			delete newRound[to.id];
			delete model[to.id];
			delete effort[to.id];
			delete abandonable[to.id];
			optionsOpen = false;
			// The button shows it went through; the sent log has the wake's state and any log error.
			sent++;
			return;
		}
		if (result.abandon) {
			abandonable[to.id] = result.abandon;
			optionsOpen = true;
		}
		toasts.show('failed', `${result.reason}（文字還在輸入框裡）`);
	}

	async function abandon() {
		const target = id;
		const wakeId = abandonable[target];
		delete confirming[target];
		const result = await messaging.abandon(target, wakeId);
		if (result.ok) delete abandonable[target];
		toasts.show(result.ok ? 'ok' : 'failed', result.ok ? '已放棄前一次接回，可以再按「喚醒並送出」。' : (result.reason ?? '放棄失敗'));
	}
</script>

<form
	class="cmd"
	onsubmit={(event) => {
		event.preventDefault();
		void submit();
	}}
>
	<span class="to">→ {recipient ? `@${recipient.hcomName}` : '@名稱'}</span>
	<MessageBox
		bind:value={() => text, (value) => (text = value)}
		label="指令列"
		placeholder="{waking ? `喚醒 @${recipient?.hcomName}` : '直接下指示；用 @名稱 指定主控'}（{enterMakesNewline.current
			? 'Enter 換行，按鈕送出'
			: 'Enter 送出，Shift+Enter 換行'}）"
		onsend={submit}
	/>
	<button
		type="button"
		class="options"
		aria-label="喚醒選項"
		title={waking ? '喚醒選項：開新一輪 LAT、模型與思考強度' : '只有已結束的主控有喚醒選項'}
		aria-expanded={optionsOpen}
		disabled={!waking}
		onclick={() => (optionsOpen = !optionsOpen)}
	>
		<SlidersHorizontal size="1.1em" />
	</button>
	<SendButton class="send" label={waking ? '喚醒並送出' : '送出'} {sending} {sent} disabled={!text.trim()} />

	{#if optionsOpen && waking && recipient}
		<div class="popup" role="group" aria-label="喚醒選項">
			<label class="round">
				<input type="checkbox" bind:checked={() => newRound[id] ?? false, (value) => (newRound[id] = value)} />
				開新一輪 LAT
			</label>
			{#if resumes && status?.options}
				<div class="choice">
					<label>
						模型
						<select bind:value={() => model[id] ?? '', (value) => (model[id] = value)} disabled={status.lock === 'fixed'}>
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
				</div>
				{#if model[id] && status.lock !== 'fixed' && !effort[id] && !switching.current[id]?.effort}
					<p class="note">{EFFORT_UNKNOWN_TEXT}。</p>
				{/if}
				{#if status.lock === 'fixed'}
					<p class="note">{FIXED_MODEL_REASON}。</p>
				{:else if status.lock === 'unknown'}
					<p class="note">{LOCK_UNKNOWN_TEXT}（{status.lockReason}），接回後以下一回合核對結果。</p>
				{/if}
			{/if}
			<p class="note">
				@{recipient.hcomName} 已結束。它的分頁還開著就直接送進去；分頁已關會在 Herdr 開新分頁接回這段對話，並開始消耗額度。
			</p>
			{#if abandonable[id]}
				{#if confirming[id]}
					<p class="warn">{ABANDON_CONFIRM_TEXT}</p>
					<div class="actions">
						<button type="button" class="danger" onclick={abandon}>確認放棄</button>
						<button type="button" onclick={() => delete confirming[id]}>取消</button>
					</div>
				{:else}
					<button type="button" onclick={() => (confirming[id] = true)}>放棄前一次接回</button>
				{/if}
			{/if}
		</div>
	{/if}
</form>

<style>
	.cmd {
		position: relative;
		display: grid;
		grid-template-columns: auto 1fr auto auto;
		gap: 0.6rem;
		align-items: end;
		padding: 0.6rem 1rem;
		background: var(--surface);
		border-top: 1px solid var(--line);
	}
	/* Bottom-aligned like the send button: as tall as a one-line box (its line, padding and border),
	   so the text sits level with the box's last line and does not move when the box grows. */
	.to {
		display: flex;
		align-items: center;
		box-sizing: border-box;
		height: calc(1.5rem + 1rem + 2px);
		font-family: var(--mono);
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.options {
		display: inline-flex;
		align-items: center;
		height: calc(1.5rem + 1rem + 2px);
		padding: 0 0.6rem;
	}
	/* Wide enough for 「喚醒並送出」, so the label change does not move the box. */
	.cmd :global(.send) {
		min-width: 7.5em;
	}
	/* Floats above the line; opening it moves nothing. */
	.popup {
		position: absolute;
		right: 1rem;
		bottom: calc(100% + 0.4rem);
		z-index: 40;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		align-items: flex-start;
		width: min(26rem, calc(100vw - 2rem));
		padding: 0.8rem 0.9rem;
		background: var(--surface);
		border: 2px solid var(--text);
		border-radius: var(--radius);
		box-shadow: 0 4px 16px rgb(0 0 0 / 0.35);
	}
	.round {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		font-size: max(0.85rem, var(--min-font, 0px));
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
	.note,
	.warn {
		margin: 0;
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.warn {
		color: var(--danger);
	}
	.actions {
		display: flex;
		gap: 0.5rem;
	}
	button.danger {
		color: var(--danger);
		border-color: var(--danger);
	}
	/* The narrow layout has no command line. */
	@media (max-width: 760px) {
		.cmd {
			display: none;
		}
	}
</style>
