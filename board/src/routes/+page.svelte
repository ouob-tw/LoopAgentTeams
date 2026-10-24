<script lang="ts">
	// Wide: roster, inbox and content side by side, the roster foldable into a rail and both
	// column borders draggable. Narrow: the roster strip above the inbox, and one content screen
	// at a time once something is opened.
	import { onMount, untrack } from 'svelte';
	import { afterNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import PanelLeftClose from '@lucide/svelte/icons/panel-left-close';
	import Plus from '@lucide/svelte/icons/plus';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import type { InboxSort } from '#lib/board/inbox.ts';
	import { clock } from '#lib/board/clock.svelte.ts';
	import { LiveBoard } from '#lib/board/live.svelte.ts';
	import { placeIn, tabIn, viewOf, type Place } from '#lib/board/navigation.ts';
	import { Navigation } from '#lib/board/navigation.svelte.ts';
	import { appearance } from '#lib/board/appearance.svelte.ts';
	import { voice } from '#lib/board/voice.svelte.ts';
	import { folderName, workspaceFolders } from '#lib/board/agents.ts';
	import { remember, remembered, type Column } from '#lib/board/prefs.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';
	import { everyController, type InboxItem, type KnownAgent } from '#lib/board/types.ts';
	import AgentInfo from '#lib/components/AgentInfo.svelte';
	import AgentList from '#lib/components/AgentList.svelte';
	import { askRows, type AskRow } from '#lib/board/ask-inbox.ts';
	import BoardAskCard from '#lib/components/BoardAskCard.svelte';
	import ClosedAgentInfo from '#lib/components/ClosedAgentInfo.svelte';
	import ClosedAgents from '#lib/components/ClosedAgents.svelte';
	import CommandLine from '#lib/components/CommandLine.svelte';
	import ControllerPage from '#lib/components/ControllerPage.svelte';
	import Inbox from '#lib/components/Inbox.svelte';
	import ItemContent from '#lib/components/ItemContent.svelte';
	import NewController from '#lib/components/NewController.svelte';
	import QuotaList from '#lib/components/QuotaList.svelte';
	import Roster from '#lib/components/Roster.svelte';
	import RosterRail from '#lib/components/RosterRail.svelte';
	import Settings from '#lib/components/Settings.svelte';
	import Toasts from '#lib/components/Toasts.svelte';

	let { data } = $props();

	// svelte-ignore state_referenced_locally
	const board = new LiveBoard(data.snapshot);
	// The notice times read the board's calendar day.
	$effect.pre(() => {
		clock.timeZone = board.snapshot.closed.timeZone;
	});
	onMount(() => clock.run());
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
	onMount(() => voice.restore());
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
	const agents = $derived(board.snapshot.agents);
	/** The board asks as inbox rows: those not ended are in the inbox, the ended ones among the processed. */
	const askList = $derived(askRows(board.snapshot.asks, agents));
	const openAsks = $derived(askList.filter((row) => row.open));
	const endedAsks = $derived(askList.filter((row) => !row.open));
	const processedCount = $derived(board.snapshot.processedCount + endedAsks.length);
	const workspaces = $derived(board.snapshot.workspaces);
	const closed = $derived(board.snapshot.closed);
	/** The report opened from the inbox list: it stays there, read, until another screen is shown. */
	let lingering = $state<string | null>(null);
	/** What the inbox lists: the questions and the unread reports, and the report still open. */
	const listedInbox = $derived(inbox.filter((entry) => entry.kind === 'question' || entry.readAt === null || entry.key === lingering));

	/** Items as they were when opened on this page, so going back shows one that has left the inbox since. */
	const kept = new Map<string, InboxItem>();
	/** The processed items loaded, without a report marked unread since: it is back in the inbox. */
	const processed = $derived(
		typeof board.archive === 'object'
			? (board.archive?.items ?? []).filter((entry) => !inbox.some((listed) => listed.key === entry.key && listed.kind === 'report' && listed.readAt === null))
			: []
	);
	/** The answered questions of the controller whose conversation is shown. */
	const answered = $derived(board.answered.questions);
	const known = $derived([...inbox, ...processed, ...answered]);
	const viewAt = (place: Place) => viewOf(place, { kept, items: known, controllers, agents, closed: closed.agents, asks: board.snapshot.asks, workspaces });

	let detail: HTMLElement;
	/** The screen shown and the browser's history. The middle column's list is in the address too,
	 *  so the server draws the right one at first. The browser starts from the real address: under
	 *  shallow routing page.url stays at the last full load, so a remount (HMR) would otherwise
	 *  open a stale screen. The server has only page.url. */
	const navigation = new Navigation(
		{
			browser: {
				search: () => location.search,
				pathname: () => location.pathname,
				state: () => history.state,
				depth: () => page.state.depth,
				replaceState: (state, url) => history.replaceState(state, '', url),
				back: () => history.back(),
				write: (url, replace, depth) => goto(url, { shallow: true, replace, state: { depth }, persistState: true }),
				scrollY: () => window.scrollY
			},
			viewAt,
			archive: board,
			showing(next) {
				if (next?.kind === 'item') {
					lost = null;
					locate(controllers.some((candidate) => candidate.id === next.item.controllerId));
				} else locate(false);
				// A read report leaves the inbox list once another screen replaces it, not while it is open.
				lingering = next?.kind === 'item' && listedInbox.some((entry) => entry.key === next.item.key) ? next.item.key : null;
			},
			shown(next, scrollY) {
				detail.scrollTop = 0;
				// On a phone the button that was just pressed is hidden now; keep the keyboard on screen.
				if (next !== null) detail.focus({ preventScroll: true });
				window.scrollTo(0, scrollY);
			}
		},
		{
			view: viewAt(typeof location !== 'undefined' ? placeIn(new URLSearchParams(location.search)) : placeIn(page.url.searchParams)),
			middle: tabIn(page.url.searchParams) ?? 'inbox'
		}
	);
	onMount(() => navigation.restoreMiddle());
	afterNavigate(({ type }) => {
		if (type === 'enter') navigation.enter();
	});
	onMount(() => {
		const popped = (event: PopStateEvent) => navigation.popped(event.state);
		addEventListener('popstate', popped);
		return () => removeEventListener('popstate', popped);
	});
	const view = $derived(navigation.view);
	const middle = $derived(navigation.middle);

	// The archive is fetched when its view is open, and again with every new snapshot: a report may
	// have moved into it. A fetch that failed is retried only with its button.
	$effect(() => {
		void board.snapshot;
		if (showArchive && untrack(() => board.archive) !== 'failed') void board.loadArchive();
	});

	const openKey = $derived(view?.kind === 'item' ? view.item.key : null);
	const listed = $derived(known.some((item) => item.key === openKey));
	const item = $derived.by(() => {
		if (view?.kind !== 'item') return undefined;
		return known.find((candidate) => candidate.key === openKey) ?? view.item;
	});
	const controllerId = $derived(view?.kind === 'controller' ? view.id : item?.controllerId);
	/** The open agent of the Herdr 分頁; undefined once Herdr no longer lists it. */
	const agentId = $derived(view?.kind === 'agent' ? view.id : null);
	const agent = $derived(agentId === null ? undefined : agents.find((candidate): candidate is KnownAgent => candidate.id === agentId));
	/** The open agent's board asks, oldest first: still shown once it left Herdr's list, so a timed-out
	 *  one can be answered there and read Agent 已不在 after. */
	const agentAsks = $derived(agentId === null ? [] : board.snapshot.asks.filter((ask) => ask.sessionId === agentId));
	/** The open agent while the 已關閉 section lists it instead: once 接回 brings it back to Herdr,
	 *  its page is the agent's again. */
	const closedAgent = $derived(agentId === null || agent ? undefined : closed.agents.find((candidate) => candidate.id === agentId));
	/** The controllers of the Herdr tab and the command line: the roster's, and the bound ones off it. */
	const herdrControllers = $derived(everyController(board.snapshot));
	/** The open agent as the controller it is, while Herdr lists it: its page is the controller's. */
	const agentController = $derived(agent?.controller && agent.inHerdr ? herdrControllers.find((candidate) => candidate.id === agent.id) : undefined);
	/** The workspace whose new-agent form is open; null when none is. */
	const newIn = $derived(view?.kind === 'new-agent' ? view.workspace : null);
	/** That form's workspace, with the folders its agents work in; undefined once Herdr no longer lists it. */
	const newTarget = $derived.by(() => {
		const workspace = workspaces.find((candidate) => candidate.id === newIn);
		if (!workspace) return undefined;
		const own = agents.filter((candidate) => candidate.inHerdr && candidate.herdr.workspace === workspace.id);
		return { workspace: workspace.id, label: workspace.label, folders: workspaceFolders(own) };
	});
	// A new object or unrelated activity must not reload the answered history.
	const answeredKey = $derived.by(() => {
		const id = controllerId ?? agentController?.id;
		return JSON.stringify([id, board.snapshot.inbox.filter((item) => item.kind === 'question' && item.controllerId === id)
			.map((item) => item.kind === 'question' ? [item.question.id, item.question.revision, item.question.status] : [])]);
	});
	$effect(() => {
		const [id] = JSON.parse(answeredKey);
		if (id) untrack(() => void board.loadAnswered(id));
	});

	/** The question whose asking message is not found in its conversation, or the conversation
	 *  cannot be read, at this opening: it is shown as if no message had asked it. */
	let lost = $state<string | null>(null);

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
	/** The agent Herdr runs the open controller's session in, for every page that shows the controller. */
	const controllerAgent = $derived(
		controllerId === undefined ? undefined : agents.find((candidate): candidate is KnownAgent => candidate.inHerdr && candidate.id === controllerId)
	);
	/** Whose content is open: shown in the fixed bar on a phone. */
	const owner = $derived(
		view?.kind === 'item' ? item : controller && { project: controller.project, hcomName: controller.hcomName }
	);

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

	function openItem(next: InboxItem) {
		kept.set(next.key, next);
		// Kept on the list from now: the read state may reach the page before the item is shown.
		if (listedInbox.some((entry) => entry.key === next.key)) lingering = next.key;
		navigation.go({ kind: 'item', key: next.key });
		// Opening an inbox report reads it. Only opening does: a report marked unread stays unread
		// while it is still open. An archived report keeps the read state it had.
		const listed = inbox.find((entry) => entry.key === next.key);
		if (listed?.kind === 'report' && listed.readAt === null) {
			board.mark(listed.key, true).catch(() => toasts.show('failed', '沒有標為已讀，請重新點開再試一次。'));
		}
	}
	/** The ask whose card the screen being opened scrolls to, once the card is there. */
	let askToShow = $state<string | null>(null);
	/** A permission ask of a controller opens the controller's page; every other ask opens its agent's. */
	function openAsk(row: AskRow) {
		const owner = row.ask.kind === 'permission' ? controllers.find((entry) => entry.id === row.ask.sessionId) : undefined;
		askToShow = row.ask.id;
		navigation.go(owner ? { kind: 'controller', id: owner.id } : { kind: 'agent', id: row.ask.sessionId });
	}
	$effect(() => {
		if (askToShow === null) return;
		if (view?.kind !== 'agent' && view?.kind !== 'controller') return;
		void board.snapshot.asks;
		const card = detail?.querySelector(`[data-ask="${CSS.escape(askToShow)}"]`);
		if (!card) return;
		card.scrollIntoView({ block: 'center' });
		askToShow = null;
	});
	const openController = (id: string) => navigation.go({ kind: 'controller', id });
	/** The phone's top-bar title: from an item it opens the controller's page; on that page it only
	 *  scrolls back to the top, so there is no new history entry. */
	function tapTitle() {
		if (!controller) return;
		if (view?.kind !== 'controller') return openController(controller.id);
		detail.scrollTop = 0;
		window.scrollTo(0, 0);
	}
	const openLaunch = () => navigation.go({ kind: 'launch' });
	const openAgent = (id: string) => navigation.go({ kind: 'agent', id });
	const openNewAgent = (workspace: string) => navigation.go({ kind: 'new-agent', workspace });

	const pending = $derived(inbox.filter((entry) => entry.kind === 'question' && entry.unsent).length);
	const unread = $derived(inbox.filter((entry) => entry.kind === 'report' && entry.readAt === null).length);
</script>

{#snippet names(owner: { project: string; hcomName: string })}
	<strong>{owner.project}</strong>
	<span class="handle">@{owner.hcomName}</span>
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
	<button class="tool icon" onclick={() => settings.open()} aria-label="設定" title="設定">
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
			<!-- Drawn as tabs; a pair of pressed buttons to assistive technology, like the inbox's own
			     views, as the list they switch has no panel of its own around it. -->
			<div class="middle-tabs" role="group" aria-label="清單">
				<button type="button" data-middle="inbox" aria-pressed={middle === 'inbox'} onclick={() => (navigation.setMiddle('inbox'), voice.tap())}>待辦</button>
				<button type="button" data-middle="agents" aria-pressed={middle === 'agents'} onclick={() => navigation.setMiddle('agents')}
					>Herdr<small>{agents.length}</small></button
				>
				<button type="button" data-middle="quota" aria-pressed={middle === 'quota'} onclick={() => navigation.setMiddle('quota')}>額度</button>
			</div>
			{#if middle === 'quota'}
				<QuotaList quota={board.quota} />
			{:else if middle === 'agents'}
				<AgentList {agents} {controllers} {workspaces} currentId={agentId} {newIn} onopen={openAgent} onnew={openNewAgent} />
				<ClosedAgents {closed} currentId={agentId} onopen={openAgent} />
			{:else}
				<Inbox
					items={listedInbox}
					asks={openAsks}
					{endedAsks}
					{controllers}
					{sort}
					{showArchive}
					archive={board.archive}
					earlier={board.archiveEarlier}
					onearlier={() => void board.loadEarlier()}
					onretry={() => void board.loadArchive()}
					{processedCount}
					currentKey={openKey}
					onsort={setSort}
					onarchive={() => {
						showArchive = true;
						void board.loadArchive();
					}}
					onopen={openItem}
					onask={openAsk}
					oncontroller={openController}
				/>
			{/if}
		</section>
		{@render resize('inbox')}

		<section class="detail" bind:this={detail} tabindex="-1">
			{#if view === null}
				<p class="empty">{middle === 'agents' ? '從 Herdr 清單選一個 Agent，看它的對話紀錄。' : '從待辦選一則，或點主控名稱看它的資訊。'}</p>
			{:else}
				<div class="topbar">
					<button onclick={() => navigation.back()} aria-label="返回">←</button>
					{#if agent}
						<span class="whose" title="{agent.folder} {agent.name}">
							<strong>{folderName(agent.folder)}</strong>
							<span class="handle">{agent.hcomName ? `@${agent.hcomName}` : agent.name}</span>
						</span>
					{:else if closedAgent}
						<span class="whose" title="{closedAgent.folder} @{closedAgent.hcomName}">
							<strong>{folderName(closedAgent.folder)}</strong>
							<span class="handle">@{closedAgent.hcomName}</span>
						</span>
					{:else if owner}
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
					{:else if view.what === 'agent'}
						<p class="empty">這個 Agent 已不在 Herdr 的清單上。</p>
					{:else if view.what === 'workspace'}
						<p class="empty">Herdr 裡已經沒有這個工作區。</p>
					{:else if board.archive === 'failed' || (board.archiveEarlier === 'failed' && board.earlierFrom)}
						<p class="empty">待辦裡沒有這一則，已處理的項目也讀不出來；可以重新整理再試一次。</p>
					{:else if !navigation.seeking}
						<p class="empty">這一則已不存在。</p>
					{/if}
				{:else if view.kind === 'agent'}
					{#if agent && agentController}
						<ControllerPage {board} controller={agentController} {agent} {known} {openKey} {listed} onopen={openItem} oncontroller={openController} />
					{:else if agent}
						<AgentInfo {agent} asks={agentAsks} />
					{:else}
						<div class="left-herdr">
							{#if closedAgent}
								<ClosedAgentInfo agent={closedAgent} timeZone={closed.timeZone} controllers={herdrControllers} />
							{:else}
								<p class="empty">這個 Agent 已不在 Herdr 的清單上：它已關閉。</p>
							{/if}
							{#each agentAsks.toReversed() as ask (ask.id)}
								<BoardAskCard {ask} />
							{/each}
						</div>
					{/if}
				{:else if view.kind === 'launch'}
					<NewController {controllers} {agents} {workspaces} stamp={board.snapshot.generatedAt} onopen={openController} onagent={openAgent} />
				{:else if view.kind === 'new-agent'}
					{#if newTarget}
						<NewController {controllers} {agents} {workspaces} stamp={board.snapshot.generatedAt} onopen={openController} onagent={openAgent} target={newTarget} />
					{:else}
						<p class="empty">Herdr 裡已經沒有這個工作區。</p>
					{/if}
				{:else if view.kind === 'controller'}
					{#if controller}
						<ControllerPage {board} {controller} idleAgent={controllerAgent} {known} {openKey} {listed} onopen={openItem} oncontroller={openController} />
					{:else}
						<p class="empty">這個主控已經不在名冊上：它已停用 LAT 或已關閉，回報也都封存了。</p>
					{/if}
				{:else if item && controller}
					<ControllerPage
						{board}
						{controller}
						idleAgent={controllerAgent}
						{known}
						{openKey}
						{listed}
						onopen={openItem}
						oncontroller={openController}
						{item}
						opens={navigation.opens}
						{copy}
						onplaced={() => locate(false)}
						bind:lost
					/>
				{:else if item}
					<!-- An archived item of a controller that has left the roster. -->
					{#if item.kind === 'question' && (!item.askedIn || item.key === lost)}
						<p class="empty">找不到提出這題的原訊息。</p>
					{/if}
					{#key item.key}
						<ItemContent
							{item}
							{listed}
							recorded={board.snapshot.recordedKeys.includes(item.key)}
							onunread={(key) => board.mark(key, false)}
						/>
					{/key}
					<p class="context">{item.project} · @{item.hcomName}（已不在名冊上）</p>
				{/if}
			{/if}
		</section>
		{#if locating && item}
			<!-- Where the report's card will be once its conversation is scrolled to it. It scrolls
			     to be read meanwhile, and the card is placed where it is read. -->
			<div class="placeholder" aria-hidden="true" bind:this={copy}>
				<div inert>
					<ItemContent {item} {listed} recorded={board.snapshot.recordedKeys.includes(item.key)} handle={item.hcomName} onunread={async () => {}} />
				</div>
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
			<!-- A controller's page on the Herdr tab is written to as on its information page. -->
			<CommandLine
				controllers={herdrControllers}
				target={controller ?? agentController}
				agent={view?.kind === 'agent' && !agentController ? agent : undefined}
				closed={view?.kind === 'agent' ? closedAgent : undefined}
				agents={board.snapshot.agents}
				adopt={agentController?.id}
			/>
		</div>
	</div>
</div>

<Settings bind:this={settings} onusagestyle={(style) => void board.setUsageStyle(style)} ontranslatemode={(mode) => void board.setTranslateMode(mode)} />

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
	/* The middle column's two lists, as tabs like those of an information page. */
	/* One line however narrow the column: the tabs scroll sideways rather than wrap. */
	.middle-tabs {
		display: flex;
		flex: none;
		overflow-x: auto;
		scrollbar-width: none;
		gap: 0.2rem;
		margin-bottom: 0.4rem;
		border-bottom: 1px solid var(--line);
	}
	.middle-tabs button {
		display: inline-flex;
		flex: none;
		align-items: center;
		white-space: nowrap;
		gap: 0.35rem;
		margin-bottom: -1px;
		padding: 0.4rem 0.8rem;
		border: 0;
		border-bottom: 2px solid transparent;
		border-radius: 0;
		background: none;
		font-size: max(0.85rem, var(--min-font, 0px));
		color: var(--muted);
	}
	/* An underline, not the filled look of other pressed buttons. */
	.middle-tabs button[aria-pressed='true'] {
		background: none;
		border-color: transparent;
		border-bottom-color: var(--accent);
		color: var(--text);
		font-weight: 600;
	}
	:global(:root[data-theme='light']) .middle-tabs button[aria-pressed='true'] {
		border-bottom-color: var(--text);
	}
	.middle-tabs small {
		padding: 0 0.4rem;
		border-radius: var(--radius-pill);
		background: color-mix(in srgb, var(--text) 10%, var(--bg));
		font-size: max(0.7rem, var(--min-font, 0px));
		font-weight: 400;
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
	.left-herdr {
		display: flex;
		flex-direction: column;
		gap: 0.8rem;
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
		font-size: max(0.85rem, var(--min-font, 0px));
		color: var(--muted);
		overflow-wrap: anywhere;
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
		/* A vertical scrollbar narrows the rail; it never scrolls sideways. The column has the
		   rail's colour, so the scrollbar's transparent track and the marks scrolled past the
		   first screen show it rather than the page's darker one. */
		:global(:root[data-roster='folded']) .roster {
			overflow-x: hidden;
			display: flex;
			padding: 0;
			background: var(--surface);
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
