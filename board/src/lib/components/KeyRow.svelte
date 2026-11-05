<script lang="ts">
	// The 按鍵列: one line of keys above the command line on a phone while a 畫面分頁 is shown, sliding
	// sideways when they do not fit. A tap sends the key into the agent's pane. A tap does not take
	// the focus, so the on-screen keyboard stays up while typing in the command line. Disabled while
	// the screen cannot be read or a press may not have arrived; the panel says why.
	import { screenView } from '#lib/board/screen-view.svelte.ts';
	import { KEY_ROW } from '#lib/board/screen.ts';

	const blocked = $derived(screenView.blocked);
</script>

<div class="keyrow" role="toolbar" aria-label="按鍵列" title={blocked ?? undefined}>
	{#each KEY_ROW as entry (entry.label)}
		<button type="button" disabled={blocked !== null} onpointerdown={(event) => event.preventDefault()} onclick={() => screenView.press(entry.input)}>{entry.label}</button>
	{/each}
</div>

<style>
	.keyrow {
		display: flex;
		flex-wrap: nowrap;
		gap: 0.35rem;
		overflow-x: auto;
		padding: 0.35rem 0.6rem;
		border-top: 1px solid var(--line);
		background: var(--surface);
		scrollbar-width: none;
		overscroll-behavior-x: contain;
		/* A phone's dock lets touches through but where it shows something. */
		pointer-events: auto;
	}
	.keyrow::-webkit-scrollbar {
		display: none;
	}
	button {
		flex: none;
		min-width: 2.6rem;
		padding: 0.35rem 0.6rem;
		border: 1px solid var(--line);
		border-radius: 6px;
		background: var(--bg);
		color: var(--text);
		font-family: var(--mono);
		font-size: max(0.85rem, var(--min-font, 0px));
		white-space: nowrap;
		touch-action: manipulation;
	}
	button:disabled {
		opacity: 0.45;
	}
</style>
