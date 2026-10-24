<script lang="ts">
	// A small icon button that turns the conversation's English replies into Chinese and back; it
	// sits at the right end of the row holding the 對話紀錄 tab. It flips only the conversation open now;
	// the board's 對話翻譯 setting is what the next conversation starts from.
	import Languages from '@lucide/svelte/icons/languages';
	import { translatePref } from '#lib/board/translate-pref.svelte.ts';

	const label = $derived(translatePref.on ? '翻譯成中文（已開啟，按一下顯示原文）' : '翻譯成中文');
</script>

<button type="button" class="translate" aria-pressed={translatePref.on} aria-label="翻譯成中文" title={label} onclick={() => translatePref.set(!translatePref.on)}>
	<Languages size="1em" />
</button>

<style>
	.translate {
		flex: 0 0 auto;
		align-self: center;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.7rem;
		height: 1.7rem;
		margin-left: 0.3rem;
		padding: 0;
		border: 1px solid var(--line);
		background: none;
		color: var(--muted);
		font-size: max(1rem, var(--min-font, 0px));
		cursor: pointer;
	}
	.translate[aria-pressed='true'] {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--bg);
	}
</style>
