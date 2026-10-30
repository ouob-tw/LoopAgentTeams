<script lang="ts">
	// A question's demo links as buttons, each opening in a new tab. Nothing is drawn without links.
	let { urls = [] }: { urls?: string[] } = $props();
</script>

{#if urls.length}
	<div class="visuals">
		{#each urls as url, index (index)}
			<a class="visual" href={url} target="_blank" rel="noopener noreferrer" title={url}>看示意{urls.length > 1 ? ` ${index + 1}` : ''}</a>
		{/each}
	</div>
{/if}

<style>
	.visuals {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.visual {
		display: inline-flex;
		align-items: center;
		padding: 0.25rem 0.7rem;
		border: 1px solid var(--accent);
		border-radius: var(--radius);
		color: var(--accent);
		text-decoration: none;
	}
	.visual:hover {
		background: color-mix(in srgb, var(--accent) 12%, var(--bg));
	}
</style>
