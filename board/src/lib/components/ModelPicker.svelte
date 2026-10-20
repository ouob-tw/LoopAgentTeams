<script lang="ts">
	// The recipient's model and effort as two small parts beside the send button, each opening a
	// menu of the choices. For a running controller picks are staged and sent as one switch with the
	// apply button, so changing both restarts it once; for an ended or closed one they only set what
	// the wake will use. A ⚠ beside them opens what needs the user about the last switch: one left
	// unfinished to continue or give up, a resume to give up, or a switch the next turn did not take.
	import Check from '@lucide/svelte/icons/check';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import X from '@lucide/svelte/icons/x';
	import { untrack } from 'svelte';
	import { agentControl } from '#lib/board/agent-control.svelte.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';
	import { messaging } from '#lib/board/messaging.svelte.ts';
	import {
		AGENT_ABANDON_CONFIRM_TEXT,
		BUSY_REASON,
		carryNote,
		choiceText,
		EFFORT_UNKNOWN_TEXT,
		effortShort,
		FIXED_MODEL_REASON,
		lastApplied,
		LOCK_UNKNOWN_TEXT,
		modelShort,
		NOT_RUNNING_REASON,
		readsCurrentAgain,
		settingsText,
		shownSettings,
		SWITCH_MISSED_TEXT,
		SWITCH_STATE_TEXT,
		SWITCH_UNSETTLED_REASON,
		SWITCH_WAITING_TEXT,
		switchCheck,
		type SwitchView
	} from '#lib/board/models.ts';
	import { ABANDON_CONFIRM_TEXT } from '#lib/board/wake.ts';
	import { switching } from '#lib/board/switching.svelte.ts';
	import type { Controller } from '#lib/board/types.ts';
	import './model-picker.css';

	type Kind = 'model' | 'effort';

	let {
		controller,
		chosen = { model: '', effort: '' },
		onchoose
	}: {
		controller: Controller | undefined;
		/** What the wake will use; '' keeps the current one. */
		chosen?: Record<Kind, string>;
		onchoose?: (kind: Kind, value: string) => void;
	} = $props();

	const PLACEHOLDER: Record<Kind, string> = { model: '模型', effort: '強度' };
	/** What the server's refusal asks for, said before it has to refuse. */
	const UNSETTLED_TEXT = SWITCH_UNSETTLED_REASON.replace(/，沒有送出$/, '');
	const NAME: Record<Kind, string> = { model: '模型', effort: '思考強度' };

	const id = $derived(controller?.id ?? '');
	// An ended controller woken outside LAT runs again, and is switched like a running one.
	const waking = $derived(!!controller && !controller.running);
	const status = $derived(controller ? switching.status[id] : undefined);
	const entries = $derived(messaging.sent[id] ?? []);
	/** A switch that stopped the client and has not brought it back yet. */
	const unfinished = $derived(entries.find((entry): entry is SwitchView => entry.kind === 'switch' && entry.open));
	const unsettled = $derived(!!unfinished);
	/** A refused switch whose earlier resume attempt may be given up. */
	const abandon = $derived(switching.outcomes[id]?.ok === false ? switching.outcomes[id]?.abandon : null);
	const check = $derived(controller ? switchCheck(lastApplied(entries), switching.current[id] ?? null) : null);
	/** Something about the last switch the user has to see. */
	const alerting = $derived(!!controller && (unsettled || !!abandon || check === 'missed'));
	let confirming = $state(false);
	/** The confirmation of giving up the unfinished switch itself is open. */
	let confirmingSwitch = $state(false);
	/** The latest turn's settings, or what a switch sent while its next turn is still to come. */
	const shownNow = $derived(controller ? shownSettings(lastApplied(entries), switching.current[id]) : { settings: undefined, waiting: false });
	const current = $derived(shownNow.settings);

	// What can be switched: read for another recipient, or when this one starts or ends, unless
	// read for that state moments ago. The settings come from its conversation, which keeps them
	// current while its information page is open.
	$effect(() => {
		if (!controller) return;
		const target = controller.id;
		const state = `${controller.status}/${controller.running}`;
		const abort = new AbortController();
		void switching.loadFresh(target, state, abort.signal);
		if (untrack(() => switching.current[target]) === undefined) void switching.loadCurrent(target, false, abort.signal);
		return () => abort.abort();
	});
	// With every new board data (each hands a new `controller` object), which is when a resume's
	// result or the next turn comes in: the sent log while it is not read yet or a switch is still
	// open or waiting, and the settings while a switch waits or no turn was read yet (a new
	// controller's first read comes before its first turn), when no open conversation feeds them.
	$effect(() => {
		if (!controller) return;
		const target = controller.id;
		untrack(() => {
			if (messaging.sent[target] === undefined || unsettled || shownNow.waiting) void messaging.load(target);
			if (readsCurrentAgain(switching.current[target], shownNow.waiting) && !switching.watched[target]) void switching.loadCurrent(target, true);
		});
	});

	/** Why neither part can be picked from now; null when both can (the model may still be fixed). */
	const blocked = $derived.by((): string | null => {
		if (!controller) return '先指定主控';
		if (!status) return switching.loadFailed[id] ? '讀不到能不能切換，請重新整理' : '讀取中…';
		if (!status.options) return `看板不會切換 ${controller.client} 主控的模型與思考強度`;
		if (unsettled) return UNSETTLED_TEXT;
		if (waking) {
			if (status.running === false) return null;
			return status.running ? '主控還在跑，喚醒只會把訊息打進去，不能換模型與思考強度' : (status.reason ?? '無法確認主控有沒有在跑');
		}
		if (status.running === false) return NOT_RUNNING_REASON;
		if (status.running === null) return status.reason ?? '無法確認主控有沒有在跑';
		if (status.status !== 'listening') return BUSY_REASON;
		if (switching.sending[id]) return '切換中…';
		return null;
	});
	const reason = (kind: Kind) => blocked ?? (kind === 'model' && status?.lock === 'fixed' ? FIXED_MODEL_REASON : null);

	/** A running controller's picks not sent yet, by controller ID; kept when another recipient is
	 *  shown, dropped once sent or discarded. */
	let staged = $state<Record<string, Partial<Record<Kind, string>>>>({});
	/** What differs from the current setting: the wake's option, or the staged pick. */
	const pending = (kind: Kind) => (waking ? chosen[kind] : (staged[id]?.[kind] ?? ''));
	const anyStaged = $derived(!waking && !!(staged[id]?.model || staged[id]?.effort));
	const shown = (kind: Kind) => pending(kind) || current?.[kind] || PLACEHOLDER[kind];
	/** As Claude Code's status line writes it, e.g. `Opus 5.5` and `H`. */
	const short = (kind: Kind, value: string) => (kind === 'model' ? modelShort(value) : effortShort(value));

	let menu = $state<Kind | 'status' | null>(null);
	let alertButton = $state<HTMLButtonElement>();
	let root = $state<HTMLElement>();
	const triggers = $state<Partial<Record<Kind, HTMLButtonElement>>>({});

	// The menus belong to one recipient: another one closes them.
	$effect.pre(() => {
		void id;
		menu = null;
	});

	/** Opening a menu reads whether the controller can switch now: the status kept for the label
	 *  may be up to 30 s old, and a turn can end without the roster changing. A part that looked
	 *  blocked opens once the fresh read clears it. */
	async function toggle(kind: Kind) {
		if (menu === kind) return close();
		if (!controller) return;
		const target = id;
		const read = switching.load(target);
		if (reason(kind)) await read;
		if (target !== id || reason(kind)) return;
		menu = kind;
	}

	function close(focus = false) {
		const kind = menu;
		menu = null;
		confirming = false;
		confirmingSwitch = false;
		if (focus && kind) (kind === 'status' ? alertButton : triggers[kind])?.focus();
	}

	/** Continue the unfinished switch with the settings it had. */
	async function resume() {
		close(true);
		await switching.request(id, { model: null, effort: null });
	}

	async function giveUp(wakeId: string) {
		const target = id;
		close(true);
		const result = await messaging.abandon(target, wakeId);
		if (result.ok) delete switching.outcomes[target];
		toasts.show(result.ok ? 'ok' : 'failed', result.ok ? '已放棄前一次接回，可以再按「繼續切換」。' : (result.reason ?? '放棄失敗'));
	}

	/** Give up the unfinished switch as a whole, as the 所有 Agent tab does: nothing is run. */
	async function giveUpSwitch() {
		const { id: target, hcomName } = controller!;
		close(true);
		const result = await agentControl.abandonSwitch(target);
		void messaging.load(target);
		toasts.show(result.ok ? 'ok' : 'failed', result.ok ? `已放棄 ${hcomName} 的這次切換。${result.reason ?? ''}` : (result.reason ?? '放棄失敗'));
	}

	/** Opens with its first button in focus. */
	function focusFirst(element: HTMLElement) {
		element.querySelector<HTMLElement>('button')?.focus();
	}

	function pick(kind: Kind, value: string) {
		close(true);
		if (waking) return onchoose?.(kind, value);
		const next = { ...staged[id] };
		// Picking the current value again takes the change back.
		if (value === current?.[kind]) delete next[kind];
		else next[kind] = value;
		staged[id] = next;
	}

	const applyText = $derived(`切換為 ${short('model', shown('model'))}・${short('effort', shown('effort'))}，會重開主控一次`);

	/** Set from the first click until the switch is answered, so a second click sends nothing. */
	let applying = false;

	/** Send both staged values as one switch; a guard that holds now keeps them staged. */
	async function apply() {
		if (applying) return;
		applying = true;
		try {
			const target = id;
			// Checked against a fresh read, not the label's kept one.
			if (controller) await switching.load(target);
			if (target !== id) return;
			if (blocked) return toasts.show('failed', `${blocked}，沒有送出（選好的值還留著）`);
			const choice = { model: staged[target]?.model ?? null, effort: staged[target]?.effort ?? null };
			// Nothing staged would continue an open switch instead; that is the ⚠'s job.
			if (choice.model === null && choice.effort === null) return;
			const result = await switching.request(target, choice);
			if (result?.ok) delete staged[target];
		} finally {
			applying = false;
		}
	}

	/** Opens with the chosen item in focus, so the arrow keys start from it. */
	function focusChosen(element: HTMLElement) {
		const items = [...element.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
		(items.find((item) => item.getAttribute('aria-checked') === 'true') ?? items[0])?.focus();
	}

	function keys(event: KeyboardEvent) {
		const items = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
		const at = items.indexOf(document.activeElement as HTMLElement);
		const move = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
		if (move !== undefined) {
			event.preventDefault();
			items[(move + items.length) % items.length]?.focus();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			close(true);
		} else if (event.key === 'Tab') close();
	}

	// A click anywhere else closes the open menu.
	$effect(() => {
		if (!menu) return;
		const outside = (event: PointerEvent) => {
			if (!root?.contains(event.target as Node)) close();
		};
		addEventListener('pointerdown', outside, true);
		return () => removeEventListener('pointerdown', outside, true);
	});
</script>

<span class="picker" bind:this={root}>
	{#each ['model', 'effort'] as const as kind (kind)}
		<button
			type="button"
			class="part"
			class:picked={!!pending(kind)}
			class:unknown={shown(kind) === PLACEHOLDER[kind]}
			class:waiting={shownNow.waiting && !pending(kind) && shown(kind) !== PLACEHOLDER[kind]}
			bind:this={triggers[kind]}
			aria-label="{NAME[kind]}：{shown(kind)}"
			aria-haspopup="menu"
			aria-expanded={menu === kind}
			aria-disabled={!!reason(kind)}
			title={reason(kind) ??
				`${NAME[kind]}：${shown(kind)}${shownNow.waiting && !pending(kind) ? `（${SWITCH_WAITING_TEXT}）` : ''}（${waking ? '喚醒時套用' : '選好後按 ✓ 套用'}）`}
			onclick={() => toggle(kind)}
		>
			{shown(kind) === PLACEHOLDER[kind] ? PLACEHOLDER[kind] : short(kind, shown(kind))}
		</button>
	{/each}
	{#if alerting}
		<button
			bind:this={alertButton}
			type="button"
			class="act alert"
			aria-label="模型切換需要處理"
			title={unsettled ? '切換尚未完成' : abandon ? '可以放棄前一次接回' : SWITCH_MISSED_TEXT}
			aria-haspopup="dialog"
			aria-expanded={menu === 'status'}
			onclick={() => (menu = menu === 'status' ? null : 'status')}
		>
			<TriangleAlert size="1em" />
		</button>
	{/if}
	{#if anyStaged}
		<button
			type="button"
			class="act"
			aria-label="套用：{applyText}"
			title={blocked ?? applyText}
			aria-disabled={!!blocked}
			onclick={apply}
		>
			<Check size="1em" />
		</button>
		<button type="button" class="act discard" aria-label="放棄選好的模型與思考強度" title="放棄選好的值" onclick={() => delete staged[id]}>
			<X size="1em" />
		</button>
	{/if}

	{#if menu === 'status'}
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<div
			class="menu status"
			role="dialog"
			aria-label="模型切換"
			tabindex="-1"
			onkeydown={(event) => event.key === 'Escape' && (event.preventDefault(), close(true))}
			{@attach focusFirst}
		>
			{#if unfinished}
				<p><strong>切換尚未完成：{SWITCH_STATE_TEXT[unfinished.state]}</strong></p>
				{#if unfinished.error}<p class="failed">{unfinished.error}</p>{/if}
				<p class="note">舊設定：{unfinished.from ? settingsText(unfinished.from) : '不明'}</p>
				<p class="note">新設定：{choiceText(unfinished.to)}</p>
				{#if carryNote(unfinished)}<p class="note">{carryNote(unfinished)}</p>{/if}
				<button type="button" class="wide primary" disabled={switching.sending[id]} onclick={resume}>
					{switching.sending[id] ? '處理中…' : '繼續切換'}
				</button>
				{#if confirmingSwitch}
					<p class="failed">{AGENT_ABANDON_CONFIRM_TEXT}</p>
					<button type="button" class="wide danger" onclick={giveUpSwitch}>確認放棄</button>
					<button type="button" class="wide" onclick={() => (confirmingSwitch = false)}>取消</button>
				{:else}
					<!-- While this page's stop or resume of it runs, it is given up only after (the server queues it too). -->
					<button type="button" class="wide" disabled={switching.sending[id]} onclick={() => (confirmingSwitch = true)}>放棄切換</button>
				{/if}
			{/if}
			{#if abandon}
				{#if confirming}
					<p class="failed">{ABANDON_CONFIRM_TEXT}</p>
					<button type="button" class="wide danger" onclick={() => giveUp(abandon)}>確認放棄</button>
					<button type="button" class="wide" onclick={() => (confirming = false)}>取消</button>
				{:else}
					<button type="button" class="wide" onclick={() => (confirming = true)}>放棄前一次接回</button>
				{/if}
			{/if}
			{#if check === 'missed' && !unfinished}
				<p class="failed">
					{SWITCH_MISSED_TEXT}：下一回合實際是 {settingsText(switching.current[id])}{controller?.client === 'codex'
						? '（常見原因：當初啟動時指定了 --model）'
						: ''}
				</p>
			{/if}
		</div>
	{:else if menu && status?.options}
		{@const kind = menu}
		{@const values = kind === 'model' ? status.options.models : status.options.efforts}
		<!-- The choices are the menu; the notes under it are read as text. -->
		<div class="menu">
			<div class="items" role="menu" aria-label={NAME[kind]} tabindex="-1" onkeydown={keys} {@attach focusChosen}>
				{#if waking}
					<button type="button" role="menuitemradio" aria-checked={!chosen[kind]} onclick={() => pick(kind, '')}>
						保持目前
						{#if current?.[kind]}<small title={current[kind]}>{short(kind, current[kind])}</small>{/if}
					</button>
				{/if}
				{#each values as value (value)}
					<button
						type="button"
						role="menuitemradio"
						aria-checked={(pending(kind) || current?.[kind]) === value}
						onclick={() => pick(kind, value)}
					>
						{short(kind, value)}<small>{value}</small>
					</button>
				{/each}
			</div>
			<p class="note">
				{waking
					? '只用在這次喚醒，送出時才套用。'
					: '選好模型與思考強度後按 ✓ 一次套用：看板會關掉原本的分頁，用新設定在新分頁接回同一段對話。'}
			</p>
			{#if kind === 'model' && !(waking ? chosen.effort : null) && !current?.effort}
				<p class="note">{EFFORT_UNKNOWN_TEXT}。</p>
			{/if}
			{#if kind === 'model' && status.lock === 'unknown'}
				<p class="note">{LOCK_UNKNOWN_TEXT}（{status.lockReason}），之後以下一回合核對結果。</p>
			{/if}
		</div>
	{/if}
</span>
