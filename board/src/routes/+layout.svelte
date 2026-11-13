<script lang="ts">
	import { onMount } from 'svelte';
	import '../app.css';

	let { children } = $props();
	// For tests: the page has started and takes taps (the server-drawn page before this ignores them).
	onMount(() => (document.body.dataset.hydrated = ''));
</script>

{@render children()}
