<script lang="ts">
	// The command line at the bottom of the screen: `@name message` goes to that controller, a line
	// without a name to the controller that is open. The recipient's model and effort sit beside the
	// send button. An ended or closed controller is woken instead; its other wake options sit in a
	// pop-up behind a button that shows only then. A phone can put the line away behind a floating
	// button, to read more of the page; what was typed stays.
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
	import { onMount, tick } from 'svelte';
	import { COMMAND_HIDDEN_KEY, remember, remembered } from '#lib/board/prefs.ts';
	import { parseCommand } from '#lib/board/messages.ts';
	import { enterMakesNewline, messaging } from '#lib/board/messaging.svelte.ts';
	import { switching } from '#lib/board/switching.svelte.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';
	import { isInactive, type Controller } from '#lib/board/types.ts';
	import { ABANDON_CONFIRM_TEXT } from '#lib/board/wake.ts';
	import MessageBox from './MessageBox.svelte';
	import ModelPicker from './ModelPicker.svelte';
	import SendButton from './SendButton.svelte';

	let { controllers, target }: { controllers: Controller[]; target: Controller | undefined } = $props();

	let text = $state('');
	let sending = $state(false);
	let sent = $state(0);
	let optionsOpen = $state(false);
	/** The send button's width, kept clear at the right of the box's text. */
	let sendWidth = $state(0);
	/** Put away on a phone; the wide layout ignores it. */
	let hidden = $state(false);
	let form: HTMLFormElement;
	onMount(() => {
		hidden = remembered(COMMAND_HIDDEN_KEY, ['1', '0'], '0') === '1';
	});

	async function setHidden(next: boolean) {
		hidden = next;
		optionsOpen = false;
		remember(COMMAND_HIDDEN_KEY, next ? '1' : '0');
		if (next) return;
		await tick();
		form.querySelector('textarea')?.focus();
	}
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
		toasts.show(result.ok ? 'ok' : 'failed', result.ok ? '已放棄前一次接回，可以再按「喚醒」。' : (result.reason ?? '放棄失敗'));
	}
</script>

