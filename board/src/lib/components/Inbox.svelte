<script lang="ts">
	// The inbox list, by time or by project, or the processed items (已處理).
	import { lastSegment } from '#lib/board/agents.ts';
	import { groupByProject, sortByTime, type InboxSort } from '#lib/board/inbox.ts';
	import type { ArchivePage } from '#lib/board/archive.ts';
	import type { Controller, InboxItem } from '#lib/board/types.ts';
	import ItemRow from './ItemRow.svelte';
	import StatusMark from './StatusMark.svelte';

	let {
		items,
		controllers,
		sort,
		showArchive,
		archive,
		earlier,
		processedCount,
		currentKey,
		onsort,
		onarchive,
		onearlier,
		onretry,
		onopen,
		oncontroller
	}: {
		/** What the inbox lists: questions and unread reports, and the report open since it was read. */
		items: InboxItem[];
		controllers: Controller[];
		sort: InboxSort;
		showArchive: boolean;
		/** Processed items loaded so far, newest first; null while loading, 'failed' when they could
		 *  not be read. */
		archive: ArchivePage | 'failed' | null;
		/** Loading the page after the loaded ones. */
		earlier: 'idle' | 'loading' | 'failed';
		processedCount: number;
		currentKey: string | null;
		onsort: (sort: InboxSort) => void;
		onarchive: () => void;
		onearlier: () => void;
		/** Read the processed items again after they could not be read. */
		onretry: () => void;
		onopen: (item: InboxItem) => void;
		oncontroller: (id: string) => void;
	} = $props();

	const byId = $derived(new Map(controllers.map((controller) => [controller.id, controller])));
	// The label opens the information page only while the controller is on the roster.
	const owner = (item: InboxItem) => (byId.has(item.controllerId) ? () => oncontroller(item.controllerId) : undefined);

	let end = $state<HTMLElement>();
	// Watched again after every load, so an end that is still in view loads the next page. After a
	// failure only the button retries.
	$effect(() => {
		if (!showArchive || !end || earlier !== 'idle' || typeof archive !== 'object' || !archive?.before) return;
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((entry) => entry.isIntersecting)) onearlier();
		});
		observer.observe(end);
		return () => observer.disconnect();
	});
</script>

<header>
	<h2 class="visually-hidden">待辦</h2>
	<div class="toggle" role="group" aria-label="待辦檢視">
		<button aria-pressed={!showArchive && sort === 'time'} onclick={() => onsort('time')}>依時間</button>
		<button aria-pressed={!showArchive && sort === 'project'} onclick={() => onsort('project')}>依專案</button>
		<button aria-pressed={showArchive} onclick={onarchive}>已處理{processedCount ? ` ${processedCount}` : ''}</button>
	</div>
</header>

{#if showArchive}
	{#if archive === null}
		<p class="none" role="status">讀取中…</p>
	{:else if archive === 'failed'}
		<p class="none" role="alert">已處理的項目讀不出來。</p>
		<button class="earlier" onclick={onretry}>再試一次</button>
	{:else}
		{#each archive.items as item (item.key)}
			<ItemRow {item} processed current={item.key === currentKey} {onopen} onowner={owner(item)} />
		{:else}
			<p class="none">沒有已處理的項目。</p>
		{/each}
		{#if archive.before !== null}
			<button class="earlier" bind:this={end} onclick={onearlier} disabled={earlier === 'loading'}>
				{earlier === 'loading' ? '載入中…' : '載入更早'}
			</button>
		{/if}
	{/if}
{:else if sort === 'time'}
	{#each sortByTime(items) as item (item.key)}
		<ItemRow {item} current={item.key === currentKey} {onopen} onowner={owner(item)} />
	{:else}
		<p class="none">沒有待辦。</p>
	{/each}
{:else}
	{#each groupByProject(items) as project (project.workspace)}
		<h3 title={project.workspace}>{project.project}</h3>
		{#each project.controllers as group (group.controllerId)}
			<button class="owner" onclick={() => oncontroller(group.controllerId)}>
				<StatusMark status={byId.get(group.controllerId)?.status ?? 'closed'} />
				{project.project} · <span title="@{group.hcomName}">@{lastSegment(group.hcomName)}</span>
			</button>
			<div class="nest">
				{#each group.items as item (item.key)}
					<ItemRow {item} current={item.key === currentKey} showOwner={false} {onopen} />
				{/each}
			</div>
		{/each}
	{:else}
		<p class="none">沒有待辦。</p>
	{/each}
{/if}

<style>
	header {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-start;
		align-items: center;
		gap: 0.4rem;
		margin-bottom: 0.4rem;
	}
	/* Named for assistive technology only: the 待辦 tab above already says it. */
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		padding: 0;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	.toggle {
		display: flex;
	}
	.toggle button {
		padding: 0.25rem 0.7rem;
		border-radius: 0;
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
		white-space: nowrap;
	}
	.toggle button + button {
		border-left: 0;
	}
	.toggle button:first-child {
		border-radius: var(--radius) 0 0 var(--radius);
	}
	.toggle button:last-child {
		border-radius: 0 var(--radius) var(--radius) 0;
	}
	.toggle button[aria-pressed='true'] {
		color: var(--selected-text);
	}
	h3 {
		margin: 0.9rem 0 0.1rem;
		font-size: max(0.8rem, var(--min-font, 0px));
		font-weight: 600;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.owner {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		padding: 0;
		background: none;
		border: 0;
		font-size: max(0.75rem, var(--min-font, 0px));
		color: var(--accent);
		text-align: left;
		overflow-wrap: anywhere;
	}
	.owner:hover,
	:global(:root[data-theme='light']) .owner {
		text-decoration: underline;
	}
	.nest {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		margin-left: 0.3rem;
		padding-left: 0.6rem;
		border-left: 1px solid var(--line);
	}
	.none {
		margin: 0.5rem 0;
		color: var(--muted);
	}
	.earlier {
		align-self: flex-start;
		margin-top: 0.4rem;
	}
</style>
