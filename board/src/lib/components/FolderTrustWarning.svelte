<script lang="ts">
	// An agent task whose client has not trusted its folder (#703): each run stops at the client's
	// trust question until its limit. The fix is one line: open the client there once and say yes.
	// Shown on the form once such a task is saved, and on the task's page until the folder is trusted.
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { clientName, type AgentClient } from '#lib/board/automation.ts';

	let { client, folder }: { client: AgentClient; folder: string } = $props();
	const name = $derived(clientName(client));
</script>

<section class="trust" role="alert" data-folder-untrusted={client}>
	<b><TriangleAlert size="1.1em" aria-hidden="true" />{name} 還沒信任這個資料夾，執行會卡在它的詢問畫面</b>
	<p>修法：在 <span class="mono">{folder}</span> 開一次 {name}，選信任這個資料夾。</p>
</section>

<style>
	.trust {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		padding: 0.5rem 0.8rem;
		border: 2px solid var(--warn);
		border-radius: var(--radius);
		background: var(--surface);
		line-height: 1.6;
		overflow-wrap: anywhere;
	}
	b {
		display: flex;
		align-items: flex-start;
		gap: 0.4rem;
	}
	b :global(svg) {
		flex: none;
		margin-top: 0.25em;
		color: var(--warn);
	}
	p {
		margin: 0;
	}
	.mono {
		font-family: var(--mono);
	}
</style>
