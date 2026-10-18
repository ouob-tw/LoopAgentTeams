<script lang="ts">
	// Wide: roster, inbox and content side by side, the roster foldable into a rail and both
	// column borders draggable. Narrow: the roster strip above the inbox, and one content screen
	// at a time once something is opened.
	import { onMount, tick, untrack } from 'svelte';
	import { afterNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import PanelLeftClose from '@lucide/svelte/icons/panel-left-close';
	import Plus from '@lucide/svelte/icons/plus';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import type { InboxSort } from '#lib/board/inbox.ts';
	import { LiveBoard } from '#lib/board/live.svelte.ts';
	import { advance, arrive, listScrollIn, placeIn, samePlace, searchOf, viewOf, withListScroll, type Place, type Trail, type View } from '#lib/board/navigation.ts';
	import { appearance } from '#lib/board/appearance.svelte.ts';
	import { remember, remembered, type Column } from '#lib/board/prefs.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';
	import { reportPlace, withLatest, type PlacedMessage, type TranscriptUpdate, type TranscriptView } from '#lib/board/transcript.ts';
	import type { InboxItem } from '#lib/board/types.ts';
	import CommandLine from '#lib/components/CommandLine.svelte';
	import ControllerInfo from '#lib/components/ControllerInfo.svelte';
	import Inbox from '#lib/components/Inbox.svelte';
	import ItemContent from '#lib/components/ItemContent.svelte';
	import NewController from '#lib/components/NewController.svelte';
	import Roster from '#lib/components/Roster.svelte';
	import RosterRail from '#lib/components/RosterRail.svelte';
	import Settings from '#lib/components/Settings.svelte';
	import Toasts from '#lib/components/Toasts.svelte';

	let { data } = $props();

	// svelte-ignore state_referenced_locally
	const board = new LiveBoard(data.snapshot);
	onMount(() => {
		const close = board.connect();
		// A reload of the page also re-reads every source, like the refresh button.
		void board.refresh();
		return close;
	});

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

	const controllers = $derived(board.snapshot.controllers);
	const inbox = $derived(board.snapshot.inbox);
	const archivedCount = $derived(board.snapshot.archivedCount);

	/** Items as they were when opened on this page, so going back shows one that has left the inbox since. */
	const kept = new Map<string, InboxItem>();
	const archived = $derived(typeof board.archive === 'object' ? (board.archive?.reports ?? []) : []);
	const viewAt = (place: Place) => viewOf(place, { kept, items: [...inbox, ...archived], controllers });
	/** The screen the address names; a reload opens it again. */
	const addressed = () => placeIn(new URLSearchParams(location.search));
	/** The browser starts from the real address: under shallow routing page.url stays at the last full
	 *  load, so a remount (HMR) would otherwise open a stale screen. The server has only page.url. */
	// svelte-ignore state_referenced_locally
	let view = $state<View>(viewAt(typeof location !== 'undefined' ? addressed() : placeIn(page.url.searchParams)));

	// The archive is fetched when its view is open, and again with every new snapshot: a report may
	// have moved into it. A fetch that failed is retried only with its button.
	$effect(() => {
		void board.snapshot;
		if (showArchive && untrack(() => board.archive) !== 'failed') void board.loadArchive();
	});

	const openKey = $derived(view?.kind === 'item' ? view.item.key : null);
	const inInbox = $derived(inbox.some((item) => item.key === openKey));
	const item = $derived.by(() => {
		if (view?.kind !== 'item') return undefined;
		return [...inbox, ...archived].find((candidate) => candidate.key === openKey) ?? view.item;
	});
	const controllerId = $derived(view?.kind === 'controller' ? view.id : item?.controllerId);

	/** Where an opened item is shown in its controller's conversation: a report is its own message,
	 *  a question is shown at the message that asked it. Null when there is no such message. */
	const placedAt = (entry: InboxItem): PlacedMessage | null =>
		entry.kind === 'report' ? entry : entry.askedIn && { key: entry.key, ...entry.askedIn, exact: true };
	/** The question whose asking message is not found in its conversation, or the conversation
	 *  cannot be read, at this opening: it is shown as if no message had asked it. */
	let lost = $state<string | null>(null);
	const placed = $derived(item && item.key !== lost ? placedAt(item) : null);
	function lose(key: string) {
		lost = key;
		locate(false);
	}
	/** The controller of the lost question while it is open. */
	const lostIn = $derived(lost && item?.key === lost ? item.controllerId : null);
	// Lost is not for good: a turn's text may reach the conversation a moment after its report,
	// so its later pages are still watched, and the question is shown at its asking message once
	// one has it.
	$effect(() => {
		const key = lost;
		if (!key || !lostIn) return;
		let seen: TranscriptView | null = null;
		const source = new EventSource(`/api/transcript/events?controller=${encodeURIComponent(lostIn)}`);
		source.addEventListener('transcript', (event) => {
			const update: TranscriptUpdate = JSON.parse((event as MessageEvent).data);
			if (!update.ok) return;
			seen = withLatest(seen, update.page);
			const target = item?.key === key ? placedAt(item) : null;
			if (target && typeof reportPlace(seen, target) === 'number') lost = null;
		});
		return () => source.close();
	});

	/** Containers of the unfolded roster whose own surface, not a card or control, was clicked. */
	const ROSTER_BLANK = '.roster, .unfolded, .summary, .counts, .people, .sep, .summary .tools';

	/** A click on the blank of the unfolded roster folds it; cards, controls and a click ending a text selection do not. */
	function foldOnBlank(event: MouseEvent) {
		if (!window.matchMedia('(min-width: 761px)').matches) return;
		if (document.documentElement.dataset.roster === 'folded') return;
		if ((event.target as Element).closest('.folded')) return;
		if (!(event.target as Element).matches(ROSTER_BLANK)) return;
		if (window.getSelection()?.toString()) return;
		appearance.setFolded(true);
	}

	// Undefined for an archived report whose controller has left the roster.
	const controller = $derived(controllers.find((candidate) => candidate.id === controllerId));
	/** Whose content is open: shown in the fixed bar on a phone. */
	const owner = $derived(
		view?.kind === 'item' ? item : controller && { project: controller.project, hcomName: controller.hcomName }
	);

	let detail: HTMLElement;
	/** The command line's height, kept clear at the end of a phone's page. */
	let dockHeight = $state(0);
	/** How far the on-screen keyboard reaches over the page; the phone's command line sits above it. */
	let keyboard = $state(0);
	onMount(() => {
		const viewport = window.visualViewport;
		if (!viewport) return;
		const place = () => (keyboard = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop)));
		viewport.addEventListener('resize', place);
		viewport.addEventListener('scroll', place);
		place();
		return () => {
			viewport.removeEventListener('resize', place);
			viewport.removeEventListener('scroll', place);
		};
	});
	/** Where the phone's list was scrolled to before a content screen replaced it. */
	let listScroll = 0;

	/** Set while an opened report, or a question's asking message, is being found in its
	 *  conversation: a copy of its card covers the content where it will be, so the page never
	 *  shows its top first. */
	let locating = $state(false);
	/** The box showing that copy. */
	let copy = $state<HTMLElement | null>(null);
	let locateTimer: ReturnType<typeof setTimeout> | undefined;
	function locate(on: boolean) {
		clearTimeout(locateTimer);
		locating = on;
		// Taken away after a while anyway, so it can never stay.
		if (on) locateTimer = setTimeout(() => locate(false), 8_000);
	}

	/** History writes and the screens shown after them, one after another: each reads the entry the
	 *  one before has left. One that fails does not stop the ones after it. */
	let moving: Promise<unknown> = Promise.resolve();
	function queue(step: () => unknown) {
		moving = moving.then(step).catch((error) => console.error(error));
	}
	function move(step: (trail: Trail, depth: number | undefined) => void) {
		queue(async () => {
			const writes: (() => Promise<void>)[] = [];
			const write = (replace: boolean) => (place: Place, depth: number) =>
				void writes.push(() =>
					goto(`${location.pathname}${searchOf(place)}`, { shallow: true, replace, state: { depth }, persistState: true })
				);
			step({ push: write(false), replace: write(true) }, page.state.depth);
			for (const next of writes) await next();
		});
	}
	afterNavigate(({ type }) => {
		if (type !== 'enter') return;
		move((trail, depth) => arrive(addressed(), depth, trail));
		// After the first writes, which may put the list in front of the address for a moment.
		if (view?.kind === 'missing') queue(() => void restore(addressed()));
	});
	/** Set while the archive is read for an item the address names, so it is not called missing
	 *  before then; the first render is such a case too. */
	// svelte-ignore state_referenced_locally
	let seeking = $state(view?.kind === 'missing' && view.what === 'item');
	/** The screen of an address arrived at by going back or forward, or by a reload. A report not in
	 *  the inbox may be in the archive, which is read first, page after page until it is found or
	 *  the archive ends. */
	let restores = 0;
	async function restore(place: Place) {
		// Only the latest restore shows its screen, and ends the seeking.
		const own = ++restores;
		if (viewAt(place)?.kind === 'missing' && place?.kind === 'item' && (board.archive === null || board.earlierFrom)) {
			seeking = true;
			if (board.archive === null) await board.loadArchive();
			// Each round must get further back; one that fails or does not stops. A page the archive
			// view is already reading counts as a round.
			let from = board.earlierFrom;
			while (own === restores && viewAt(place)?.kind === 'missing' && from) {
				await board.loadEarlier();
				if (board.archiveEarlier === 'failed' || board.earlierFrom === from) break;
				from = board.earlierFrom;
			}
			if (own !== restores) return;
			seeking = false;
			if (!samePlace(place, addressed())) return;
		}
		seeking = false;
		await present(viewAt(place));
	}
	onMount(() => {
		const popped = (event: PopStateEvent) => {
			listScroll = listScrollIn(event.state) ?? listScroll;
			void restore(addressed());
		};
		addEventListener('popstate', popped);
		return () => removeEventListener('popstate', popped);
	});
	/** Open a screen from the one shown, one history entry further. It is shown once the address
	 *  names it, so a back pressed meanwhile can never leave the two apart. */
	function go(next: Place) {
		move((trail, depth) => {
			const here = addressed();
			if (here === null) history.replaceState(withListScroll(history.state, window.scrollY), '');
			advance(next, { place: here, depth: depth ?? 0 }, trail);
		});
		queue(() => present(viewAt(next)));
	}
	/** The top bar's "←": every screen but the list has a board entry behind it. */
	const back = () => queue(() => history.back());

	async function show(next: View) {
		if (next?.kind !== 'item') locate(false);
		if (view === null) listScroll = window.scrollY;
		view = next;
		await tick();
		// New content starts at its top; going back returns to the same place in the list.
		detail.scrollTop = 0;
		// On a phone the button that was just pressed is hidden now; keep the keyboard on screen.
		if (next !== null) detail.focus({ preventScroll: true });
		window.scrollTo(0, next === null ? listScroll : 0);
	}
	/** Counts openings, so opening the open report again, or going back to it, scrolls back to it. */
	let opens = $state(0);
	function present(next: View) {
		if (next?.kind === 'item') {
			opens++;
			lost = null;
			locate(!!placedAt(next.item) && controllers.some((candidate) => candidate.id === next.item.controllerId));
		}
		return show(next);
	}
	function openItem(next: InboxItem) {
		kept.set(next.key, next);
		go({ kind: 'item', key: next.key });
		// Opening an inbox report reads it. Only opening does: a report marked unread stays unread
		// while it is still open. An archived report keeps the read state it had.
		const listed = inbox.find((entry) => entry.key === next.key);
		if (listed?.kind === 'report' && listed.readAt === null) {
			board.mark(listed.key, true).catch(() => toasts.show('failed', '沒有標為已讀，請重新點開再試一次。'));
		}
	}
	const openController = (id: string) => go({ kind: 'controller', id });
	/** The phone's top-bar title: from an item it opens the controller's page; on that page it only
	 *  scrolls back to the top, so there is no new history entry. */
	function tapTitle() {
		if (!controller) return;
		if (view?.kind !== 'controller') return openController(controller.id);
		detail.scrollTop = 0;
		window.scrollTo(0, 0);
	}
	const openLaunch = () => go({ kind: 'launch' });

	const pending = $derived(inbox.filter((entry) => entry.kind === 'question' && entry.unsent).length);
	const unread = $derived(inbox.filter((entry) => entry.kind === 'report' && entry.readAt === null).length);
