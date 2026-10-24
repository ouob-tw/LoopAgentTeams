<script lang="ts">
	// The Herdr tab: every Herdr workspace, with or without agents, and every agent Herdr lists in
	// it, in Herdr's own order. Each workspace heading has a ＋ that opens a new agent there. Each row
	// shows its Herdr tab and hcom name, status, client, project folder and whether hcom reaches it; LAT controllers
	// are marked, and so are agents with a model switch left unfinished, listed even when Herdr no
	// longer lists them. A card's handle drags its Herdr tab to another place in the same workspace;
	// its context menu (a long press on a touch screen) renames the tab on the card itself. Hovering
	// a card explains it, a controller's with the duty it recorded; its menu shows the duty too.
	import GripVertical from '@lucide/svelte/icons/grip-vertical';
	import Plus from '@lucide/svelte/icons/plus';
	import { agentControl } from '#lib/board/agent-control.svelte.ts';
	import { AGENT_MARK, agentGroups, folderName, tabDrop } from '#lib/board/agents.ts';
	import { Explainer } from '#lib/board/explain.svelte.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';
	import { AGENT_HCOM_LABEL, AGENT_STATUS_LABEL, type Agent, type Controller, type HerdrWorkspace } from '#lib/board/types.ts';
	import { ASKING_STATUS_TEXT } from '#lib/board/board-asks.ts';
	import AgentCardName from './AgentCardName.svelte';
	import DutyText from './DutyText.svelte';
	import ExplainTip from './ExplainTip.svelte';
	import HcomBadge from './HcomBadge.svelte';
	import StatusMark from './StatusMark.svelte';

	let {
		agents,
		controllers,
		workspaces,
		currentId,
		newIn,
		onopen,
		onnew
	}: {
		agents: Agent[];
		/** The roster's controllers, for the duty of a card that is one. */
		controllers: Controller[];
		workspaces: HerdrWorkspace[];
		currentId: string | null;
		/** The workspace whose new-agent form is open; null when none is. */
		newIn: string | null;
		onopen: (id: string) => void;
		onnew: (workspace: string) => void;
	} = $props();

	const groups = $derived(agentGroups(agents, workspaces));
	/** A card's key: its Herdr pane, since one session can be open in two panes; its session when
	 *  it is listed only from its switch and has no pane. */
	const keyOf = (agent: Agent) => (agent.inHerdr || !agent.id ? agent.herdr.pane : agent.id);
	const dutyOf = (agent: Agent) => (agent.controller ? (controllers.find((controller) => controller.id === agent.id)?.duty ?? null) : null);

	/** A touch's long press opens the card's menu instead, so only hovering and focus explain a card. */
	const explainer = new Explainer<string>(() => {});
	const explained = $derived(agents.find((agent) => keyOf(agent) === explainer.tip?.key));
	/** What makes a card explain itself, in place of the browser's own tooltip. */
	const explaining = (agent: Agent) => ({
		'aria-describedby': explainer.tip?.key === keyOf(agent) ? 'agent-tip' : undefined,
		onpointerenter: (event: PointerEvent & { currentTarget: HTMLElement }) => explainer.hover(event, keyOf(agent)),
		onpointerleave: explainer.leave,
		onfocus: (event: FocusEvent & { currentTarget: HTMLElement }) => explainer.focus(event, keyOf(agent)),
		onblur: explainer.dismiss
	});

	/** How long a touch is held before the card's menu opens, and how far it may wander meanwhile. */
	const LONG_PRESS_MS = 450;
	const PRESS_SLOP_PX = 8;
	/** How far past its workspace a dragged card may go before it is outside it. */
	const DRAG_SLOP_PX = 8;
	const DRAG_SIDE_SLOP_PX = 40;

	/** Cards whose tab is being moved or renamed. */
	let busy = $state<Record<string, true>>({});
	/** The card being dragged: where it started, where the pointer is, and where it would land. */
	let drag = $state<{
		key: string;
		startY: number;
		x: number;
		y: number;
		/** The card under the pointer and where its tab would go; null over the card's own tab. */
		over: { key: string; tab: string; after: boolean } | null;
		refused: boolean;
	} | null>(null);
	/** Where the dragged card's workspace and its cards were when the drag started. */
	let dragFrame: { cards: Agent[]; index: number; bottoms: number[]; box: DOMRect } | null = null;
	/** The card whose menu is open, and where. */
	let menu = $state<{ agent: Agent; x: number; y: number } | null>(null);
	let menuBox = $state<HTMLElement>();
	/** The card whose tab name is being edited. */
	let renaming = $state<string | null>(null);
	let press: { timer: ReturnType<typeof setTimeout>; x: number; y: number } | null = null;
	/** Set when a long press opened the menu, so the click that ends it does not open the agent. */
	let pressed = false;

	function grab(event: PointerEvent, agent: Agent, cards: Agent[]) {
		if (event.button !== 0 || busy[keyOf(agent)]) return;
		event.preventDefault();
		event.stopPropagation();
		const handle = event.currentTarget as HTMLElement;
		handle.setPointerCapture(event.pointerId);
		const group = handle.closest('.group')!;
		dragFrame = {
			cards,
			index: cards.indexOf(agent),
			bottoms: [...group.querySelectorAll('[data-card]')].map((card) => card.getBoundingClientRect().bottom),
			box: group.getBoundingClientRect()
		};
		menu = null;
		explainer.dismiss();
		drag = { key: keyOf(agent), startY: event.clientY, x: event.clientX, y: event.clientY, over: null, refused: false };
	}

	function dragTo(event: PointerEvent) {
		if (!drag || !dragFrame) return;
		const { cards, index, bottoms, box } = dragFrame;
		const { clientX: x, clientY: y } = event;
		const refused =
			y < box.top - DRAG_SLOP_PX || y > box.bottom + DRAG_SLOP_PX || x < box.left - DRAG_SIDE_SLOP_PX || x > box.right + DRAG_SIDE_SLOP_PX;
		let over = null;
		if (!refused) {
			// The first card not above the pointer, by where the cards were before the drag.
			let at = bottoms.findIndex((bottom) => y < bottom);
			if (at < 0) at = cards.length - 1;
			const target = at === index ? null : tabDrop(cards, index, at);
			over = target && { key: keyOf(cards[target.mark]), tab: target.tab, after: target.after };
		}
		drag = { ...drag, x, y, over, refused };
	}

	function drop(event: PointerEvent, agent: Agent) {
		if (!drag) return;
		const { over, refused } = drag;
		drag = null;
		dragFrame = null;
		if (event.type !== 'pointerup') return;
		if (refused) toasts.show('info', '不能拖到別的工作區，已放回原位。');
		else if (over) void act(agent, () => agentControl.moveTab(agent.id, place(agent), over.tab), '已調整分頁順序', '排序失敗');
	}

	const place = (agent: Agent) => ({ workspace: agent.herdr.workspace, tab: agent.herdr.tab });

	/** One move or rename at a time per card; the list the server reads again afterwards shows the outcome. */
	async function act(agent: Agent, call: () => ReturnType<typeof agentControl.moveTab>, done: string, failed: string) {
		const key = keyOf(agent);
		busy[key] = true;
		const outcome = await call();
		delete busy[key];
		if (outcome.ok) toasts.show('ok', `${done}${outcome.reason ?? ''}`);
		else toasts.show('failed', `${failed}：${outcome.reason}`);
	}

	function openMenu(agent: Agent, x: number, y: number) {
		renaming = null;
		explainer.dismiss();
		menu = { agent, x, y };
	}

	function contextMenu(event: MouseEvent, agent: Agent) {
		if (!agent.inHerdr || renaming === keyOf(agent)) return;
		event.preventDefault();
		// Opened from the keyboard: by the card, not where the pointer happens to be.
		if (event.clientX === 0 && event.clientY === 0) {
			const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
			openMenu(agent, box.left + 16, box.top + 16);
		} else openMenu(agent, event.clientX, event.clientY);
	}

	function pressStart(event: PointerEvent, agent: Agent) {
		pressed = false;
		cancelPress();
		if (event.pointerType !== 'touch' || !agent.inHerdr || renaming === keyOf(agent)) return;
		const { clientX: x, clientY: y } = event;
		press = {
			x,
			y,
			timer: setTimeout(() => {
				press = null;
				pressed = true;
				openMenu(agent, x, y);
			}, LONG_PRESS_MS)
		};
	}

	function pressMove(event: PointerEvent) {
		if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > PRESS_SLOP_PX) cancelPress();
	}

	function cancelPress() {
		if (press) clearTimeout(press.timer);
		press = null;
	}

	function open(id: string) {
		if (pressed) pressed = false;
		else onopen(id);
	}

	// Kept on the screen, however close to its edge it was opened; its one item takes the focus.
	$effect(() => {
		if (!menu || !menuBox) return;
		const { width, height } = menuBox.getBoundingClientRect();
		menuBox.style.left = `${Math.max(8, Math.min(menu.x, innerWidth - width - 8))}px`;
		menuBox.style.top = `${Math.max(8, Math.min(menu.y, innerHeight - height - 8))}px`;
		menuBox.querySelector('button')?.focus();
	});

	function startRename(agent: Agent) {
		menu = null;
		renaming = keyOf(agent);
	}

	function renameKeys(event: KeyboardEvent, agent: Agent) {
		// Enter that picks an input method's candidate is not the user's Enter.
		if (event.isComposing) return;
		if (event.key === 'Escape') renaming = null;
		if (event.key !== 'Enter') return;
		event.preventDefault();
		const label = (event.currentTarget as HTMLInputElement).value.trim();
		if (!label) return toasts.show('info', '分頁名稱不能空白，沒有送出。');
		renaming = null;
		if (label === agent.herdr.tabPlace?.label) return;
		void act(agent, () => agentControl.renameTab(agent.id, place(agent), label), `分頁已改名為「${label}」`, '改名失敗');
	}

	const editing = (input: HTMLInputElement) => {
		input.focus();
		input.select();
	};
