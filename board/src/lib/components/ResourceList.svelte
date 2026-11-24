<script lang="ts">
	// The 資源 tab: the host's CPU, load and memory and each disk as a bar with its number, then the
	// agents by what their processes use, the heaviest first: five shown, the rest folded, and the
	// processes no agent owns summed last. Asks the server for a new reading every few seconds while
	// it is shown; nothing is asked once another tab is chosen, as this is no longer drawn.
	import OctagonAlert from '@lucide/svelte/icons/octagon-alert';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { createRequest } from '#lib/board/api.ts';
	import {
		level,
		loadPercent,
		percent,
		percentText,
		REFRESH_MS,
		sizeText,
		TOP,
		usedOfText,
		type ResourceSnapshot
	} from '#lib/board/resources.ts';

	let { onopen }: { onopen: (id: string) => void } = $props();

	const request = createRequest();
	let snapshot = $state<ResourceSnapshot | null>(null);
	let failure = $state<string | null>(null);
	let all = $state(false);

	$effect(() => {
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		async function read() {
			// A hidden page asks for nothing until it is seen again.
			if (!document.hidden) {
				const result = await request<ResourceSnapshot>('/api/resources');
				if (stopped) return;
				if (result.ok) {
					snapshot = result.value;
					failure = null;
				} else {
					failure = (result.body as { message?: string } | null | undefined)?.message ?? result.message;
				}
			}
			if (!stopped) timer = setTimeout(read, REFRESH_MS);
		}
		read();
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	});

	const shown = $derived(snapshot ? (all ? snapshot.agents : snapshot.agents.slice(0, TOP)) : []);
	const folded = $derived(snapshot ? Math.max(0, snapshot.agents.length - TOP) : 0);
</script>

