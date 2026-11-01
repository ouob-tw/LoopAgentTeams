<script lang="ts">
	// A question's demo links as buttons, each opening in a new tab. Nothing is drawn without links.
	let { urls = [], labels = [] }: { urls?: string[]; labels?: string[] } = $props();

	const text = (index: number) => {
		if (labels[index]) return `看示意 ${labels[index]}`;
		return urls.length > 1 ? `看示意 ${index + 1}` : '看示意';
	};
</script>

{#if urls.length}
	<div class="visuals">
		{#each urls as url, index (index)}
			<a class="visual" href={url} target="_blank" rel="noopener noreferrer" title={url}>{text(index)}</a>
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
		overflow-wrap: anywhere;
	}
	.visual:hover {
		background: color-mix(in srgb, var(--accent) 12%, var(--bg));
	}
</style>
