<script lang="ts">
	// The 組合鍵 of the command line's options pop-up, on a computer while a 畫面分頁 is shown: keys
	// the browser keeps for itself, sent into the pane on that screen whoever the line is for.
	// Disabled while the 按鍵選單's keys would be; the button's title says why.
	import { screenView } from '#lib/board/screen-view.svelte.ts';
	import { COMBO_KEYS } from '#lib/board/screen.ts';

	const blocked = $derived(screenView.blocked);
</script>

<div class="combos" role="group" aria-label="組合鍵">
	<span class="label">組合鍵</span>
	<div class="keys">
		{#each COMBO_KEYS as combo (combo.label)}
			<button type="button" disabled={blocked !== null} title={blocked ?? undefined} onclick={() => screenView.press(combo.input)}>{combo.label}</button>
		{/each}
	</div>
</div>

<style>
	.combos {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.label {
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.keys {
		display: flex;
		gap: 0.5rem;
	}
	button {
		font-family: var(--mono);
	}
</style>