{#snippet meter(label: string, value: number, text: string, title?: string)}
	{@const tone = level(value)}
	<li class="meter" {title}>
		<span class="label">{label}</span>
		<span class={['bar', tone]} aria-hidden="true"><i style:width="{Math.min(100, value)}%"></i></span>
		<span class={['value', tone]}>
			{#if tone === 'danger'}<OctagonAlert size="1em" aria-label="過高" />{:else if tone === 'warn'}<TriangleAlert size="1em" aria-label="偏高" />{/if}{text}
		</span>
	</li>
{/snippet}

<div class="resource">
	{#if failure}
		<p class="failed">讀不到主機資源：{failure}</p>
	{/if}
	{#if !snapshot}
		{#if !failure}<p class="none">讀取中…</p>{/if}
	{:else}
		<div class="gauges">
		<section data-part="host">
			<h2>主機</h2>
			<ul class="meters">
				{@render meter('CPU', snapshot.cpu, percentText(snapshot.cpu), `${snapshot.cores} 核`)}
				{@render meter(
					'負載',
					loadPercent(snapshot.load[0], snapshot.cores),
					snapshot.load[0].toFixed(1),
					`1、5、15 分鐘：${snapshot.load.map((load) => load.toFixed(2)).join('、')}（${snapshot.cores} 核）`
				)}
				{@render meter(
					'記憶體',
					percent(snapshot.memory.used, snapshot.memory.total),
					usedOfText(snapshot.memory.used, snapshot.memory.total),
					percentText(percent(snapshot.memory.used, snapshot.memory.total))
				)}
			</ul>
		</section>
		<section data-part="disks">
			<h2>磁碟</h2>
			{#if snapshot.disks.length}
				<ul class="meters">
					{#each snapshot.disks as disk (disk.mount)}
						{@render meter(disk.mount, percent(disk.used, disk.total), usedOfText(disk.used, disk.total), `${disk.mount}：${percentText(percent(disk.used, disk.total))}`)}
					{/each}
				</ul>
			{:else}
				<p class="none">沒有讀到磁碟</p>
			{/if}
		</section>
		</div>
		<section data-part="agents">
			<header class="row head">
				<h2>Agent</h2>
				<span class="num">CPU</span>
				<span class="num">記憶體</span>
			</header>
			{#if snapshot.agents.length}
				<ul class="agents">
					{#each shown as agent, index (agent.id ?? `${agent.name}:${index}`)}
						<li>
							<button type="button" class="row" disabled={agent.id === null} title={`${agent.name}（${agent.client}，${agent.processes} 個程序）`} onclick={() => agent.id && onopen(agent.id)}>
								<span class="name">{agent.name}</span>
								<span class="num">{percentText(agent.cpu)}</span>
								<span class="num">{sizeText(agent.memory)}</span>
							</button>
						</li>
					{/each}
				</ul>
				{#if folded}
					<button type="button" class="fold" aria-expanded={all} onclick={() => (all = !all)}>
						{all ? '收合' : `顯示全部（再 ${folded} 個）`}
					</button>
				{/if}
			{:else}
				<p class="none">沒有找到 Agent 的程序</p>
			{/if}
			<p class="row other" title={snapshot.other.top.length ? `用最多的：${snapshot.other.top.join('、')}` : undefined}>
				<span class="name">其他<small>{snapshot.other.top.join('、')}</small></span>
				<span class="num">{percentText(snapshot.other.cpu)}</span>
				<span class="num">{sizeText(snapshot.other.memory)}</span>
			</p>
		</section>
	{/if}
</div>

<style>
	.resource {
		display: flex;
		flex-direction: column;
		gap: 1.1rem;
		min-width: 0;
	}
	section {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		min-width: 0;
	}
	h2 {
		margin: 0;
		font-size: max(0.95rem, var(--min-font, 0px));
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	/* Label, bar and number share their columns across every meter of both sections, so the bars
	   start and end together. */
	.gauges {
		display: grid;
		grid-template-columns: max-content minmax(3rem, 1fr) max-content;
		gap: 1.1rem 0.6rem;
	}
	.gauges section,
	.meters {
		display: grid;
		grid-column: 1 / -1;
		grid-template-columns: subgrid;
	}
	.gauges section > :not(.meters) {
		grid-column: 1 / -1;
	}
	.meters {
		row-gap: 0.55rem;
	}
	.meter {
		display: grid;
		grid-column: 1 / -1;
		grid-template-columns: subgrid;
		align-items: center;
		font-size: max(1rem, var(--min-font, 0px));
	}
	.meter .label {
		max-width: 9em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--muted);
	}
	.bar {
		height: 0.6rem;
		border-radius: var(--radius-pill);
		/* A faint track, so only the filled part reads as used in either theme. */
		background: color-mix(in srgb, var(--muted) 25%, transparent);
		overflow: hidden;
	}
	.bar i {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--accent);
	}
	.bar.warn i {
		background: var(--warn);
	}
	.bar.danger i {
		background: var(--danger);
	}
	.value {
		display: inline-flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.2rem;
		white-space: nowrap;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.value.warn {
		color: var(--warn);
		font-weight: 700;
	}
	.value.danger {
		color: var(--danger);
		font-weight: 700;
	}
	/* Name, CPU and memory: the numbers in fixed columns so they line up down the list. */
	.row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 4.2em 4.2em;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		margin: 0;
		font-size: max(1rem, var(--min-font, 0px));
	}
	.head {
		padding: 0 0.5rem;
	}
	.head .num {
		color: var(--muted);
		font-size: max(0.85rem, var(--min-font, 0px));
	}
	.agents {
		display: flex;
		flex-direction: column;
		border-top: 1px solid var(--line);
	}
	.agents li {
		border-bottom: 1px solid var(--line);
	}
	.agents button {
		min-height: 2.75rem;
		padding: 0.3rem 0.5rem;
		border: 0;
		border-radius: 0;
		background: none;
		color: var(--text);
		text-align: left;
		font: inherit;
		font-size: max(1rem, var(--min-font, 0px));
	}
	.agents button:not(:disabled) {
		cursor: pointer;
	}
	.agents button:not(:disabled):hover {
		background: var(--surface);
	}
	.agents button:disabled {
		opacity: 1;
		cursor: default;
	}
	.name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.num {
		text-align: right;
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	.fold {
		align-self: flex-start;
		min-height: 2.75rem;
		padding: 0 0.5rem;
		border: 0;
		background: none;
		color: var(--accent);
		font: inherit;
		font-size: max(1rem, var(--min-font, 0px));
		cursor: pointer;
	}
	.other {
		padding: 0 0.5rem;
		color: var(--muted);
	}
	.other small {
		margin-left: 0.5rem;
		font-size: max(0.85rem, var(--min-font, 0px));
	}
	.none,
	.failed {
		margin: 0;
	}
	.none {
		color: var(--muted);
	}
	.failed {
		color: var(--danger);
		overflow-wrap: anywhere;
	}
</style>
