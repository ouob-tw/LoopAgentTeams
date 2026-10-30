<script lang="ts">
	// What a pre-authorization section has to say about its files: their errors, a refused save, and
	// the moment a save went through.
	import type { PreauthEditor } from '#lib/board/preauth-editor.svelte.ts';

	let { editor }: { editor: PreauthEditor } = $props();

	const problems = $derived(editor.settings?.problems ?? []);
	// The dialog reads no project, one of which may set a window's other half.
	const brokenFile = $derived(editor.scope === 'project' || !!editor.settings?.layers[editor.scope]?.problems.length);

	// A refusal may come from a control far below the top of the section.
	let refusalBox = $state<HTMLElement>();
	$effect(() => {
		refusalBox?.scrollIntoView({ block: 'nearest' });
	});
</script>

{#if problems.length}
	<div role="alert">
		<p>{brokenFile ? '設定檔有錯，所有查詢都會要問。修好檔案後重新載入。' : '時段或時區只寫了一個，專案沒補上另一個時，所有查詢都會要問。'}</p>
		<ul>
			{#each problems as problem}<li>{problem}</li>{/each}
		</ul>
	</div>
{/if}

{#if editor.refusal}
	{@const refusal = editor.refusal}
	<div role="alert" bind:this={refusalBox}>
		<p>{refusal.reason ?? refusal.message ?? '沒有寫入，請重新載入。'}</p>
		{#if refusal.problems?.length}
			<ul>
				{#each refusal.problems as problem}<li>{problem}</li>{/each}
			</ul>
		{/if}
		{#if refusal.toUndo?.length}
			<p>要手動改回：</p>
			<ul>
				{#each refusal.toUndo as line}<li>{line}</li>{/each}
			</ul>
		{/if}
		{#if refusal.current}
			<p>設定檔目前內容：</p>
			<pre>{refusal.current}</pre>
		{/if}
	</div>
{/if}

{#if problems.length || editor.refusal}
	<div><button disabled={editor.busy} onclick={() => editor.reload()}>重新載入</button></div>
{/if}

<!-- Fixed, so it is seen wherever the section is scrolled to; inside the section, so a modal dialog does not cover it. -->
{#if editor.savedMark}<p class="saved" role="status">已儲存</p>{/if}

<style>
	[role='alert'] p {
		margin: 0.35rem 0;
	}
	ul {
		margin: 0.4rem 0;
		padding-left: 1.1rem;
		font-size: max(0.8rem, var(--min-font, 0px));
		overflow-wrap: anywhere;
	}
	pre {
		margin: 0;
		max-height: 12rem;
		overflow: auto;
		font-size: max(0.8rem, var(--min-font, 0px));
	}
	.saved {
		position: fixed;
		left: 50%;
		bottom: 5.5rem;
		z-index: 30;
		margin: 0;
		padding: 0.25rem 0.9rem;
		transform: translateX(-50%);
		background: var(--surface);
		border: 1px solid var(--ok);
		border-radius: var(--radius-pill);
		font-size: max(0.85rem, var(--min-font, 0px));
	}
</style>
