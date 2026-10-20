<script lang="ts" generics="T extends string">
	// A page's records, one tab at a time: the tab strip, then a panel for each tab. All panels stay
	// mounted, so a conversation keeps its place and its live feed. Tabs and panels are identified by
	// their IDs alone, as one strip is on the screen at a time.
	import type { Snippet } from 'svelte';

	let {
		tabs,
		tab = $bindable(),
		ariaLabel,
		panel
	}: {
		/** In order; a count is shown after the label unless it is null. */
		tabs: readonly { id: T; label: string; count: number | null }[];
		/** The tab shown. */
		tab: T;
		/** What the strip lists, for screen readers. */
		ariaLabel: string;
		/** A tab's panel content. */
		panel: Snippet<[T]>;
	} = $props();

	function tabKeys(event: KeyboardEvent) {
		const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
		if (!step) return;
		event.preventDefault();
		const at = tabs.findIndex((entry) => entry.id === tab);
		tab = tabs[(at + step + tabs.length) % tabs.length].id;
		(event.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-tab="${tab}"]`)?.focus();
	}
</script>

<!-- svelte-ignore a11y_interactive_supports_focus -->
<div class="tabs" role="tablist" aria-label={ariaLabel} onkeydown={tabKeys}>
	{#each tabs as entry (entry.id)}
		<button
			type="button"
			role="tab"
			id="tab-{entry.id}"
			data-tab={entry.id}
			aria-selected={tab === entry.id}
			aria-controls="panel-{entry.id}"
			tabindex={tab === entry.id ? 0 : -1}
			onclick={() => (tab = entry.id)}
		>
			{entry.label}{#if entry.count !== null}<small>{entry.count}</small>{/if}
		</button>
	{/each}
</div>

{#each tabs as entry (entry.id)}
	<div class="tabpanel" role="tabpanel" id="panel-{entry.id}" aria-labelledby="tab-{entry.id}" hidden={tab !== entry.id}>
		{@render panel(entry.id)}
	</div>
{/each}

<style>
	.tabs {
		display: flex;
		gap: 0.2rem;
		border-bottom: 1px solid var(--line);
	}
	.tabs button {
		display: inline-flex;
		align-items: center;
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
	.tabs button[aria-selected='true'] {
		border-bottom-color: var(--accent);
		color: var(--text);
		font-weight: 600;
	}
	.tabs small {
		padding: 0 0.4rem;
		border-radius: var(--radius-pill);
		background: color-mix(in srgb, var(--text) 10%, var(--bg));
		font-size: max(0.7rem, var(--min-font, 0px));
		font-weight: 400;
	}
	.tabpanel {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.tabpanel[hidden] {
		display: none;
	}

	/* Light theme: the open tab is underlined in the text colour. */
	:global(:root[data-theme='light']) .tabs button[aria-selected='true'] {
		border-bottom-color: var(--text);
	}

	/* A phone: the tabs share the width. */
	@media (max-width: 760px) {
		.tabs button {
			flex: 1;
			justify-content: center;
			padding: 0.5rem 0.3rem;
		}
	}
</style>
