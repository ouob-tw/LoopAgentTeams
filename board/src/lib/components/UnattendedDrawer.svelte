<script lang="ts">
	// The form that turns a controller's unattended mode on, or changes the grant in effect (修改):
	// this round's goal, what counts as done, what the advisors may decide and when it stops. It
	// slides in from the right, or up from the bottom on a phone, starting from the goal the
	// controller drafted (修改: from the version in effect). Nothing is written until 確認開啟.
	import { tick } from 'svelte';
	import { fade, fly } from 'svelte/transition';
	import { MediaQuery } from 'svelte/reactivity';
	import { toasts } from '#lib/board/toasts.svelte.ts';
	import { sendGrant, unattendedUi } from '#lib/board/unattended-ui.svelte.ts';
	import { formFor, formProblem, SCOPE_KEYS, SCOPE_LABEL, type GrantForm } from '#lib/board/unattended.ts';
	import type { Controller } from '#lib/board/types.ts';

	let { controllers }: { controllers: Controller[] } = $props();

	const phone = new MediaQuery('(max-width: 760px)', false);
	const open = $derived(unattendedUi.form);
	const controller = $derived(open ? controllers.find((candidate) => candidate.id === open.controllerId) : undefined);
	const view = $derived(controller?.unattended);

	let form = $state<GrantForm | null>(null);
	/** Whether the form starts from something the controller wrote. */
	let drafted = $state(false);
	let sending = $state(false);
	let refusal = $state<string | null>(null);
	let panel = $state<HTMLElement>();

	// A new opening starts from what is in effect then; later snapshots leave what is being typed alone.
	let opened: typeof open = null;
	$effect(() => {
		if (open === opened) return;
		opened = open;
		refusal = null;
		if (!open || !view || !('mode' in view)) {
			form = null;
			return;
		}
		form = formFor(view, open.editing);
		drafted = open.editing ? view.version !== null : view.draft !== null;
		void tick().then(() => panel?.querySelector<HTMLElement>('input, textarea')?.focus());
	});

	const problem = $derived(form && formProblem(form));
	const editing = $derived(open?.editing ?? false);

	function close() {
		unattendedUi.form = null;
	}

	async function submit() {
		if (!open || !form || problem || sending) return;
		sending = true;
		const result = await sendGrant(open.controllerId, editing ? 'update' : 'create', $state.snapshot(form));
		sending = false;
		if (!result.ok) {
			refusal = result.reason;
			return;
		}
		toasts.show('ok', editing ? '已送出修改，新版本立即生效。' : '已開啟無人模式。');
		close();
	}

	const fromSide = $derived(phone.current ? { y: 480, duration: 220 } : { x: 520, duration: 220 });
</script>

<svelte:window onkeydown={(event) => open && event.key === 'Escape' && close()} />

