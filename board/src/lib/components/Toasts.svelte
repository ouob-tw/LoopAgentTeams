<script lang="ts">
	// Notices float over the page's corner, so showing or closing one never moves the content.
	// `standing` are the board's own conditions (offline, read errors), shown while they last, like
	// those components put in `toasts.standing`.
	import X from '@lucide/svelte/icons/x';
	import { toasts, type ToastKind } from '#lib/board/toasts.svelte.ts';

	let { standing = [] }: { standing?: { kind: ToastKind; text: string }[] } = $props();

	/** Standing notices the user closed; one comes back once its condition has cleared. */
	let hidden = $state<string[]>([]);
	$effect(() => {
		const current = new Set(all.map((notice) => notice.text));
		if (hidden.some((text) => !current.has(text))) hidden = hidden.filter((text) => current.has(text));
	});
	const all = $derived([...standing, ...Object.values(toasts.standing)]);
	const shown = $derived(all.filter((notice) => !hidden.includes(notice.text)));
</script>

<div class="toasts">
	{#each shown as notice (notice.text)}
		<div class="toast" data-kind={notice.kind} role={notice.kind === 'failed' ? 'alert' : 'status'}>
			<p>{notice.text}</p>
			<button aria-label="關閉" title="關閉" onclick={() => (hidden = [...hidden, notice.text])}><X size="1em" /></button>
		</div>
	{/each}
	{#each toasts.list as toast (toast.id)}
		<div class="toast" data-kind={toast.kind} role={toast.kind === 'failed' ? 'alert' : 'status'}>
			<p>{toast.kind === 'ok' ? '✓ ' : toast.kind === 'failed' ? '✗ ' : ''}{toast.text}</p>
			<button aria-label="關閉" title="關閉" onclick={() => toasts.close(toast.id)}><X size="1em" /></button>
		</div>
	{/each}
</div>

<style>
	/* Placed just above the command line by the page; see `.dock` there. */
	.toasts {
		position: absolute;
		right: 1rem;
		bottom: calc(100% + 0.5rem);
		z-index: 50;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		width: min(24rem, calc(100vw - 2rem));
		pointer-events: none;
	}
	.toast {
		display: flex;
		gap: 0.5rem;
		align-items: flex-start;
		padding: 0.55rem 0.5rem 0.55rem 0.8rem;
		background: var(--surface);
		border: 2px solid var(--line);
		border-left-width: 4px;
		border-radius: var(--radius);
		box-shadow: 0 4px 16px rgb(0 0 0 / 0.35);
		pointer-events: auto;
	}
	.toast[data-kind='ok'] {
		border-left-color: var(--ok);
	}
	.toast[data-kind='failed'] {
		border-color: var(--danger);
	}
	p {
		flex: 1;
		margin: 0;
		font-size: max(0.85rem, var(--min-font, 0px));
		overflow-wrap: anywhere;
	}
	.toast[data-kind='failed'] p {
		color: var(--danger);
	}
	button {
		display: flex;
		flex: none;
		padding: 0.2rem;
		border: 0;
		background: none;
		color: var(--muted);
	}
	/* A phone has its message box low on the screen; the notices sit under the top bar instead. */
	@media (max-width: 760px) {
		.toasts {
			position: fixed;
			top: 4rem;
			bottom: auto;
		}
	}
</style>
