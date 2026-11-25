<script lang="ts">
	// Asked when a link to the board's own address is followed in the installed app and the page
	// holds what cannot be put back after it loads again (link-open.ts). Staying is the default.
	import { onMount } from 'svelte';
	import { setPrompter } from '#lib/board/link-open.ts';

	let ask = $state<{ labels: string[]; blocked: boolean } | null>(null);
	let answer: ((go: boolean) => void) | null = null;
	let stay = $state<HTMLButtonElement>();

	onMount(() => {
		setPrompter(
			(request) =>
				new Promise((resolve) => {
					answer?.(false);
					answer = resolve;
					ask = request;
				})
		);
	});

	$effect(() => {
		if (ask) stay?.focus();
	});

	function close(go: boolean) {
		answer?.(go);
		answer = null;
		ask = null;
	}
</script>

<svelte:window onkeydown={(event) => ask && event.key === 'Escape' && close(false)} />

{#if ask}
	<div class="veil" role="presentation">
		<div class="card" role="alertdialog" aria-modal="true" aria-labelledby="leave-title">
			{#if ask.blocked}
				<h2 id="leave-title">先不開這個連結</h2>
				<p>{ask.labels.length ? `沒辦法放掉：${ask.labels.join('、')}。` : '打到一半的字沒能先存好。'}先處理好，或把字複製起來，再開一次。</p>
				<div class="actions"><button bind:this={stay} type="button" class="stay" onclick={() => close(false)}>知道了</button></div>
			{:else}
				<h2 id="leave-title">離開看板前</h2>
				<p>字會保留，但這些不會：</p>
				<ul>
					{#each ask.labels as label (label)}<li>{label}</li>{/each}
				</ul>
				<div class="actions">
					<button bind:this={stay} type="button" class="stay" onclick={() => close(false)}>留在看板</button>
					<button type="button" class="leave" onclick={() => close(true)}>放棄並開啟</button>
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.veil {
		position: fixed;
		inset: 0;
		z-index: 100;
		display: grid;
		place-items: center;
		padding: 1rem;
		background: rgb(0 0 0 / 0.55);
	}
	.card {
		width: min(24rem, 100%);
		padding: 1rem 1.1rem;
		background: var(--surface);
		border: 2px solid var(--line);
		border-radius: var(--radius);
		box-shadow: 0 8px 28px rgb(0 0 0 / 0.45);
	}
	h2 {
		margin: 0 0 0.5rem;
		font-size: 1.05rem;
	}
	p {
		margin: 0 0 0.5rem;
		overflow-wrap: anywhere;
	}
	ul {
		margin: 0 0 0.9rem;
		padding-left: 1.3rem;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		justify-content: flex-end;
	}
	button {
		min-height: 2.75rem;
		min-width: 6.5rem;
		padding: 0.4rem 0.9rem;
		font: inherit;
		color: inherit;
		background: var(--surface);
		border: 2px solid var(--line);
		border-radius: var(--radius);
		cursor: pointer;
	}
	.stay {
		border-color: var(--accent, currentColor);
		font-weight: 600;
	}
	.leave {
		border-color: var(--danger);
	}
</style>
