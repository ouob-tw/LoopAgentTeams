<script lang="ts">
	// The menu a right click opens on a launch that is over (failed, overdue, uncertain), on its
	// roster card or its folded mark: one item, 關閉, which removes it as the card's corner button
	// does. Opened where the pointer is (by the element when opened from the keyboard), kept on the
	// screen, fixed like the Herdr list's tab menu; a click elsewhere, Escape,
	// scrolling or resizing closes it without removing anything.
	let { x, y, onpick, onclose }: { x: number; y: number; onpick: () => void; onclose: () => void } = $props();

	let box = $state<HTMLElement>();

	$effect(() => {
		if (!box) return;
		const { width, height } = box.getBoundingClientRect();
		box.style.left = `${Math.max(8, Math.min(x, innerWidth - width - 8))}px`;
		box.style.top = `${Math.max(8, Math.min(y, innerHeight - height - 8))}px`;
		box.querySelector('button')?.focus();
	});
</script>

<svelte:window
	onpointerdown={(event) => {
		if (!box?.contains(event.target as Node)) onclose();
	}}
	onkeydown={(event) => {
		if (event.key === 'Escape') onclose();
	}}
	onscroll={onclose}
	onresize={onclose}
/>

<div class="launch-menu" role="menu" aria-label="啟動卡" bind:this={box}>
	<button
		type="button"
		role="menuitem"
		onclick={() => {
			onpick();
			onclose();
		}}>關閉</button
	>
</div>

<style>
	.launch-menu {
		position: fixed;
		z-index: 20;
		left: 0;
		top: 0;
		padding: 0.25rem;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--surface);
		box-shadow: 0 4px 16px rgb(0 0 0 / 0.35);
	}
	.launch-menu button {
		display: block;
		width: 100%;
		min-width: 6rem;
		min-height: 2.4rem;
		border: none;
		text-align: left;
	}
</style>