</script>

{#snippet names(owner: { project: string; hcomName: string })}
	<strong>{owner.project}</strong>
	<span class="handle">@{owner.hcomName}</span>
{/snippet}

{#snippet placedCard(item: InboxItem, copy = false)}
	<ItemContent
		{item}
		{inInbox}
		recorded={board.snapshot.recordedKeys.includes(item.key)}
		handle={item.hcomName}
		onunread={copy ? async () => {} : (key) => board.mark(key, false)}
	/>
{/snippet}

{#snippet refresh()}
	<button
		class="tool icon"
		class:spinning={board.refreshing}
		onclick={() => board.refresh()}
		disabled={board.refreshing}
		aria-label={board.refreshing ? '讀取中' : '重新整理'}
		title="立即重新讀取所有資料"
	>
		<RefreshCw size="1.1em" />
	</button>
{/snippet}

{#snippet newController(short = false)}
	<button
		class="tool"
		class:icon={short}
		class:current={view?.kind === 'launch'}
		onclick={openLaunch}
		aria-label={short ? '新建主控' : undefined}
		title="選 client、資料夾與第一句話，在 Herdr 開一個新的主控"
	>
		<Plus size="1.1em" />{short ? '' : '新建'}
	</button>
{/snippet}

{#snippet openSettings()}
	<button class="tool icon" onclick={() => settings.open()} aria-label="設定" title="設定：主題、整體大小與最小字體">
		<SettingsIcon size="1.1em" />
	</button>
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

<div class="page" style:--dock-h="{dockHeight}px">
	<div class="shell" class:viewing={view !== null}>
		<!-- Folding is for pointers: the fold control is the keyboard's way; a click on the blank of the roster does the same. -->
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
		<nav class="roster" onclick={foldOnBlank}>
			<div class="folded">
				<RosterRail
					{controllers}
					currentId={view?.kind === 'controller' ? view.id : null}
					onopen={openController}
					onexpand={() => appearance.setFolded(false)}
				>
					{#snippet tools()}
						{@render newController(true)}
						{@render refresh()}
						{@render openSettings()}
					{/snippet}
				</RosterRail>
			</div>
			<div class="unfolded">
				<header class="summary">
					<span class="counts">
						<button
							class="tool icon fold"
							onclick={() => appearance.setFolded(true)}
							aria-label="收起主控名冊"
							title="收起主控名冊"
						>
							<PanelLeftClose size="1.1em" />
						</button>
						<span class="stats">
							<span class="stat"><b>{pending}</b> 待決</span>
							<span class="stat"><b>{unread}</b> 未讀</span>
						</span>
					</span>
					<span class="tools">
						{@render newController()}
						{@render refresh()}
						{@render openSettings()}
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
				earlier={board.archiveEarlier}
				onearlier={() => void board.loadEarlier()}
				onretry={() => void board.loadArchive()}
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
					<button onclick={back} aria-label="返回">←</button>
					{#if owner}
						<!-- Tappable while the controller is on the roster; an archived item of one that left is not. -->
						{#if controller}
							<button class="whose" title="{owner.project} @{owner.hcomName}" onclick={tapTitle}>
								{@render names(owner)}
							</button>
						{:else}
							<span class="whose" title="{owner.project} @{owner.hcomName}">
								{@render names(owner)}
							</span>
						{/if}
					{/if}
					<span class="tools">
						{@render refresh()}
						{@render openSettings()}
					</span>
				</div>

				{#if view.kind === 'missing'}
					{#if view.what === 'controller'}
						<p class="empty">這個主控已不存在。</p>
					{:else if board.archive === 'failed' || (board.archiveEarlier === 'failed' && board.earlierFrom)}
						<p class="empty">信箱裡沒有這一則，封存也讀不出來；可以重新整理再試一次。</p>
					{:else if !seeking}
						<p class="empty">這一則已不存在。</p>
					{/if}
				{:else if view.kind === 'launch'}
					<NewController {controllers} stamp={board.snapshot.generatedAt} onopen={openController} />
				{:else if view.kind === 'controller'}
					{#if controller}
						<ControllerInfo
							tabMoves={board.tabMoves}
							{controller}
							items={inbox.filter((entry) => entry.controllerId === controller.id)}
							onopen={openItem}
						/>
					{:else}
						<p class="empty">這個主控已經不在名冊上：它已結束，回報也都封存了。</p>
					{/if}
				{:else if item && placed && controller}
					<!-- A report is the controller's last text of its turn, and a question was asked in
					     one: shown in its conversation. -->
					<ControllerInfo
						tabMoves={board.tabMoves}
						{controller}
						items={inbox.filter((entry) => entry.controllerId === controller.id)}
						onopen={openItem}
						target={placed}
						{opens}
						{copy}
						onplaced={() => locate(false)}
						onunplaced={item.kind === 'question' ? () => lose(item.key) : undefined}
					>
						{#snippet card()}
							{#key item.key}
								{@render placedCard(item)}
							{/key}
						{/snippet}
					</ControllerInfo>
				{:else if item}
					{#if item.kind === 'question' && (!item.askedIn || item.key === lost)}
						<p class="empty">找不到提出這題的原訊息。</p>
					{/if}
					{#key item.key}
						<ItemContent
							{item}
							{inInbox}
							recorded={board.snapshot.recordedKeys.includes(item.key)}
							onunread={(key) => board.mark(key, false)}
						/>
					{/key}
					{#if controller}
						<button class="context" onclick={() => openController(controller.id)}>
							{item.project} · @{item.hcomName}　看主控資訊 →
						</button>
					{:else}
						<p class="context">{item.project} · @{item.hcomName}（已不在名冊上）</p>
					{/if}
				{/if}
			{/if}
		</section>
		{#if locating && item}
			<!-- Where the report's card will be once its conversation is scrolled to it. It scrolls
			     to be read meanwhile, and the card is placed where it is read. -->
			<div class="placeholder" aria-hidden="true" bind:this={copy}>
				<div inert>{@render placedCard(item, true)}</div>
			</div>
		{/if}

		<!-- Above 760px the command line is the grid's bottom row under the inbox and the content, the
		     roster running the full height beside it; on a phone it is fixed to the bottom, above the
		     on-screen keyboard. The notices float just above it, however tall its box has grown. -->
		<div class="dock" bind:clientHeight={dockHeight} style:--keyboard="{keyboard}px">
			<Toasts
				standing={[
					...(board.link === 'offline' ? [{ kind: 'failed' as const, text: '連線中斷，正在重新連線…' }] : []),
					...board.snapshot.errors.map((error) => ({ kind: 'failed' as const, text: `⚠ ${error}` }))
				]}
			/>
			<CommandLine {controllers} target={controller} />
		</div>
	</div>
</div>

<Settings bind:this={settings} />

<style>
	.dock {
		position: relative;
		grid-area: 2 / 2 / 3 / 4;
		min-width: 0;
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
		grid-template-rows: minmax(0, 1fr) auto;
		min-height: 0;
	}
	.roster {
		grid-area: 1 / 1 / 3 / 2;
	}
	.inbox {
		grid-area: 1 / 2;
	}
	.detail {
		grid-area: 1 / 3;
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
	/* The roster's border runs the full height; the inbox's stops at the command line. */
	.resize[data-column='inbox'] {
		bottom: var(--dock-h, 0px);
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
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	/* The fold control leads the first line, before the counts; the tools take the second. */
	.counts {
		display: flex;
		align-items: center;
		gap: 0.9rem;
	}
	.summary .tools {
		flex-basis: 100%;
		justify-content: flex-start;
	}
	/* Each number stays with its word: a narrow column wraps between the pairs, never inside one. */
	.stats {
		display: flex;
		flex-wrap: wrap;
		gap: 0 0.8rem;
	}
	.stat {
		white-space: nowrap;
	}
	.summary b {
		font-family: var(--mono);
		font-size: max(1rem, var(--min-font, 0px));
		color: var(--text);
	}
	.tools {
		display: flex;
		flex: none;
		gap: 0.3rem;
		margin-left: auto;
	}
	/* Every tool of the roster and the top bar: as tall as it is wide when it is only an icon, and
	   that tall with words too, sized from the smallest text size so they grow together. */
	.tool {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.3em;
		box-sizing: border-box;
		height: 2em;
		min-width: 2em;
		padding: 0 0.55em;
		font-size: max(0.8rem, var(--min-font, 0px));
		line-height: 1;
		color: var(--text);
		white-space: nowrap;
	}
	.tool.current {
		background: var(--selected-bg);
		color: var(--selected-text);
	}
	.tool.icon {
		width: 2em;
		padding: 0;
	}
	.spinning :global(svg) {
		animation: spin 1s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.spinning :global(svg) {
			animation: none;
		}
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
	/* Over the content column only, laid out like it: the card sits where the transcript's
	   scroll puts the real one, a scroll margin below the column's top. A scrollbar gutter like
	   the column's keeps the card as wide. */
	.placeholder {
		/* Out of the grid's flow, which would otherwise move the columns. */
		position: absolute;
		top: 0;
		right: 0;
		/* The measured height is whole pixels; the extra one keeps clear of the line's top border. */
		bottom: calc(var(--dock-h, 0px) + 1px);
		left: calc(var(--col-roster) + var(--col-inbox));
		z-index: 4;
		min-width: 0;
		overflow-y: scroll;
		/* Scrolling it to its end does not scroll the page under it. */
		overscroll-behavior: contain;
		padding: 1rem 0.9rem;
		background: var(--bg);
	}
	/* Scrolled through, never clicked: the copy's buttons do nothing. */
	.placeholder > div {
		max-width: 46rem;
		pointer-events: none;
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
	@media (min-width: 761px) {
		/* Tighter gaps between the three columns. */
		.roster,
		.inbox {
			padding: 0.6rem;
		}
		.detail {
			padding: 0.9rem;
		}
	}
	.context {
		margin: 0;
		padding: 0;
		background: none;
		border: 0;
		font-size: max(0.85rem, var(--min-font, 0px));
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
	button.whose {
		align-items: flex-start;
		padding: 0;
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
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
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}

	/* The folded roster exists only in the wide layout; a phone always shows the tag strip. */
	@media (min-width: 761px) {
		:global(:root[data-roster='folded']) .shell {
			--col-roster: 2.75rem;
		}
		/* A vertical scrollbar narrows the rail; it never scrolls sideways. */
		:global(:root[data-roster='folded']) .roster {
			overflow-x: hidden;
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
		/* The blank of the unfolded roster folds it; what sits on it keeps its own cursor. */
		:global(:root:not([data-roster='folded'])) .roster {
			cursor: var(--cursor-collapse);
		}
		.stats,
		.roster :global(.none),
		.roster :global([role='dialog']) {
			cursor: default;
		}
	}

	@media (max-width: 760px) {
		.page {
			display: block;
			height: auto;
			/* The end of every screen stays clear of the fixed command line. */
			padding-bottom: var(--dock-h, 0px);
		}
		.dock {
			position: fixed;
			right: 0;
			bottom: var(--keyboard, 0px);
			left: 0;
			z-index: 30;
			/* Only what it shows takes touches: the floating button's row lets the page through. */
			pointer-events: none;
		}
		.shell {
			display: block;
		}
		/* A phone has no folded roster, so nothing for the fold control to switch. `.tool.fold`
		   outweighs `.tool.icon`, which would otherwise show it again. */
		.resize,
		.tool.fold {
			display: none;
		}
		.counts {
			gap: 0;
		}
		/* The counts and the tools share one line while it is wide enough, then the tools wrap. */
		.summary .tools {
			flex-basis: auto;
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
		/* Cards sit 3px from the screen edges; plain text keeps the cards' own inner indent. */
		.roster,
		.inbox {
			padding-left: 3px;
			padding-right: 3px;
		}
		.summary,
		.inbox > :global(:not(.row, .nest)),
		.detail > :global(:not(article, .topbar)) {
			padding-left: 0.6rem;
			padding-right: 0.6rem;
		}
		/* Cards inside those sections (question bars, report rows, history and sent-log entries)
		   take the indent back, so they too sit 3px from the edges. */
		.detail > :global(.questions) > :global(.question),
		.detail > :global(.tabpanel) > :global(.row),
		.detail > :global(.tabpanel) > :global(section) > :global(ol) > :global(li:not(.tools)) {
			margin-left: -0.6rem;
			margin-right: -0.6rem;
		}
		.detail {
			display: none;
			padding: 1rem 3px;
		}
		.viewing .roster,
		.viewing .inbox {
			display: none;
		}
		.viewing .detail {
			display: flex;
		}
		/* Below the bar, which stays on top. */
		.placeholder {
			position: fixed;
			inset: 0;
			overflow-y: auto;
			/* Its end clear of the command line, like the page's. */
			padding: 5rem 3px var(--dock-h, 0px);
		}
		.topbar {
			display: flex;
			margin: -1rem -3px 0;
			/* The bar spans the screen and keeps its natural width rules. */
			width: auto;
			max-width: none;
		}
	}
</style>