{#snippet sendIcon()}<ArrowUp size="1.2em" />{/snippet}

<form
	bind:this={form}
	class="cmd"
	class:hidden
	onsubmit={(event) => {
		event.preventDefault();
		void submit();
	}}
>
	<button type="button" class="hide" aria-label="收起輸入列" title="收起輸入列" onclick={() => setHidden(true)}>
		<ChevronDown size="1.1em" />
	</button>
	<span class="to" class:other={recipient !== undefined && recipient.id !== target?.id}>→ {recipient ? `@${recipient.hcomName}` : '@名稱'}</span>
	<!-- The send button sits inside the box at its right edge; the box keeps its text clear of it. -->
	<div class="box" style:--send-w="{sendWidth}px">
		<MessageBox
			bind:value={() => text, (value) => (text = value)}
			label={recipient ? `指令列：${waking ? '喚醒' : '傳話給'} @${recipient.hcomName}` : '指令列'}
			placeholder="@名稱 指定主控・{enterMakesNewline.current ? 'Enter 換行・按鈕送出' : 'Enter 送出・Shift+Enter 換行'}"
			onsend={submit}
		/>
		<!-- A wake keeps its word: it brings a controller back and spends quota. One button either
		     way, so its check stays through the change. -->
		<span class="send-slot" bind:clientWidth={sendWidth}>
			<SendButton class="send" label={waking ? '喚醒' : '送出'} icon={waking ? undefined : sendIcon} {sending} {sent} disabled={!text.trim()} />
		</span>
	</div>
	<div class="pill-slot">
		<ModelPicker
			controller={recipient}
			chosen={{ model: model[id] ?? '', effort: effort[id] ?? '' }}
			onchoose={(kind, value) => ((kind === 'model' ? model : effort)[id] = value)}
		/>
	</div>
	<!-- Always there on a wide screen, so the box keeps its width whoever it is for; a phone shows
	     it only for a wake. -->
	<button
		type="button"
		class="options"
		class:idle={!waking}
		aria-label="喚醒選項"
		title={waking ? '喚醒選項：開新一輪 LAT' : '只有已結束的主控有喚醒選項'}
		aria-expanded={optionsOpen}
		disabled={!waking}
		onclick={() => (optionsOpen = !optionsOpen)}
	>
		<SlidersHorizontal size="1.1em" />
	</button>

	{#if optionsOpen && waking && recipient}
		<div class="popup" role="group" aria-label="喚醒選項">
			<label class="round">
				<input type="checkbox" bind:checked={() => newRound[id] ?? false, (value) => (newRound[id] = value)} />
				開新一輪 LAT
			</label>
			<p class="note">
				@{recipient.hcomName} 已結束。它的分頁還開著就直接送進去；分頁已關會在 Herdr 開新分頁接回這段對話，並開始消耗額度。勾選「開新一輪
				LAT」會在前面加上 LAT 啟動指令。
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
{#if hidden}
	<button
		type="button"
		class="reopen"
		aria-label={text.trim() ? '展開輸入列（有未送出的文字）' : '展開輸入列'}
		title="展開輸入列"
		onclick={() => setHidden(false)}
	>
		<MessageSquare size="1.3em" />
		{#if text.trim()}<span class="dot" aria-hidden="true"></span>{/if}
	</button>
{/if}

<style>
	.cmd {
		position: relative;
		display: grid;
		grid-template-columns: auto 1fr;
		grid-auto-columns: auto;
		grid-auto-flow: column;
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
		height: calc(1.5 * max(1rem, var(--min-font, 0px)) + 1rem + 2px);
		font-family: var(--mono);
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	/* As tall as a one-line box, so the label stays level with its last line as it grows. */
	.pill-slot {
		display: flex;
		align-items: center;
		height: calc(1.5 * max(1rem, var(--min-font, 0px)) + 1rem + 2px);
	}
	.options {
		display: inline-flex;
		align-items: center;
		height: calc(1.5 * max(1rem, var(--min-font, 0px)) + 1rem + 2px);
		padding: 0 0.6rem;
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
	/* The box's frame holds the send button at its right, bottom-aligned as it grows; its text and
	   tips stop short of the button. */
	.box {
		position: relative;
		min-width: 0;
	}
	.box :global(textarea) {
		padding-right: calc(var(--send-w, 0px) + 0.6rem + 4px);
	}
	.send-slot {
		position: absolute;
		right: 4px;
		bottom: 4px;
		display: flex;
	}
	.box :global(.send) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		height: calc(1.5 * max(1rem, var(--min-font, 0px)) + 1rem + 2px - 8px);
		padding: 0 0.7rem;
		line-height: 1;
	}
	.box :global(.send.square) {
		width: calc(1.5 * max(1rem, var(--min-font, 0px)) + 1rem + 2px - 8px);
		padding: 0;
		border-radius: calc(var(--radius) - 2px);
	}
	/* Only a phone puts the line away behind a floating button. */
	.hide,
	.reopen {
		display: none;
	}
	/* A phone: the box takes its own row, the recipient and the controls the row under it. */
	@media (max-width: 760px) {
		.cmd.hidden {
			display: none;
		}
		.hide {
			display: inline-flex;
			align-items: center;
			padding: 0.3rem;
			border: 0;
			background: none;
			color: var(--muted);
		}
		/* Bottom right, over the page; the dock around it lets touches through elsewhere. */
		.reopen {
			position: relative;
			display: flex;
			align-items: center;
			justify-content: center;
			width: 44px;
			height: 44px;
			margin: 0 0.8rem calc(0.8rem + env(safe-area-inset-bottom, 0px)) auto;
			padding: 0;
			border: 0;
			border-radius: var(--radius-pill);
			background: color-mix(in srgb, var(--text) 10%, var(--bg));
			box-shadow: 0 2px 10px rgb(0 0 0 / 0.3);
			pointer-events: auto;
		}
		.dot {
			position: absolute;
			top: 7px;
			right: 7px;
			width: 9px;
			height: 9px;
			border-radius: var(--radius-pill);
			background: var(--accent);
		}
		.cmd {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 0.5rem;
			padding: 0.5rem 0.6rem calc(0.5rem + env(safe-area-inset-bottom, 0px));
			pointer-events: auto;
		}
		.options.idle {
			display: none;
		}
		.box {
			order: -1;
			flex-basis: 100%;
		}
		/* The top bar already names the open controller; the line names its recipient only when it
		   is someone else, in full on a short row above the box, so it is never cut. */
		.hide {
			margin-right: auto;
		}
		.to {
			display: none;
		}
		.to.other {
			display: block;
			order: -2;
			flex-basis: 100%;
			height: auto;
			overflow-wrap: anywhere;
			color: var(--accent);
		}
	}
</style>
