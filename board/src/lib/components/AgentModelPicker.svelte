<script lang="ts" module>
	import type { Kind } from './PickerMenu.svelte';
	// Kept apart from the picker, which goes whenever the line is for someone else (an `@name`
	// line, a controller's page) and comes back with the agent.
	/** Picks not sent yet, by agent; kept when another agent is open, dropped once sent or discarded. */
	const staged = $state<Record<string, Partial<Record<Kind, string>>>>({});
	/** A switch, a continue or a give-up on its way, by agent: its stop or resume may take a while. */
	const switching = $state<Record<string, boolean>>({});
</script>

<script lang="ts">
	// The open agent's model and effort beside the send button, looking like a controller's. Picks
	// are staged and sent as one switch with the apply button, after the user confirms it. A ⚠ beside
	// them opens a switch left unfinished, to continue or give up. The current settings are those of
	// its latest turn, as its open conversation's live feed reads them; unknown before its first.
	// While the latest switch waits for a turn after it, they are what it sent, like a controller's.
	import Check from '@lucide/svelte/icons/check';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import X from '@lucide/svelte/icons/x';
	import { agentControl } from '#lib/board/agent-control.svelte.ts';
	import {
		AGENT_ABANDON_CONFIRM_TEXT,
		AGENT_BUSY_REASON,
		AGENT_CONTINUE_CONFIRM_TEXT,
		AGENT_FIXED_MODEL_REASON,
		AGENT_HCOM_UNKNOWN_SWITCH_REASON,
		AGENT_NOT_LINKED_SWITCH_REASON,
		AGENT_PAUSED_SWITCH_REASON,
		AGENT_SWITCH_STATE_TEXT,
		AGENT_SWITCH_UNFINISHED_TEXT,
		agentSwitchConfirmText,
		carryNote,
		choiceText,
		lastApplied,
		LOCK_UNKNOWN_TEXT,
		settingsText,
		shownSettings,
		SWITCH_WAITING_TEXT,
		type ModelChoice
	} from '#lib/board/models.ts';
	import { switching as feeds } from '#lib/board/switching.svelte.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';
	import type { KnownAgent } from '#lib/board/types.ts';
	import PickerMenu, { focusFirst, NAME, PLACEHOLDER, short, type Part } from './PickerMenu.svelte';

	let { agent }: { agent: KnownAgent } = $props();

	const id = $derived(agent.id);
	const modelStatus = $derived(agentControl.model[id]);

	// What a switch may offer: read again for another agent, or once hcom reaches it.
	$effect(() => {
		if (agent.hcom !== 'linked' || !agent.inHerdr) return;
		const abort = new AbortController();
		void agentControl.loadModel(agent.id, abort.signal);
		return () => abort.abort();
	});

	/** Why neither part can be picked now; null when both can (the model may still be fixed). */
	const blocked = $derived.by((): string | null => {
		if (agent.switch || !agent.inHerdr) return AGENT_SWITCH_UNFINISHED_TEXT;
		if (agent.hcom === 'none') return AGENT_NOT_LINKED_SWITCH_REASON;
		if (agent.hcom === 'paused') return AGENT_PAUSED_SWITCH_REASON;
		if (agent.hcom === 'unknown') return AGENT_HCOM_UNKNOWN_SWITCH_REASON;
		if (!modelStatus) return '讀取中…';
		if (!modelStatus.options) return `看板不會切換 ${agent.client} 的模型與思考強度`;
		if (agent.status !== 'idle') return AGENT_BUSY_REASON;
		if (switching[id]) return '切換中…';
		return null;
	});
	const reason = (kind: Kind) => blocked ?? (kind === 'model' && modelStatus?.lock === 'fixed' ? AGENT_FIXED_MODEL_REASON : null);

	const pending = (kind: Kind) => staged[id]?.[kind] ?? '';
	const anyStaged = $derived(!!(staged[id]?.model || staged[id]?.effort));
	const choice = $derived<ModelChoice>({ model: staged[id]?.model ?? null, effort: staged[id]?.effort ?? null });
	/** The latest turn's settings, or what a switch sent while its next turn is still to come. The
	 *  switches are the agent's record, which its page keeps loaded. */
	const shownNow = $derived(shownSettings(lastApplied(agentControl.switches[id] ?? []), feeds.current[id] ?? null));
	const current = $derived(shownNow.settings ?? null);
	const shown = (kind: Kind) => pending(kind) || current?.[kind] || PLACEHOLDER[kind];
	function part(kind: Kind): Part {
		const unknown = shown(kind) === PLACEHOLDER[kind];
		const waiting = shownNow.waiting && !pending(kind) && !unknown;
		return {
			text: unknown ? PLACEHOLDER[kind] : short(kind, shown(kind)),
			label: `${NAME[kind]}：${unknown ? '不明' : shown(kind)}`,
			title:
				reason(kind) ??
				`${NAME[kind]}：${unknown ? '還不知道（它還沒做完一回合）' : shown(kind)}${waiting ? `（${SWITCH_WAITING_TEXT}）` : ''}（選好後按 ✓ 套用）`,
			picked: !!pending(kind),
			unknown,
			waiting,
			disabled: !!reason(kind)
		};
	}

	/** The open menu, or the confirmation of a switch, a continue or a give-up. */
	let menu = $state<Kind | 'status' | 'switch' | null>(null);
	let confirming = $state<'continue' | 'abandon' | null>(null);
	let alertButton = $state<HTMLButtonElement>();
	let applyButton = $state<HTMLButtonElement>();
	let picker = $state<PickerMenu>();

	// The menus belong to one agent: another one closes them.
	$effect.pre(() => {
		void id;
		menu = null;
		confirming = null;
	});

	function toggle(kind: Kind) {
		if (menu === kind) return close();
		if (reason(kind)) return;
		menu = kind;
	}

	function close(focus = false) {
		const open = menu;
		menu = null;
		confirming = null;
		if (!focus || !open) return;
		if (open === 'status') alertButton?.focus();
		else if (open === 'switch') applyButton?.focus();
		else picker?.focusPart(open);
	}

	function pick(kind: Kind, value: string) {
		close(true);
		const next = { ...staged[id] };
		// Picking the staged or the current value again takes the change back.
		if (value === next[kind] || value === current?.[kind]) delete next[kind];
		else next[kind] = value;
		staged[id] = next;
	}

	/** Send the staged settings (`switch`), continue the open switch with its own, or give it up;
	 *  each once the user confirmed it. */
	async function run(kind: 'switch' | 'continue' | 'abandon') {
		const { id: target, name } = agent;
		const sent = choice;
		close();
		switching[target] = true;
		const result = kind === 'abandon' ? await agentControl.abandonSwitch(target) : await agentControl.switchModel(target, kind === 'switch' ? sent : { model: null, effort: null });
		switching[target] = false;
		if (result.ok && kind === 'switch') delete staged[target];
		const done = { switch: `已切換 ${name}，等它在新分頁出現。`, continue: `已繼續切換 ${name}。`, abandon: `已放棄 ${name} 的這次切換。` }[kind];
		toasts.show(result.ok ? 'ok' : 'failed', result.ok ? `${done}${result.reason ?? ''}` : (result.reason ?? '切換失敗'));
	}

	const applyText = $derived(`切換為 ${choiceText(choice)}，會重開 Agent 一次`);
