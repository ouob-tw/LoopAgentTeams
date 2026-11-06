<script lang="ts">
	// The 按鍵選單: a phone's keys, floating over the 畫面分頁's lower right corner. Small, it is one round
	// button; opened, a panel of every key with a close button, open or small as this device last left it.
	// It stays open after a key, and a tap never takes the focus, so the on-screen keyboard stays up
	// while typing in the command line. Keys are disabled while the screen cannot be read or a press may
	// not have arrived; the panel above the screen says why. `covers` is how much of the screen the open
	// panel covers from the bottom, for the screen to move its content up by.
	import { onMount } from 'svelte';
	import { KEY_MENU_KEY, remember, remembered } from '#lib/board/prefs.ts';
	import { screenView } from '#lib/board/screen-view.svelte.ts';
	import { KEY_MENU } from '#lib/board/screen.ts';

	let { covers = $bindable() }: { covers: number } = $props();

	let open = $state(false);
	onMount(() => {
		open = remembered(KEY_MENU_KEY, ['1', '0'], '0') === '1';
	});
	function setOpen(value: boolean) {
		open = value;
		remember(KEY_MENU_KEY, value ? '1' : '0');
	}

	let panel = $state<HTMLElement>();
	let panelHeight = $state(0);
	// From the panel's top to the box's bottom, the gap under it included, as laid out.
	$effect(() => {
		void panelHeight;
		covers = open && panel?.offsetParent ? panel.offsetParent.clientHeight - panel.offsetTop : 0;
	});
	// The box grows or shrinks when the command line goes away or comes back, moving the panel with it.
	$effect(() => {
		const box = panel?.offsetParent;
		if (!box) return;
		const watch = new ResizeObserver(() => (covers = panel?.offsetParent ? panel.offsetParent.clientHeight - panel.offsetTop : 0));
		watch.observe(box);
		return () => watch.disconnect();
	});

	const blocked = $derived(screenView.blocked);
	const keep = (event: Event) => event.preventDefault();
</script>

{#snippet keys(entries: (typeof KEY_MENU)[keyof typeof KEY_MENU])}
	{#each entries as entry (entry.label)}
		<button type="button" disabled={blocked !== null} onpointerdown={keep} onclick={() => screenView.press(entry.input)}>{entry.label}</button>
	{/each}
{/snippet}

{#if open}
	<div class="panel" role="toolbar" aria-label="按鍵選單" title={blocked ?? undefined} bind:this={panel} bind:offsetHeight={panelHeight}>
		<div class="head">按鍵<button type="button" class="close" aria-label="收起按鍵選單" onpointerdown={keep} onclick={() => setOpen(false)}>✕</button></div>
		<div class="groups">
			<div class="named">{@render keys(KEY_MENU.named)}</div>
			<div class="arrows">{@render keys(KEY_MENU.arrows)}</div>
			<div class="numbers">{@render keys(KEY_MENU.numbers)}</div>
		</div>
	</div>
{:else}
	<button type="button" class="round" aria-label="打開按鍵選單" onpointerdown={keep} onclick={() => setOpen(true)}>鍵</button>
{/if}

<style>
	.round {
		position: absolute;
		right: 0.625rem;
		bottom: 0.625rem;
		z-index: 1;
		width: 2.75rem;
		height: 2.75rem;
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: var(--accent);
		box-shadow: 0 2px 8px rgb(0 0 0 / 0.6);
		color: var(--bg);
		font-size: max(1rem, var(--min-font, 0px));
		font-weight: 700;
		touch-action: manipulation;
	}
	/* With the command line put away, its round button floats at the box's bottom right: the keys sit above it. */
	:global(.screen-open:has(.dock .reopen)) .round,
	:global(.screen-open:has(.dock .reopen)) .panel {
		bottom: calc(44px + 0.8rem + env(safe-area-inset-bottom, 0px) + 0.4rem);
	}
	.panel {
		position: absolute;
		right: 0.5rem;
		bottom: 0.5rem;
		z-index: 1;
		box-sizing: border-box;
		width: min(15.25rem, calc(100% - 1rem));
		max-height: calc(100% - 1rem);
		overflow-y: auto;
		padding: 0.375rem 0.5rem 0.5rem;
		border: 1px solid var(--line);
		border-radius: 0.75rem;
		background: var(--surface);
		box-shadow: 0 4px 16px rgb(0 0 0 / 0.5);
		color: var(--muted);
		font-size: max(0.8125rem, var(--min-font, 0px));
		line-height: 1.2;
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.25rem;
	}
	.groups {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 0.25rem 0.5rem;
	}
	.named,
	.arrows,
	.numbers {
		display: grid;
		grid-auto-rows: 2.125rem;
		gap: 0.25rem;
	}
	.named {
		grid-template-columns: 1fr 1fr;
		min-width: 0;
	}
	.named button:last-child {
		grid-column: span 2;
	}
	.arrows {
		grid-template-columns: repeat(3, 1.875rem);
	}
	.arrows button:first-child {
		grid-column: 2;
	}
	.arrows button:nth-child(2) {
		grid-column: 1;
	}
	.numbers {
		grid-column: span 2;
		grid-template-columns: repeat(4, 1fr);
	}
	/* A phone on its side: too low for the keys in rows, so the numbers go beside them. */
	@media (max-height: 500px) {
		.panel {
			width: min(23rem, calc(100% - 1rem));
		}
		.groups {
			grid-template-columns: 1fr auto 5rem;
		}
		.numbers {
			grid-column: auto;
			grid-template-columns: 1fr 1fr;
		}
	}
	button {
		padding: 0;
		border: 1px solid var(--line);
		border-radius: 6px;
		background: var(--bg);
		color: var(--text);
		font-family: var(--mono);
		font-size: inherit;
		white-space: nowrap;
		touch-action: manipulation;
	}
	button:disabled {
		opacity: 0.45;
	}
	.close {
		width: 1.625rem;
		height: 1.625rem;
		background: none;
	}
</style>
