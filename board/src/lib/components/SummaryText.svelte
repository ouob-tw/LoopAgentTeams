<script lang="ts">
	// A report summary: text, with its Markdown links to web addresses as links in a new tab.
	import { summaryParts } from '#lib/board/summary-links.ts';

	let { text }: { text: string } = $props();
</script>

{#each summaryParts(text) as part, index (index)}{#if part.href}<a href={part.href} target="_blank" rel="noopener noreferrer">{part.text}</a>{:else}{part.text}{/if}{/each}

<style>
	a {
		color: var(--accent);
		text-decoration: underline;
		pointer-events: auto;
	}
</style>
