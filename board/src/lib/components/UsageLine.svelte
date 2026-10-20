<script lang="ts">
	// A client's context use, quota, prompt cache and permission mode in small print, as its live
	// conversation feed last told: on its own line with an icon that spells it out, or (`full`) as
	// a 執行狀況 entry of an information page's details, with nothing left off. Shared by the
	// controllers' and the agents' information pages, so both read the same. The line reads in the
	// style chosen in the settings; the tip and the details are always spelt out.
	import Info from '@lucide/svelte/icons/info';
	import { appearance } from '#lib/board/appearance.svelte.ts';
	import { usageDetails, usageParts, type Usage, type UsagePart } from '#lib/board/usage.ts';

	let { usage, full = false }: { usage: Usage | null; full?: boolean } = $props();

	let now = $state(Date.now());
	// A countdown stays with the cache it belongs to when the line wraps.
	const grouped = (parts: UsagePart[]) =>
		parts.reduce<UsagePart[][]>((groups, part) => {
			if (part.joined && groups.length) groups.at(-1)!.push(part);
			else groups.push([part]);
			return groups;
		}, []);
	const usageGroups = $derived(usage ? grouped(usageParts(usage, now, { style: appearance.usageStyle })) : []);
	const usageLines = $derived(usage ? usageDetails(usage, now) : []);
	// The details show the line with nothing left off.
	const usageFull = $derived(usage ? grouped(usageParts(usage, now, { all: true })) : []);
	// The line spelt out shows while a mouse is over the icon, and after a tap until a tap elsewhere.
	// Fixed to the screen beside the icon, towards the roomier side, so no panel edge cuts it off.
	let usageHover = $state(false);
	let usagePinned = $state(false);
	let usageButton = $state<HTMLButtonElement>();
	// Gone with the line, the icon takes its open state with it, so the tip does not open by itself
	// when the line comes back.
	$effect(() => {
		if (!usageButton) usagePinned = usageHover = false;
	});
	let usageTip = $state<{ left: number | null; right: number | null; top: number | null; bottom: number | null } | null>(null);
	// The tip's own width, to keep it inside the window when its anchoring edge leaves too little room.
	let usageTipWidth = $state(0);
	const edgeGap = 8;
	const keepInside = (edge: number | null) =>
		edge === null ? null : Math.max(edgeGap, Math.min(edge, window.innerWidth - usageTipWidth - edgeGap));
	$effect(() => {
		if (!(usageHover || usagePinned) || !usageButton) {
			usageTip = null;
			return;
		}
		const button = usageButton;
		const place = () => {
			const box = button.getBoundingClientRect();
			const upper = box.top + box.bottom < window.innerHeight;
			const leftward = box.left + box.right < window.innerWidth;
			usageTip = {
				left: leftward ? box.left : null,
				right: leftward ? null : window.innerWidth - box.right,
				top: upper ? box.bottom + 4 : null,
				bottom: upper ? null : window.innerHeight - box.top + 4
			};
		};
		const close = (event: Event) => {
			if (!(event.target instanceof Node && button.contains(event.target))) usagePinned = false;
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key === 'Escape') usagePinned = usageHover = false;
		};
		// Placed again when the line changes and moves the icon.
		void usageGroups;
		place();
		window.addEventListener('scroll', place, true);
		window.addEventListener('resize', place);
		document.addEventListener('pointerdown', close);
		document.addEventListener('keydown', escape);
		return () => {
			window.removeEventListener('scroll', place, true);
			window.removeEventListener('resize', place);
			document.removeEventListener('pointerdown', close);
			document.removeEventListener('keydown', escape);
		};
	});
	// The cache countdown moves on as each minute of it passes, and stops once it has expired.
	$effect(() => {
		const expires = usage?.cache?.expires;
		if (!expires) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const tick = () => {
			// Not read back from `now`, so the effect does not depend on what it writes.
			const current = Date.now();
			now = current;
			const left = expires - current;
			if (left > 0) timer = setTimeout(tick, (left % 60_000) + 1);
		};
		tick();
		return () => clearTimeout(timer);
	});
</script>

{#snippet line(groups: UsagePart[][])}
	{#each groups as group, index (index)}<span class="group"
			>{#each group as part, at (at)}<span class={[part.level, part.joined && 'joined']}>{part.text}</span>{/each}</span
		>{/each}
{/snippet}

{#if full}
	{#if usageFull.length}
		<dt>執行狀況</dt>
		<dd class="line">{@render line(usageFull)}</dd>
	{/if}
{:else}
		{#if usageGroups.length}
			<p class="usage line">
				{@render line(usageGroups)}
				<button
					type="button"
					class="usage-info"
					aria-label="執行狀況明細"
					aria-describedby={usageTip ? 'usage-tip' : undefined}
					bind:this={usageButton}
					onclick={() => (usagePinned = !usagePinned)}
					onpointerenter={(event) => event.pointerType === 'mouse' && (usageHover = true)}
					onpointerleave={(event) => event.pointerType === 'mouse' && (usageHover = false)}
				>
					<Info size="1em" />
				</button>
			</p>
		{/if}
		{#if usageTip && usageGroups.length}
			<div
				id="usage-tip"
				class="usage-tip"
				role="tooltip"
				bind:offsetWidth={usageTipWidth}
				style:left={usageTip.left === null ? null : `${keepInside(usageTip.left)}px`}
				style:right={usageTip.right === null ? null : `${keepInside(usageTip.right)}px`}
				style:top={usageTip.top === null ? null : `${usageTip.top}px`}
				style:bottom={usageTip.bottom === null ? null : `${usageTip.bottom}px`}
			>
				{#each usageLines as line, index (index)}<span>{line}</span>{/each}
			</div>
		{/if}
{/if}

<style>
	/* Small print, its parts apart by a dot; a part that needs a look in the warning colours. The
	   gap spaces the dot from the part before it and the icon from the line, but not at a line start. */
	.usage {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		column-gap: 0.45rem;
		margin: 0.3rem 0 0;
		font-family: var(--mono);
		font-size: max(0.75rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.line .group {
		white-space: nowrap;
	}
	.line .group:has(+ .group)::after {
		content: '•';
		margin: 0 0.45rem;
		color: var(--muted);
	}
	.usage .group:has(+ .group)::after {
		margin-right: 0;
	}
	.line .joined {
		margin-left: 0.35rem;
	}
	.line .warn {
		color: var(--warn);
	}
	.line .danger {
		color: var(--danger);
	}
	/* A tap target twice the icon's size, its margin keeping the line as high as the text. */
	.usage-info {
		display: inline-flex;
		margin-block: -0.5em;
		margin-inline: -0.5em 0;
		padding: 0.5em;
		background: none;
		border: none;
		color: var(--muted);
		cursor: help;
	}
	.usage-tip {
		position: fixed;
		z-index: 30;
		display: flex;
		flex-direction: column;
		width: max-content;
		max-width: calc(100vw - 1rem);
		padding: 0.4rem 0.6rem;
		background: var(--bg);
		border: 1px solid var(--text);
		border-radius: var(--radius);
		font-family: var(--mono);
		font-size: max(0.75rem, var(--min-font, 0px));
		pointer-events: none;
	}
	dt {
		color: var(--muted);
	}
	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	/* Hue alone may not show on e-ink: a part that needs a look is also bold. */
	:global(:root[data-theme='light']) .line :is(.warn, .danger) {
		font-weight: 700;
	}
</style>
