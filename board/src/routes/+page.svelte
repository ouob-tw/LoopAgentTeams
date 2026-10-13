<script lang="ts">
	// Wide: roster, inbox and content side by side. Narrow: the roster strip above the inbox, and
	// one content screen at a time once something is opened.
	import { onMount, tick } from 'svelte';
	import type { InboxSort } from '#lib/board/inbox.ts';
	import { LiveBoard } from '#lib/board/live.svelte.ts';
	import { remember, remembered } from '#lib/board/prefs.ts';
	import type { InboxItem } from '#lib/board/types.ts';
	import ControllerInfo from '#lib/components/ControllerInfo.svelte';
	import Inbox from '#lib/components/Inbox.svelte';
	import ItemContent from '#lib/components/ItemContent.svelte';
	import Roster from '#lib/components/Roster.svelte';

	let { data } = $props();

	// svelte-ignore state_referenced_locally
	const board = new LiveBoard(data.snapshot);
	onMount(() => board.connect());

	const SORT_KEY = 'lat-board-inbox-sort';
	let sort = $state<InboxSort>('time');
	onMount(() => {
		sort = remembered(SORT_KEY, ['time', 'project'], 'time');
	});
	let showArchive = $state(false);

	function setSort(next: InboxSort) {
		sort = next;
		showArchive = false;
		remember(SORT_KEY, next);
	}

	// The item is kept as it was when opened, so the content stays up after it leaves the inbox.
	type View = { kind: 'item'; item: InboxItem } | { kind: 'controller'; id: string } | null;
	let view = $state<View>(null);

	const controllers = $derived(board.snapshot.controllers);
	const inbox = $derived(board.snapshot.inbox);
	const archivedCount = $derived(board.snapshot.archivedCount);

	// The archive is fetched when its view is open, and again whenever a report moves into it.
	$effect(() => {
		if (showArchive && archivedCount >= 0) void board.loadArchive();
	});

	const openKey = $derived(view?.kind === 'item' ? view.item.key : null);
	const inInbox = $derived(inbox.some((item) => item.key === openKey));
	const item = $derived.by(() => {
		if (view?.kind !== 'item') return undefined;
		const archive = Array.isArray(board.archive) ? board.archive : [];
		return [...inbox, ...archive].find((candidate) => candidate.key === openKey) ?? view.item;
	});
	const controllerId = $derived(view?.kind === 'controller' ? view.id : item?.controllerId);
	// Undefined for an archived report whose controller has left the roster.
	const controller = $derived(controllers.find((candidate) => candidate.id === controllerId));
	/** Whose content is open: shown in the fixed bar on a phone. */
	const owner = $derived(
		view?.kind === 'item' ? item : controller && { project: controller.project, hcomName: controller.hcomName }
	);

	let detail: HTMLElement;
	/** Where the phone's list was scrolled to before a content screen replaced it. */
	let listScroll = 0;

	async function show(next: View) {
		if (view === null) listScroll = window.scrollY;
		view = next;
		await tick();
		// New content starts at its top; going back returns to the same place in the list.
		detail.scrollTop = 0;
		window.scrollTo(0, next === null ? listScroll : 0);
	}
	const openItem = (next: InboxItem) => show({ kind: 'item', item: next });
	const openController = (id: string) => show({ kind: 'controller', id });

	const pending = $derived(inbox.filter((entry) => entry.kind === 'question' && entry.unsent).length);
	const unread = $derived(inbox.filter((entry) => entry.kind === 'report' && entry.readAt === null).length);
</script>

