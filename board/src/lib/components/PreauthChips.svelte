<script lang="ts">
	// A list of branch names: × removes one, Enter adds what is typed. Text not yet added stays in the box.
	let { label, items, onchange }: { label: string; items: string[]; onchange: (items: string[]) => void } = $props();

	let draft = $state('');

	function add(event: KeyboardEvent) {
		if (event.key !== 'Enter' || event.isComposing) return;
		event.preventDefault();
		const name = draft.trim();
		draft = '';
		if (name && !items.includes(name)) onchange([...items, name]);
	}
</script>

<div class="chips" role="group" aria-label={label}>
	<!-- By place: a hand-written file may name a branch twice. -->
	{#each items as item, index (index)}
		<span class="chip">{item}<button aria-label={`移除 ${item}`} onclick={() => onchange(items.toSpliced(index, 1))}>×</button></span>
	{/each}
	<input aria-label={`新增${label}`} placeholder="＋ 分支" bind:value={draft} onkeydown={add} />
</div>

<style>
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		align-items: center;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.15rem;
		padding: 0 0.15rem 0 0.5rem;
		border: 1px solid var(--line);
		border-radius: var(--radius-pill);
		background: color-mix(in srgb, var(--text) 10%, var(--bg));
		font-size: max(0.8rem, var(--min-font, 0px));
		overflow-wrap: anywhere;
	}
	.chip button {
		padding: 0 0.3rem;
		background: none;
		border: 0;
		color: var(--muted);
	}
	input {
		flex: 1 1 4rem;
		width: 4rem;
		padding: 0.05rem 0.4rem;
		border-style: dashed;
		border-radius: var(--radius-pill);
		font-size: max(0.8rem, var(--min-font, 0px));
	}
</style>