</script>

<svelte:window
	onpointerdown={(event) => {
		if (menu && !menuBox?.contains(event.target as Node)) menu = null;
	}}
	onkeydown={(event) => {
		if (menu && event.key === 'Escape') menu = null;
	}}
	onscroll={() => (menu = null)}
	onresize={() => (menu = null)}
/>

{#each groups as group (group.workspace)}
	{@const listed = workspaces.some((workspace) => workspace.id === group.workspace)}
	<section class="group" data-workspace={group.workspace}>
		<div class="heading">
			<h3>{group.label}</h3>
			<!-- Only a workspace Herdr lists can take a new tab. -->
			{#if listed}
				<button
					type="button"
					class="new"
					class:current={newIn === group.workspace}
					aria-label="在 {group.label} 開新 Agent"
					title="在 {group.label} 開新 Agent"
					onclick={() => onnew(group.workspace)}
				>
					<Plus size="1.1em" />
				</button>
			{/if}
		</div>
		{#each group.agents as agent (keyOf(agent))}
			{@const id = agent.id}
			{@const key = keyOf(agent)}
			{@const dragged = drag?.key === key}
			<div
				class="card"
				class:dragging={dragged}
				class:refused={dragged && drag?.refused}
				class:drop-before={drag?.over?.key === key && !drag.over.after}
				class:drop-after={drag?.over?.key === key && drag.over.after}
				class:busy={busy[key]}
				data-card={key}
				data-tab={agent.herdr.tab}
				style:transform={dragged ? `translateY(${drag!.y - drag!.startY}px)` : null}
				role="presentation"
				oncontextmenu={(event) => contextMenu(event, agent)}
				onpointerdown={(event) => pressStart(event, agent)}
				onpointermove={pressMove}
				onpointerup={cancelPress}
				onpointercancel={cancelPress}
			>
				{#if renaming === key}
					<div class="agent renaming" data-agent={id} data-pane={id ? null : agent.herdr.pane}>
						{@render row(agent, true)}
					</div>
				{:else if id}
					<button class="agent" class:current={id === currentId} data-agent={id} {...explaining(agent)} onclick={() => open(id)}>
						{@render row(agent, false)}
					</button>
				{:else}
					<!-- Herdr does not know its session yet, and everything about an agent is keyed by it. -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div class="agent" data-pane={agent.herdr.pane} {...explaining(agent)}>
						{@render row(agent, false)}
						<span class="pending">Herdr 還沒回報它的 session ID，暫時無法開啟</span>
					</div>
				{/if}
				<!-- Only a tab Herdr lists now can be moved; one listed for its open switch alone is not. -->
				{#if agent.inHerdr}
					<span
						class="grip"
						title="拖曳調整分頁順序"
						aria-hidden="true"
						onpointerdown={(event) => grab(event, agent, group.agents)}
						onpointermove={dragTo}
						onpointerup={(event) => drop(event, agent)}
						onpointercancel={(event) => drop(event, agent)}
					>
						<GripVertical size="1.2em" />
					</span>
				{/if}
			</div>
		{:else}
			<p class="empty-workspace">沒有 Agent</p>
		{/each}
	</section>
{:else}
	<p class="none">Herdr 裡沒有 Agent。</p>
{/each}

{#if drag?.refused}
	<div class="refuse-tip" style:left="{drag.x + 14}px" style:top="{drag.y + 14}px">不能拖到別的工作區</div>
{/if}

{#if menu}
	{@const target = menu.agent}
	{@const duty = dutyOf(target)}
	<div class="menu" bind:this={menuBox}>
		{#if duty}
			<div class="duty"><DutyText {duty} /></div>
		{/if}
		<div role="menu" aria-label="分頁">
			<button type="button" role="menuitem" onclick={() => startRename(target)}>改分頁名稱</button>
		</div>
	</div>
{/if}

{#if explainer.tip && explained}
	{@const duty = dutyOf(explained)}
	<ExplainTip id="agent-tip" place={explainer.tip}>
		<strong>{explained.name}</strong>
		<span>{AGENT_STATUS_LABEL[explained.status]}（{explained.statusSource === 'hcom' ? 'HCOM' : 'Herdr'}）・{explained.client}・{AGENT_HCOM_LABEL[explained.hcom]}</span>
		{#if explained.herdr.tabPlace}<span>分頁 {explained.herdr.tabPlace.label}</span>{/if}
		<span class="tip-folder">{explained.folder}</span>
		{#if duty}
			<hr class="rule" />
			<DutyText {duty} />
		{/if}
	</ExplainTip>
{/if}

{#snippet row(agent: Agent, edit: boolean)}
	<span class="who">
		<StatusMark status={AGENT_MARK[agent.status]} decorative />
		{#if edit}
			<input
				class="rename"
				aria-label="分頁名稱"
				value={agent.herdr.tabPlace?.label ?? ''}
				onkeydown={(event) => renameKeys(event, agent)}
				onblur={() => {
					if (renaming === keyOf(agent)) renaming = null;
				}}
				{@attach editing}
			/>
		{:else}
			<AgentCardName {agent} />
		{/if}
		{#if agent.controller}
			<span class="tag" title="LAT 主控">主控</span>
		{/if}
		{#if agent.switch}
			<span class="tag unfinished" title={agent.inHerdr ? '模型切換未完成' : '模型切換未完成，已不在 Herdr 的清單上'}>切換未完成</span>
		{/if}
	</span>
	<span class="facts">
		<span class="status" class:asking={agent.asking}>{agent.asking ? ASKING_STATUS_TEXT : AGENT_STATUS_LABEL[agent.status]}</span>
		<span>{agent.client}</span>
		<!-- Not linked shows nothing, so the badge alone means linked; the tooltip still says it. -->
		{#if agent.hcom !== 'none'}<HcomBadge hcom={agent.hcom} />{/if}
	</span>
	<span class="folder">{folderName(agent.folder)}</span>
{/snippet}

<style>
	/* Laid out like the column it sits in, which lists its children this far apart. */
	.group {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		margin: 0.9rem 0 0.1rem;
	}
	.group:first-child > .heading {
		margin-top: 0.2rem;
	}
	h3 {
		margin: 0;
		min-width: 0;
		font-size: max(0.8rem, var(--min-font, 0px));
		font-weight: 600;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	/* As tall as the roster's tools, and a finger wide. */
	.new {
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		box-sizing: border-box;
		width: 2.2rem;
		height: 2.2rem;
		padding: 0;
		color: var(--text);
	}
	.new.current {
		background: var(--selected-bg);
		color: var(--selected-text);
	}
	.empty-workspace {
		margin: 0;
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	/* No text selection or callout under a long press, which opens the card's menu instead. */
	.card {
		position: relative;
		display: flex;
		flex-direction: column;
		min-width: 0;
		-webkit-touch-callout: none;
		user-select: none;
	}
	.agent {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
		text-align: left;
		padding: 0.55rem 0.6rem;
	}
	/* Room for the handle, which lies over the card's right edge. */
	.card:has(.grip) > .agent {
		padding-right: 2.6rem;
	}
	/* A finger wide and as tall as the card; touching it drags instead of scrolling the list. */
	.grip {
		position: absolute;
		top: 0;
		right: 0;
		bottom: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.4rem;
		color: var(--muted);
		cursor: grab;
		touch-action: none;
	}
	.grip:hover {
		color: var(--text);
	}
	.dragging {
		z-index: 2;
		opacity: 0.85;
		box-shadow: 0 4px 16px rgb(0 0 0 / 0.35);
	}
	.dragging .grip {
		cursor: grabbing;
	}
	.refused {
		opacity: 0.5;
	}
	.refused .grip {
		cursor: not-allowed;
	}
	/* Where the dragged tab would land: a line on the side of the card it would go, drawn over the
	   dragged card, which may cover it. */
	.drop-before::before,
	.drop-after::after {
		content: '';
		position: absolute;
		z-index: 3;
		left: 0;
		right: 0;
		height: 3px;
		border-radius: 2px;
		background: var(--accent);
	}
	.drop-before::before {
		top: -0.25rem;
	}
	.drop-after::after {
		bottom: -0.25rem;
	}
	/* Its tab is being moved or renamed. */
	.busy {
		opacity: 0.6;
	}
	.busy .grip {
		cursor: progress;
	}
	div.agent.renaming {
		border-style: solid;
		border-color: var(--accent);
	}
	/* No taller than the title it stands in for, so the card keeps its height. */
	.rename {
		flex: 1 1 auto;
		min-width: 0;
		padding: 0 0.4rem;
		font: inherit;
		font-family: var(--mono);
		font-weight: 600;
		color: var(--text);
	}
	.refuse-tip,
	.menu {
		position: fixed;
		z-index: 20;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--surface);
		box-shadow: 0 4px 16px rgb(0 0 0 / 0.35);
	}
	.refuse-tip {
		padding: 0.3rem 0.6rem;
		border-color: var(--danger);
		color: var(--danger);
		font-size: max(0.8rem, var(--min-font, 0px));
		pointer-events: none;
	}
	.menu {
		left: 0;
		top: 0;
		padding: 0.25rem;
	}
	/* Above the menu's items: what the controller is responsible for. */
	.menu .duty {
		display: flex;
		flex-direction: column;
		max-width: min(18rem, 70vw);
		padding: 0.3rem 0.5rem 0.45rem;
		margin-bottom: 0.25rem;
		border-bottom: 1px solid var(--line);
		font-size: max(0.8rem, var(--min-font, 0px));
		overflow-wrap: anywhere;
	}
	.tip-folder {
		font-family: var(--mono);
		color: var(--muted);
	}
	/* Between where the agent is and its duty. */
	.rule {
		width: 100%;
		margin: 0.3rem 0;
		border: 0;
		border-top: 1px solid var(--line);
	}
	.menu button {
		display: block;
		width: 100%;
		min-height: 2.4rem;
		border: none;
		text-align: left;
	}
	.agent.current {
		border-color: var(--accent);
	}
	.who,
	.facts {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-width: 0;
	}
	.folder {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tag {
		flex: none;
		padding: 0 0.4rem;
		border: 1px solid var(--accent);
		border-radius: var(--radius-pill);
		color: var(--accent);
		font-size: max(0.7rem, var(--min-font, 0px));
	}
	.tag.unfinished {
		border-color: var(--warn);
		color: var(--warn);
	}
	.facts,
	.folder {
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.facts {
		flex-wrap: wrap;
		gap: 0 0.6rem;
	}
	.status {
		color: var(--text);
	}
	.status.asking {
		color: var(--warn);
		font-weight: 700;
	}
	/* Not a button: framed like one, but nothing to press. */
	div.agent {
		border: 1px dashed var(--line);
		border-radius: var(--radius);
		background: var(--surface);
	}
	.pending {
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.none {
		margin: 0.5rem 0;
		color: var(--muted);
	}

	:global(:root[data-theme='light']) .agent.current {
		border-color: var(--text);
		outline: 2px solid var(--text);
		outline-offset: -3px;
	}
</style>