{#snippet refresh()}
	<button class="refresh" onclick={() => board.refresh()} disabled={board.refreshing} title="立即重新讀取所有資料">
		{board.refreshing ? '讀取中…' : '重新整理'}
	</button>
{/snippet}

<div class="page">
	{#if board.link === 'offline'}
		<p class="offline" role="status">連線中斷，正在重新連線…</p>
	{/if}

	{#if board.refreshFailed}
		<p class="problem" role="alert">重新整理失敗，請稍後再試。</p>
	{/if}
	{#each board.snapshot.errors as error (error)}
		<p class="problem" role="alert">⚠ {error}</p>
	{/each}

	<div class="shell" class:viewing={view !== null}>
		<nav class="roster">
			<header class="summary">
				<span><b>{pending}</b> 待決　<b>{unread}</b> 未讀　{controllers.length} 個主控</span>
				{@render refresh()}
			</header>
			<Roster {controllers} currentId={view?.kind === 'controller' ? view.id : null} onopen={openController} />
		</nav>

		<section class="inbox">
			<Inbox
				items={inbox}
				{controllers}
				{sort}
				{showArchive}
				archive={board.archive}
				{archivedCount}
				currentKey={openKey}
				onsort={setSort}
				onarchive={() => (showArchive = true)}
				onopen={openItem}
				oncontroller={openController}
			/>
		</section>

		<section class="detail" bind:this={detail}>
			{#if view === null}
				<p class="empty">從信箱選一則，或點主控名稱看它的資訊。</p>
			{:else}
				<div class="topbar">
					<button onclick={() => show(null)} aria-label="返回">←</button>
					{#if owner}
						<strong>{owner.project}</strong>
						<span class="handle">@{owner.hcomName}</span>
					{/if}
					{@render refresh()}
				</div>

				{#if view.kind === 'controller'}
					{#if controller}
						<ControllerInfo
							{controller}
							items={inbox.filter((entry) => entry.controllerId === controller.id)}
							onopen={openItem}
						/>
					{:else}
						<p class="empty">這個主控已經不在名冊上：它已結束，回報也都封存了。</p>
					{/if}
				{:else if item}
					<ItemContent {item} {inInbox} onread={(key) => board.markRead(key)} />
					{#if controller}
						<button class="context" onclick={() => openController(controller.id)}>
							{item.project} · @{item.hcomName}　看主控資訊 →
						</button>
						<!-- Mount point (ticket 111): the reply box for `controller` goes here, under the
						     item's content. It is not shown when the controller has left the roster. -->
					{:else}
						<p class="context">{item.project} · @{item.hcomName}（已不在名冊上）</p>
					{/if}
				{/if}
			{/if}
		</section>
	</div>

	<!-- Mount point (ticket 111): the command line of the wide layout goes here, after `.shell`.
	     `.page` is a full-height column above 760px, so an element here stays at the bottom. -->
</div>

<style>
	.offline {
		position: sticky;
		top: 0;
		z-index: 20;
		margin: 0;
		padding: 0.4rem 1rem;
		background: var(--danger);
		color: var(--bg);
		font-weight: 600;
		text-align: center;
	}
	.page {
		display: flex;
		flex-direction: column;
		height: 100dvh;
	}
	.shell {
		--roster-w: 272px;
		--inbox-w: 400px;
		flex: 1;
		display: grid;
		/* The vw caps keep the content column usable in a narrower window. */
		grid-template-columns: min(var(--roster-w), 30vw) min(var(--inbox-w), 42vw) 1fr;
		min-height: 0;
	}
	.roster,
	.inbox,
	.detail {
		min-width: 0;
		overflow-y: auto;
		padding: 1rem;
	}
	.roster,
	.inbox {
		border-right: 1px solid var(--line);
	}
	.inbox {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.summary {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.8rem;
		font-size: 0.8rem;
		color: var(--muted);
	}
	.summary b {
		font-family: var(--mono);
		font-size: 1rem;
		color: var(--text);
	}
	.refresh {
		margin-left: auto;
		padding: 0.15rem 0.6rem;
		font-size: 0.8rem;
		color: var(--text);
		white-space: nowrap;
	}
	.problem {
		margin: 0;
		padding: 0.4rem 1rem;
		border-bottom: 1px solid var(--line);
		font-size: 0.8rem;
		color: var(--danger);
		overflow-wrap: anywhere;
	}
	.detail {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 1.5rem;
	}
	.detail > :global(*) {
		flex: none;
		width: 100%;
		max-width: 46rem;
	}
	.empty {
		margin: 0;
		color: var(--muted);
	}
	.context {
		margin: 0;
		padding: 0;
		background: none;
		border: 0;
		font-size: 0.85rem;
		color: var(--muted);
		text-align: left;
		overflow-wrap: anywhere;
	}
	button.context {
		color: var(--accent);
	}
	button.context:hover {
		text-decoration: underline;
	}
	.topbar {
		display: none;
		position: sticky;
		top: 0;
		z-index: 5;
		align-items: center;
		gap: 0.7rem;
		margin: -1rem -1rem 0;
		padding: 0.6rem 1rem;
		background: var(--bg);
		border-bottom: 1px solid var(--line);
	}
	.topbar strong {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.handle {
		/* The project name gives way first, so the controller name stays readable. */
		flex: none;
		max-width: 45%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--mono);
		font-size: 0.8rem;
		color: var(--muted);
	}

	@media (max-width: 760px) {
		.page {
			display: block;
			height: auto;
		}
		.shell {
			display: block;
		}
		.roster,
		.inbox,
		.detail {
			overflow-y: visible;
		}
		.roster,
		.inbox {
			border-right: 0;
		}
		.roster {
			padding-bottom: 0;
		}
		.detail {
			display: none;
			padding: 1rem;
		}
		.viewing .roster,
		.viewing .inbox {
			display: none;
		}
		.viewing .detail {
			display: flex;
		}
		.topbar {
			display: flex;
			/* The bar spans the screen and keeps its natural width rules. */
			width: auto;
			max-width: none;
		}
	}
</style>