</script>

<PickerMenu
	bind:this={picker}
	{menu}
	{part}
	tagged
	ontoggle={toggle}
	values={(kind) => (kind === 'model' ? modelStatus?.options?.models : modelStatus?.options?.efforts)}
	checked={(kind) => pending(kind) || current?.[kind]}
	onpick={pick}
	onclose={close}
>
	{#snippet actions()}
		{#if agent.switch}
			<button
				bind:this={alertButton}
				type="button"
				class="act alert"
				data-action="switch-status"
				aria-label="模型切換需要處理"
				title="切換尚未完成"
				aria-haspopup="dialog"
				aria-expanded={menu === 'status'}
				onclick={() => (menu === 'status' ? close() : ((confirming = null), (menu = 'status')))}
			>
				<TriangleAlert size="1em" />
			</button>
		{/if}
		{#if anyStaged}
			<button
				bind:this={applyButton}
				type="button"
				class="act"
				data-action="apply"
				aria-label="套用：{applyText}"
				title={blocked ?? applyText}
				aria-disabled={!!blocked}
				aria-haspopup="dialog"
				aria-expanded={menu === 'switch'}
				onclick={() => (menu === 'switch' ? close() : !blocked && (menu = 'switch'))}
			>
				<Check size="1em" />
			</button>
			<button type="button" class="act discard" aria-label="放棄選好的模型與思考強度" title="放棄選好的值" onclick={() => delete staged[id]}>
				<X size="1em" />
			</button>
		{/if}
	{/snippet}

	{#snippet dialog()}
		{#if menu === 'switch'}
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<div
				class="menu status"
				role="dialog"
				aria-label="確認切換"
				tabindex="-1"
				onkeydown={(event) => event.key === 'Escape' && (event.preventDefault(), close(true))}
				{@attach focusFirst}
			>
				<p>{agentSwitchConfirmText(choice)}</p>
				<button type="button" class="wide primary" data-action="confirm-switch" onclick={() => run('switch')}>確認切換</button>
				<button type="button" class="wide" onclick={() => close(true)}>取消</button>
			</div>
		{:else if menu === 'status' && agent.switch}
			{@const open = agent.switch}
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<div
				class="menu status"
				role="dialog"
				aria-label="模型切換"
				tabindex="-1"
				onkeydown={(event) => event.key === 'Escape' && (event.preventDefault(), close(true))}
				{@attach focusFirst}
			>
				<p><strong>切換未完成：{AGENT_SWITCH_STATE_TEXT[open.state]}</strong></p>
				{#if open.error}<p class="failed">{open.error}</p>{/if}
				<p class="note">舊設定：{open.from ? settingsText(open.from) : '不明'}</p>
				<p class="note">新設定：{choiceText(open.to)}</p>
				{#if carryNote(open)}<p class="note">{carryNote(open)}</p>{/if}
				{#if confirming}
					<p class={confirming === 'abandon' ? 'failed' : ''}>{confirming === 'continue' ? AGENT_CONTINUE_CONFIRM_TEXT : AGENT_ABANDON_CONFIRM_TEXT}</p>
					<button
						type="button"
						class="wide {confirming === 'continue' ? 'primary' : 'danger'}"
						data-action="confirm-{confirming}"
						onclick={() => run(confirming as 'continue' | 'abandon')}
					>
						{confirming === 'continue' ? '確認繼續' : '確認放棄'}
					</button>
					<button type="button" class="wide" onclick={() => (confirming = null)}>取消</button>
				{:else}
					<button type="button" class="wide primary" data-action="continue" disabled={switching[id]} onclick={() => (confirming = 'continue')}>
						{switching[id] ? '處理中…' : '繼續切換'}
					</button>
					<!-- While this page's stop or resume of it runs, it is given up only after (the server queues it too). -->
					<button type="button" class="wide" data-action="abandon" disabled={switching[id]} onclick={() => (confirming = 'abandon')}>放棄切換</button>
				{/if}
			</div>
		{/if}
	{/snippet}

	{#snippet notes(kind: Kind)}
		<p class="note">選好模型與思考強度後按 ✓ 一次套用。要等它這一回合做完才能切換；切換時原分頁會關掉，在新分頁以新設定接回同一段對話。</p>
		{#if kind === 'model' && modelStatus?.lock === 'unknown'}
			<p class="note">{LOCK_UNKNOWN_TEXT}：{modelStatus.lockReason}</p>
		{/if}
	{/snippet}
</PickerMenu>
