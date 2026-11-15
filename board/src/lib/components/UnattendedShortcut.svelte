<script lang="ts">
	// The 無人模式 button of a controller page's button row, left of the close: it says which mode
	// the controller is in, and a tap opens the command line's 無人模式 menu (UnattendedMenu) under it.
	import type { UnattendedView } from '#lib/board/unattended.ts';
	import UnattendedMenu from './UnattendedMenu.svelte';

	let { controllerId, view }: { controllerId: string; view: UnattendedView } = $props();

	let open = $state(false);
	let wrap = $state<HTMLElement>();
	/** On while it holds a grant or waits for the controller's goal. */
	const on = $derived(view.state === 'active' || view.state === 'pending-goal');
	$effect(() => {
		if (!open) return;
		const away = (event: Event) => {
			if (!(event.target instanceof Node && wrap?.contains(event.target))) open = false;
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key === 'Escape') open = false;
		};
		document.addEventListener('pointerdown', away);
		document.addEventListener('keydown', escape);
		return () => {
			document.removeEventListener('pointerdown', away);
			document.removeEventListener('keydown', escape);
		};
	});
</script>

{#if view.state !== 'unknown'}
	<div class="shortcut" bind:this={wrap}>
		<button type="button" class="toggle" class:on data-action="unattended" aria-expanded={open} aria-controls={open ? `unattended-shortcut-${controllerId}` : undefined} onclick={() => (open = !open)}>
			無人模式<span class="state">{on ? '開' : '關'}</span>
		</button>
		{#if open}
			<div class="popup" id="unattended-shortcut-{controllerId}">
				<UnattendedMenu {controllerId} {view} ondone={() => (open = false)} />
			</div>
		{/if}
	</div>
{/if}

<style>
	.shortcut {
		position: relative;
	}
	/* A finger's width on a phone (ui-baseline). */
	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.35em;
		min-height: 44px;
	}
	@media (max-width: 480px) {
		.toggle {
			padding-inline: 0.55rem;
		}
	}
	.state {
		font-weight: 700;
	}
	.toggle.on {
		background: var(--selected-bg);
		border-color: var(--selected-bg);
		color: var(--selected-text);
	}
	.popup {
		position: absolute;
		left: 0;
		top: calc(100% + 0.3rem);
		z-index: 40;
		width: min(26rem, calc(100vw - 2rem));
		padding: 0.8rem 0.9rem;
		background: var(--surface);
		border: 2px solid var(--text);
		border-radius: var(--radius);
		box-shadow: 0 4px 16px rgb(0 0 0 / 0.35);
	}
</style>