{#if open}
	<!-- The page behind is dimmed and does not take clicks; a click on it is 取消. -->
	<div class="backdrop" aria-hidden="true" onclick={close} transition:fade={{ duration: 180 }}></div>
	<div
		class="drawer"
		class:sheet={phone.current}
		role="dialog"
		aria-modal="true"
		aria-labelledby="unattended-form-title"
		bind:this={panel}
		transition:fly={fromSide}
	>
		<h2 id="unattended-form-title">{editing ? '修改無人模式' : '開啟無人模式'}</h2>
		{#if !form}
			<p class="alert" role="alert">{view?.state === 'error' ? `讀不到這個主控的無人模式：${view.reason}` : '還沒讀到這個主控的無人模式，請稍後再開。'}</p>
			<div class="actions"><button type="button" onclick={close}>關閉</button></div>
		{:else}
			<p class="hint">
				{#if editing}送出後成為新版本，立即生效；舊版本保留在紀錄裡。{:else if drafted}已依你的第一句話先擬好，請改成你要的。{:else}主控還沒擬好目標，請自己寫。{/if}
			</p>
			<form
				onsubmit={(event) => {
					event.preventDefault();
					void submit();
				}}
			>
				<label class="field">
					<span class="label">這一輪的目標</span>
					<input type="text" bind:value={form.goal} />
				</label>
				<label class="field">
					<span class="label">怎麼算做完</span>
					<span class="note">寫成看得出有沒有達成的條件，一行一條。</span>
					<textarea rows="3" bind:value={form.done}></textarea>
				</label>
				<fieldset>
					<legend class="label">參謀可以替你決定的事</legend>
					{#each SCOPE_KEYS as key (key)}
						<label class="check"><input type="checkbox" bind:checked={form.scope[key]} /><span>{SCOPE_LABEL[key]}</span></label>
					{/each}
					<p class="note">要花錢、刪你的資料、推 main、對外發佈、大改驗收、只有你本人能做的事，一律不代答，會擱置等你。</p>
				</fieldset>
				<fieldset>
					<legend class="label">什麼時候停</legend>
					<label class="check"><input type="checkbox" checked disabled /><span>額度用完就停</span></label>
				</fieldset>
				<label class="field">
					<span class="label">時間上限</span>
					<span class="hours"><input type="number" min="1" step="1" inputmode="numeric" bind:value={form.maxHours} /><span>小時</span></span>
					<span class="note">從這一輪的第一版開始算，到時自動關掉。</span>
				</label>
				{#if problem}<p class="why" role="status">{problem}</p>{/if}
				{#if refusal}<p class="alert" role="alert">沒有生效：{refusal}</p>{/if}
				<div class="actions">
					<button type="submit" class="primary" disabled={!!problem || sending}>{editing ? '送出修改' : '確認開啟'}</button>
					<button type="button" onclick={close}>取消</button>
				</div>
			</form>
		{/if}
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 59;
		background: rgb(0 0 0 / 0.45);
	}
	/* A computer: the full height at the right edge, over the controller's column. */
	.drawer {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		z-index: 60;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		width: min(520px, 100vw);
		padding: 1rem 1.1rem calc(1rem + env(safe-area-inset-bottom, 0px));
		overflow-y: auto;
		overscroll-behavior: contain;
		background: var(--surface);
		border-left: 2px solid var(--text);
		box-shadow: -4px 0 16px rgb(0 0 0 / 0.35);
	}
	/* A phone: a sheet up from the bottom, the page above it still in sight. */
	.drawer.sheet {
		top: auto;
		left: 0;
		width: auto;
		max-height: 88dvh;
		border-left: 0;
		border-top: 2px solid var(--text);
		border-radius: 14px 14px 0 0;
		box-shadow: 0 -4px 16px rgb(0 0 0 / 0.35);
	}
	h2 {
		margin: 0;
		font-size: max(1rem, var(--min-font, 0px));
	}
	.hint {
		margin: 0;
		padding: 0.35rem 0.6rem;
		border: 1px dashed var(--muted);
		border-radius: var(--radius);
		color: var(--muted);
	}
	form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.field,
	fieldset {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
	.label {
		padding: 0;
		font-weight: 700;
	}
	.note {
		margin: 0;
		color: var(--muted);
	}
	.check {
		display: flex;
		gap: 0.5rem;
		align-items: flex-start;
	}
	.check input {
		flex: none;
		width: 1.2rem;
		height: 1.2rem;
		margin: 0.15rem 0 0;
	}
	textarea {
		resize: vertical;
	}
	.hours {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}
	.hours input {
		width: 6rem;
	}
	.why {
		margin: 0;
		color: var(--warn);
	}
	.alert {
		margin: 0;
		color: var(--danger);
		overflow-wrap: anywhere;
	}
	.actions {
		display: flex;
		gap: 0.5rem;
	}
	/* A finger's width on a phone (ui-baseline). */
	button {
		min-height: 44px;
	}
</style>
