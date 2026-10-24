<script lang="ts">
	// The command line at the bottom of the screen: `@name message` goes to that controller, a line
	// without a name to the controller that is open. The recipient's model and effort sit beside the
	// send button. An idle or closed controller is woken instead; its other wake options sit in a
	// pop-up behind a button that shows only then. A phone can put the line away behind a floating
	// button, to read more of the page; what was typed stays, also across a reload. While an agent's
	// page is open, a line without a name goes to that agent instead, from a draft of its own, also
	// kept across a reload; while it works and nothing is typed, the send button interrupts its turn instead.
	// A closed agent's page, from the 已關閉 section, says it must be brought back first.
	// A controller's page on the Herdr tab is written to as the controller it is, from the controllers' draft.
	// A controller in a turn in a Herdr pane is interrupted the same way, while nothing is typed; its
	// turn is read from the Herdr tab's list of agents, not from its LAT status.
	// Files attached to a draft go with it, their paths in a block at the end of the message.
	// The box hints the skills of whoever the line goes to, by its client and the folder it works in.
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
	import Square from '@lucide/svelte/icons/square';
	import { onMount, tick, untrack } from 'svelte';
	import {
		AGENT_HCOM_UNKNOWN_REASON,
		controllerInterruptible
	} from '#lib/board/agent-actions.ts';
	import { agentControl } from '#lib/board/agent-control.svelte.ts';
	import { attaching } from '#lib/board/attaching.svelte.ts';
	import { withAttachments } from '#lib/board/attachments.ts';
	import { shortName } from '#lib/board/agents.ts';
	import { CLOSED_SEND_TEXT, type ClosedAgent } from '#lib/board/closed-agents.ts';
	import { AGENT_DRAFTS_KEY, COMMAND_DRAFT_KEY, COMMAND_HIDDEN_KEY, forget, remember, remembered, rememberedText } from '#lib/board/prefs.ts';
	import { parseCommand } from '#lib/board/messages.ts';
	import { enterMakesNewline, messaging } from '#lib/board/messaging.svelte.ts';
	import { switching } from '#lib/board/switching.svelte.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';
	import { AGENT_SWITCH_UNFINISHED_TEXT } from '#lib/board/models.ts';
	import { needsWake, type Agent, type Controller, type KnownAgent } from '#lib/board/types.ts';
	import { ABANDON_CONFIRM_TEXT } from '#lib/board/wake.ts';
	import { voice } from '#lib/board/voice.svelte.ts';
	import AttachButton from './AttachButton.svelte';
	import AttachmentTray from './AttachmentTray.svelte';
	import MessageBox from './MessageBox.svelte';
	import VoiceButton from './VoiceButton.svelte';
	import AgentModelPicker from './AgentModelPicker.svelte';
	import ModelPicker from './ModelPicker.svelte';
	import SendButton from './SendButton.svelte';

	let {
		controllers,
		target,
		agent,
		closed,
		agents,
		adopt
	}: {
		controllers: Controller[];
		target: Controller | undefined;
		agent?: KnownAgent;
		/** The closed agent whose page is open: a line without a name would go to it, so none is sent. */
		closed?: Pick<ClosedAgent, 'id' | 'hcomName'>;
		/** Every agent Herdr lists: whether a controller is in a turn is read from its own. */
		agents: Agent[];
		/** The controller whose page is open on the Herdr tab: what was typed to it as an agent, before
		 *  the board wrote to it as a controller, is moved into the controllers' draft, once. */
		adopt?: string;
	} = $props();

	/** The controllers' draft. */
	let text = $state('');
	// What was typed, by agent, so text meant for one is never sent to another opened meanwhile.
	let agentDrafts = $state<Record<string, string>>({});
	let sending = $state(false);
	let agentSending = $state<Record<string, boolean>>({});
	let sent = $state(0);
	let optionsOpen = $state(false);
	/** The send button's width, kept clear at the right of the box's text. */
	let sendWidth = $state(0);
	/** Put away on a phone; the wide layout ignores it. */
	let hidden = $state(false);
	let form: HTMLFormElement;
	/** Set once the saved draft is read back, so the empty start does not erase it first. */
	let restored = false;
	onMount(() => {
		hidden = remembered(COMMAND_HIDDEN_KEY, ['1', '0'], '0') === '1';
		text = rememberedText(COMMAND_DRAFT_KEY);
		agentDrafts = savedAgentDrafts();
		restored = true;
		if (adopt) adoptDraft(adopt);
	});
	$effect(() => {
		const id = adopt;
		if (id) untrack(() => adoptDraft(id));
	});
	$effect(() => {
		const draft = text;
		if (!restored) return;
		if (draft) remember(COMMAND_DRAFT_KEY, draft);
		else forget(COMMAND_DRAFT_KEY);
	});
	$effect(() => {
		// Only agents with something typed are kept, so the saved drafts do not grow with every agent opened.
		const kept = Object.entries(agentDrafts).filter(([, draft]) => draft);
		if (!restored) return;
		if (kept.length) remember(AGENT_DRAFTS_KEY, JSON.stringify(Object.fromEntries(kept)));
		else forget(AGENT_DRAFTS_KEY);
	});

	/** The agents' saved drafts; whatever is not a map of text is dropped. */
	function savedAgentDrafts(): Record<string, string> {
		try {
			const saved: unknown = JSON.parse(rememberedText(AGENT_DRAFTS_KEY) || '{}');
			if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
			return Object.fromEntries(Object.entries(saved).filter(([, draft]) => typeof draft === 'string'));
		} catch {
			return {};
		}
	}

	/** Move the agent draft of controller `id` to the end of the controllers' draft, a blank line
	 *  between when both have text; it is then gone, so it is never moved twice. Nothing is sent. */
	function adoptDraft(id: string) {
		if (!restored) return;
		const old = agentDrafts[id];
		if (old === undefined) return;
		if (old) text = text ? `${text}\n\n${old}` : old;
		delete agentDrafts[id];
	}

	async function setHidden(next: boolean) {
		hidden = next;
		optionsOpen = false;
		remember(COMMAND_HIDDEN_KEY, next ? '1' : '0');
		if (next) return;
		await tick();
		form.querySelector('textarea')?.focus();
	}
	/** The draft of `owner`, whose box it is: an agent's ID, or null for the controllers'. */
	const read = (owner: string | null) => (owner === null ? text : (agentDrafts[owner] ?? ''));
	function write(owner: string | null, value: string) {
		if (owner === null) text = value;
		else agentDrafts[owner] = value;
	}
	const owner = $derived(agent?.id ?? closed?.id ?? null);
	const draft = $derived(read(owner));
	/** Whose attachments the box holds: the open agent's, or the controllers' draft's. */
	const attachOwner = $derived(owner === null ? 'controllers' : `agent:${owner}`);
	let messageBox = $state<MessageBox>();
	/** Something to send: typed text or an attached file. */
	const filled = $derived(!!draft.trim() || attaching.list(attachOwner).length > 0);
	const named = $derived(draft.trimStart().startsWith('@'));
	/** The open agent is the recipient: a line without a name while its page is open. */
	const toAgent = $derived(agent !== undefined && !named);
	/** How the line names the open agent: its short hcom name, like a controller's, or its tab's name without one. */
	const agentName = $derived(agent ? (agent.hcomName ? `@${shortName(agent)}` : agent.name) : '');
	// Why the open agent cannot be sent to; null when it can. Whether hcom reaches it decides which
	// command carries the text, so until that is known nothing is sent (the server refuses it too).
	const agentBlocked = $derived(
		!agent ? null : !agent.inHerdr || agent.switch ? `${AGENT_SWITCH_UNFINISHED_TEXT}。` : agent.hcom === 'unknown' ? AGENT_HCOM_UNKNOWN_REASON : null
	);
	// An interrupt presses Esc in its pane through Herdr, whether hcom reaches it or not.
	const stoppable = $derived(
		toAgent && !!agent && agent.inHerdr && !agent.switch && agent.status !== 'idle' && agent.status !== 'done' && !filled
	);
	let interrupting = $state<Record<string, boolean>>({});
	const command = $derived(parseCommand(draft, controllers, target, true));
	/** A line for the closed agent whose page is open, without a name or naming it (a closed
	 *  controller): not sent; it is brought back from its page. */
	const toClosed = $derived(closed !== undefined && (!named || (command.ok && command.controller.id === closed.id)));
	const boxDisabled = $derived((toAgent && agentBlocked !== null) || toClosed);
	const recipient = $derived(toClosed ? undefined : command.ok ? command.controller : named || toAgent ? undefined : target);
	/** Whose turn the send button interrupts instead, as the notice names it; null when it sends. */
	const stopping = $derived(
		stoppable && agent
			? { id: agent.id, name: agent.name }
			: !toAgent && !filled && recipient && controllerInterruptible(recipient, agents)
				? { id: recipient.id, name: `@${recipient.hcomName}` }
				: null
	);
	const waking = $derived(recipient !== undefined && needsWake(recipient));
	const skillsFor = $derived(
		toAgent && agent ? { client: agent.client, folder: agent.folder } : recipient ? { client: recipient.client, folder: recipient.workspace } : null
	);

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
		void owner;
		optionsOpen = false;
	});

	async function submit() {
		const from = owner;
		const files = attachOwner;
		const sentText = draft;
		if (!filled || toClosed) return;
		const attached = attaching.ready(files);
		if (!attached.ok) return toasts.show('failed', attached.reason);
		const paths = attached.paths;
		if (toAgent && agent) return sendAgent(agent.id, sentText, files, paths);
		if (sending) return;
		// Names are checked against the board's data at the moment of sending.
		const parsed = paths.length ? parseCommand(withAttachments(sentText, paths), controllers, target, true) : command;
		if (!parsed.ok) return toasts.show('failed', parsed.reason);
		const to = parsed.controller;
		const wake = needsWake(to);
		sending = true;
		const choice = wake && resumes
			? { model: status?.lock === 'fixed' ? null : model[to.id] || null, effort: effort[to.id] || null }
			: { model: null, effort: null };
		const result = wake
			? await messaging.wake(to.id, parsed.text, newRound[to.id] ?? false, choice)
			: await messaging.send(to.id, parsed.text);
		sending = false;
		if (result.ok && read(from) === sentText) write(from, '');
		if (result.ok) attaching.sent(files, paths);
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

	async function sendAgent(id: string, sentText: string, files: string, paths: string[]) {
		if (agentSending[id] || agentBlocked) return;
		agentSending[id] = true;
		const result = await agentControl.send(id, withAttachments(sentText, paths));
		agentSending[id] = false;
		if (result.ok && agentDrafts[id] === sentText) agentDrafts[id] = '';
		if (result.ok) attaching.sent(files, paths);
		if (result.ok) {
			sent++;
			if (result.reason) toasts.show('failed', result.reason);
			return;
		}
		toasts.show('failed', `${result.reason}（文字還在輸入框裡）`);
	}

	async function interrupt() {
		if (!stopping) return;
		// The notice names the one interrupted, even if another one is open by the time it answers.
		const { id, name } = stopping;
		interrupting[id] = true;
		const result = await agentControl.interrupt(id);
		interrupting[id] = false;
		toasts.show(result.ok ? 'ok' : 'failed', result.ok ? `已對 ${name} 送出 Esc。${result.reason ?? ''}` : (result.reason ?? '中斷失敗'));
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
	<span class="to" class:other={recipient !== undefined && recipient.id !== target?.id} title={toAgent && agent?.hcomName ? `@${agent.hcomName}` : undefined}>→ {toAgent && agent ? agentName : toClosed && closed ? `@${closed.hcomName}` : recipient ? `@${recipient.hcomName}` : '@名稱'}</span>
	<!-- The paperclip and the mic sit before the box as they do in a message box of its own, and the
	     files above both; placed here so a phone can move them to the row under the box. The send
	     button sits inside the box at its right edge; the box keeps its text clear of it. -->
	<div class="field">
		<div class="tray-slot"><AttachmentTray owner={attachOwner} /></div>
		<div class="field-row">
			<span class="attach-slot"><AttachButton owner={attachOwner} disabled={boxDisabled} /></span>
			{#if voice.unlocked}
				<span class="voice-slot"><VoiceButton disabled={boxDisabled} oninsert={(text) => messageBox?.insert(text)} /></span>
			{/if}
			<div class="box" style:--send-w="{sendWidth}px">
				<MessageBox
					bind:this={messageBox}
					bind:value={() => draft, (value) => write(owner, value)}
					label={toAgent && agent ? `指令列：傳話給 ${agentName}` : toClosed && closed ? `指令列：@${closed.hcomName} 已關閉` : recipient ? `指令列：${waking ? '喚醒' : '傳話給'} @${recipient.hcomName}` : '指令列'}
					placeholder={toAgent && agentBlocked
						? agentBlocked
						: toClosed
							? CLOSED_SEND_TEXT
							: `${agent ? `傳話給 ${agentName}` : '@名稱 指定主控'}・${enterMakesNewline.current ? 'Enter 換行・按鈕送出' : 'Enter 送出・Shift+Enter 換行'}`}
					disabled={boxDisabled}
					attachTo={attachOwner}
					tools={false}
					{skillsFor}
					onsend={submit}
				/>
				<!-- A wake keeps its word: it brings a controller back and spends quota. One button either
				     way, so its check stays through the change. -->
				<span class="send-slot" bind:clientWidth={sendWidth}>
					{#if stopping}
						<button
							type="button"
							class="primary send square stop"
							aria-label="中斷這一回合"
							title="中斷這一回合（等同在它的終端機按 Esc）"
							data-action="interrupt"
							disabled={interrupting[stopping.id]}
							onclick={() => ((optionsOpen = false), interrupt())}
						>
							<Square size="1em" fill="currentColor" />
						</button>
					{:else}
						<SendButton
							class="send"
							label={waking ? '喚醒' : '送出'}
							icon={waking ? undefined : sendIcon}
							sending={toAgent && agent ? (agentSending[agent.id] ?? false) : sending}
							{sent}
							disabled={!filled || boxDisabled}
						/>
					{/if}
				</span>
			</div>
		</div>
	</div>
	<!-- An agent has no wake; a closed one is brought back from its page. -->
	{#if toAgent && agent}
		<div class="pill-slot">
			<AgentModelPicker {agent} />
		</div>
	{:else if !toClosed}
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
			title={waking ? '喚醒選項：開新一輪 LAT' : '只有閒置或已關閉的主控有喚醒選項'}
			aria-expanded={optionsOpen}
			disabled={!waking}
			onclick={() => (optionsOpen = !optionsOpen)}
		>
			<SlidersHorizontal size="1.1em" />
		</button>
	{/if}
	<button type="button" class="hide" aria-label="收起輸入列" title="收起輸入列" onclick={() => setHidden(true)}>
		<ChevronDown size="1.1em" />
	</button>

	<!-- Said here too, as a draft kept from before hides the placeholder. -->
	{#if toClosed && draft.trim()}
		<p class="closed-note" role="status">{CLOSED_SEND_TEXT}</p>
	{/if}
	{#if optionsOpen && waking && recipient}
		<div class="popup" role="group" aria-label="喚醒選項">
			<label class="round">
				<input type="checkbox" bind:checked={() => newRound[id] ?? false, (value) => (newRound[id] = value)} />
				開新一輪 LAT
			</label>
			<p class="note">
				@{recipient.hcomName} {recipient.status === 'closed' ? '已關閉' : recipient.status === 'working' ? '已停用 LAT（正在工作）' : '閒置中'}。它的分頁還開著就直接送進去；分頁已關會在 Herdr 開新分頁接回這段對話，並開始消耗額度。勾選「開新一輪
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
		aria-label={draft.trim() ? '展開輸入列（有未送出的文字）' : '展開輸入列'}
		title="展開輸入列"
		onclick={() => setHidden(false)}
	>
		<MessageSquare size="1.3em" />
		{#if draft.trim()}<span class="dot" aria-hidden="true"></span>{/if}
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
	.closed-note {
		position: absolute;
		left: 1rem;
		bottom: calc(100% + 0.4rem);
		margin: 0;
		padding: 0.3rem 0.6rem;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--surface);
		font-size: max(0.85rem, var(--min-font, 0px));
		color: var(--muted);
	}
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
	/* The files above, and the paperclip and the mic before the box, bottom-aligned as it grows. */
	.field {
		min-width: 0;
	}
	.field-row {
		display: flex;
		align-items: flex-end;
		gap: 0.4rem;
	}
	.attach-slot,
	.voice-slot {
		display: flex;
	}
	/* The box's frame holds the send button at its right, bottom-aligned as it grows; its text and
	   tips stop short of the button. */
	.box {
		position: relative;
		flex: 1;
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
	/* The interrupt standing in for the send button: red, like the other stops. */
	.box :global(.send.stop) {
		border-color: var(--danger);
		background: var(--danger);
		color: var(--bg);
	}
	/* Only a phone puts the line away behind a floating button. */
	.hide,
	.reopen {
		display: none;
	}
	/* A phone: the box takes its own row, the controls the row under it: the paperclip, the model
	   and effort, the mic, the rest, and the button that puts the line away at the far right. */
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
		.field,
		.field-row {
			display: contents;
		}
		.tray-slot {
			order: -2;
			flex-basis: 100%;
		}
		.tray-slot:empty {
			display: none;
		}
		.box {
			order: -1;
			flex-basis: 100%;
		}
		.attach-slot {
			order: 1;
		}
		.pill-slot {
			order: 2;
		}
		/* Near the left edge now, its menus float above the whole line from its left instead. */
		.pill-slot :global(.picker) {
			position: static;
		}
		.pill-slot :global(.picker .menu) {
			left: 0.6rem;
			right: auto;
		}
		.voice-slot {
			order: 3;
		}
		.options {
			order: 4;
		}
		.hide {
			order: 5;
			margin-left: auto;
		}
		/* The top bar already names the open controller; the line names its recipient only when it
		   is someone else, in full on a short row above the box, so it is never cut. */
		.to {
			display: none;
		}
		.to.other {
			display: block;
			order: -3;
			flex-basis: 100%;
			height: auto;
			overflow-wrap: anywhere;
			color: var(--accent);
		}
	}
</style>
