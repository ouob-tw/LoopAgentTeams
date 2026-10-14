<script lang="ts">
	// Wide: roster, inbox and content side by side, the roster foldable into a rail and both
	// column borders draggable. Narrow: the roster strip above the inbox, and one content screen
	// at a time once something is opened.
	import { onMount, tick } from 'svelte';
	import type { InboxSort } from '#lib/board/inbox.ts';
	import { LiveBoard } from '#lib/board/live.svelte.ts';
	import { appearance } from '#lib/board/appearance.svelte.ts';
	import { remember, remembered, type Column } from '#lib/board/prefs.ts';
	import type { InboxItem } from '#lib/board/types.ts';
	import CommandLine from '#lib/components/CommandLine.svelte';
	import ControllerInfo from '#lib/components/ControllerInfo.svelte';
	import Inbox from '#lib/components/Inbox.svelte';
	import ItemContent from '#lib/components/ItemContent.svelte';
	import NewController from '#lib/components/NewController.svelte';
	import ReplyBox from '#lib/components/ReplyBox.svelte';
	import Roster from '#lib/components/Roster.svelte';
	import RosterRail from '#lib/components/RosterRail.svelte';
	import Settings from '#lib/components/Settings.svelte';

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

	onMount(() => appearance.restore());
	let settings: Settings;

	/** Drag a column's right border. Only a real move changes the width, so a double click is free to reset it. */
	function drag(event: PointerEvent, column: Column) {
		if (event.button !== 0) return;
		const handle = event.currentTarget as HTMLElement;
		const pane = handle.previousElementSibling as HTMLElement;
		const startX = event.clientX;
		const startWidth = pane.getBoundingClientRect().width;
		let asked: number | undefined;
		const move = (moved: PointerEvent) => {
			asked = appearance.showWidth(column, startWidth + moved.clientX - startX);
		};
		const end = () => {
			handle.removeEventListener('pointermove', move);
			if (asked === undefined) return;
			// A narrow window caps the column below its upper limit; remember what is shown, not
			// a width that would only appear once the window is wider.
			appearance.setWidth(column, Math.min(asked, Math.floor(pane.getBoundingClientRect().width)));
		};
		handle.setPointerCapture(event.pointerId);
		handle.addEventListener('pointermove', move);
		handle.addEventListener('lostpointercapture', end, { once: true });
	}

	function setSort(next: InboxSort) {
		sort = next;
		showArchive = false;
		remember(SORT_KEY, next);
	}

	// The item is kept as it was when opened, so the content stays up after it leaves the inbox.
	type View = { kind: 'item'; item: InboxItem } | { kind: 'controller'; id: string } | { kind: 'launch' } | null;
	let view = $state<View>(null);

	const controllers = $derived(board.snapshot.controllers);
	const inbox = $derived(board.snapshot.inbox);
	const archivedCount = $derived(board.snapshot.archivedCount);

	// The archive is fetched when its view is open, and again with every new snapshot: a report may
	// have moved into it, and a manual refresh retries a fetch that failed.
	$effect(() => {
		void board.snapshot;
		if (showArchive) void board.loadArchive();
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
		// On a phone the button that was just pressed is hidden now; keep the keyboard on screen.
		if (next !== null) detail.focus({ preventScroll: true });
		window.scrollTo(0, next === null ? listScroll : 0);
	}
	const openItem = (next: InboxItem) => show({ kind: 'item', item: next });
	const openController = (id: string) => show({ kind: 'controller', id });
	const openLaunch = () => show({ kind: 'launch' });

	const pending = $derived(inbox.filter((entry) => entry.kind === 'question' && entry.unsent).length);
	const unread = $derived(inbox.filter((entry) => entry.kind === 'report' && entry.readAt === null).length);
</script>

{#snippet refresh(short = false)}
	<button
		class="tool"
		onclick={() => board.refresh()}
		disabled={board.refreshing}
		aria-label={short ? '重新整理' : undefined}
		title="立即重新讀取所有資料"
	>
		{short ? '重整' : board.refreshing ? '讀取中…' : '重新整理'}
	</button>
{/snippet}

{#snippet newController(short = false)}
	<button
		class="tool"
		class:current={view?.kind === 'launch'}
		onclick={openLaunch}
		aria-label={short ? '新建主控' : undefined}
		title="選 client、資料夾與第一句話，在 Herdr 開一個新的主控"
	>
		{short ? '＋' : '＋ 新建'}
	</button>
{/snippet}

{#snippet openSettings()}
	<button class="tool" onclick={() => settings.open()} title="主題與整體大小">設定</button>
{/snippet}

{#snippet resize(column: Column)}
	<!-- Pointer only: the widths are a convenience, and every column stays usable at its default. -->
	<div
		class="resize"
		data-column={column}
		role="separator"
		aria-orientation="vertical"
		title="拖曳調整寬度，連按兩下還原"
		onpointerdown={(event) => drag(event, column)}
		ondblclick={() => appearance.resetWidth(column)}
	></div>
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
			<div class="folded">
				<RosterRail
					{controllers}
					currentId={view?.kind === 'controller' ? view.id : null}
					onopen={openController}
					onexpand={() => appearance.setFolded(false)}
				>
					{#snippet tools()}
						{@render newController(true)}
						{@render refresh(true)}
						{@render openSettings()}
					{/snippet}
				</RosterRail>
			</div>
			<div class="unfolded">
				<header class="summary">
					<span><b>{pending}</b> 待決　<b>{unread}</b> 未讀　{controllers.length} 個主控</span>
					<span class="tools">
						{@render newController()}
						{@render refresh()}
						{@render openSettings()}
						<button
							class="tool fold"
							onclick={() => appearance.setFolded(true)}
							aria-label="收起主控名冊"
							title="收起主控名冊">«</button
						>
					</span>
				</header>
				<Roster {controllers} currentId={view?.kind === 'controller' ? view.id : null} onopen={openController} />
			</div>
		</nav>
		{@render resize('roster')}

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
				onarchive={() => {
					showArchive = true;
					void board.loadArchive();
				}}
				onopen={openItem}
				oncontroller={openController}
			/>
		</section>
		{@render resize('inbox')}

		<section class="detail" bind:this={detail} tabindex="-1">
			{#if view === null}
				<p class="empty">從信箱選一則，或點主控名稱看它的資訊。</p>
			{:else}
				<div class="topbar">
					<button onclick={() => show(null)} aria-label="返回">←</button>
					{#if owner}
						<span class="whose" title="{owner.project} @{owner.hcomName}">
							<strong>{owner.project}</strong>
							<span class="handle">@{owner.hcomName}</span>
						</span>
					{/if}
					<span class="tools">
						{@render refresh()}
						{@render openSettings()}
					</span>
				</div>

				{#if view.kind === 'launch'}
					<NewController {controllers} stamp={board.snapshot.generatedAt} onopen={openController} />
				{:else if view.kind === 'controller'}
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
					{#key item.key}
						<ItemContent
							{item}
							{inInbox}
							recorded={board.snapshot.recordedKeys.includes(item.key)}
							onread={(key) => board.markRead(key)}
						/>
					{/key}
					{#if controller}
						<button class="context" onclick={() => openController(controller.id)}>
							{item.project} · @{item.hcomName}　看主控資訊 →
						</button>
						<ReplyBox {controller} />
					{:else}
						<p class="context">{item.project} · @{item.hcomName}（已不在名冊上）</p>
					{/if}
				{/if}
			{/if}
		</section>
	</div>

	<!-- `.page` is a full-height column above 760px, so the command line stays at the bottom. -->
	<CommandLine {controllers} target={controller} />
</div>

<Settings bind:this={settings} />

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
		/* `--roster-w` and `--inbox-w` are this device's dragged widths, set on the root element.
		   The vw caps keep the content column usable in a narrower window. */
		--col-roster: min(var(--roster-w, 272px), 30vw);
		--col-inbox: min(var(--inbox-w, 400px), 42vw);
		position: relative;
		flex: 1;
		display: grid;
		grid-template-columns: var(--col-roster) var(--col-inbox) 1fr;
		min-height: 0;
	}
	.folded {
		display: none;
	}
	/* The handles lie over the column borders, outside the columns' own scrolling. */
	.resize {
		position: absolute;
		top: 0;
		bottom: 0;
		left: var(--col-roster);
		z-index: 6;
		width: 9px;
		margin-left: -5px;
		cursor: col-resize;
		touch-action: none;
	}
	.resize[data-column='inbox'] {
		left: calc(var(--col-roster) + var(--col-inbox));
	}
	.resize:hover,
	.resize:active {
		background: var(--accent);
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
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: center;
		gap: 0.4rem 0.5rem;
		margin-bottom: 0.8rem;
		font-size: 0.8rem;
		color: var(--muted);
	}
	.summary b {
		font-family: var(--mono);
		font-size: 1rem;
		color: var(--text);
	}
	.tools {
		display: flex;
		flex: none;
		gap: 0.3rem;
		margin-left: auto;
	}
	.tool {
		padding: 0.15rem 0.6rem;
		font-size: 0.8rem;
		color: var(--text);
		white-space: nowrap;
	}
	.tool.current {
		background: var(--selected-bg);
		color: var(--selected-text);
	}
	.folded .tool {
		padding: 0.15rem 0.2rem;
		font-size: 0.7rem;
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
	.detail:focus {
		outline: none;
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
	/* Two lines like a roster tag, project on top, so both names keep the width the buttons leave. */
	.whose {
		display: flex;
		flex-direction: column;
		min-width: 0;
		line-height: 1.25;
	}
	.topbar strong {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.handle {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--mono);
		font-size: 0.8rem;
		color: var(--muted);
	}

	/* The folded roster exists only in the wide layout; a phone always shows the tag strip. */
	@media (min-width: 761px) {
		:global(:root[data-roster='folded']) .shell {
			--col-roster: 2.75rem;
		}
		:global(:root[data-roster='folded']) .roster {
			display: flex;
			padding: 0;
		}
		/* The rail fills the column, so a click anywhere below the marks still unfolds. */
		:global(:root[data-roster='folded']) .folded {
			display: flex;
			flex: 1;
		}
		:global(:root[data-roster='folded']) .unfolded,
		:global(:root[data-roster='folded']) .resize[data-column='roster'] {
			display: none;
		}
	}

	@media (max-width: 760px) {
		.page {
			display: block;
			height: auto;
		}
		.shell {
			display: block;
		}
		.resize,
		.fold {
			display: none;
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
