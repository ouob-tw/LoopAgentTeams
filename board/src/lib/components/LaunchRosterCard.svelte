<script lang="ts">
	// A controller launched from the board and not bound yet, as the roster shows it until the real
	// card takes its place (#689): its project, a dashed mark and its HCOM name, and where the launch
	// stands, each cut to one line like a controller's card, framed dashed. It opens the new-controller page, whose
	// launch row leads on; one that is over (failed, overdue, uncertain) can be removed.
	import X from '@lucide/svelte/icons/x';
	import { lastSegment } from '#lib/board/agents.ts';
	import { folderName } from '#lib/board/folder-search.ts';
	import { CLIENT_LABEL, LAUNCH_CARD_TAG, LAUNCH_STATE_TEXT, type LaunchCard } from '#lib/board/launch.ts';
	import LaunchMark from './LaunchMark.svelte';

	let { launch, onopen, ondismiss }: { launch: LaunchCard; onopen: () => void; ondismiss: (id: string) => void } = $props();

	const project = $derived(folderName(launch.scope ?? launch.folder));
	// Without an HCOM name, the client it was started in.
	const handle = $derived(launch.hcomName ? `@${lastSegment(launch.hcomName)}` : CLIENT_LABEL[launch.client]);
	const text = $derived(LAUNCH_STATE_TEXT[launch.state]);
	const label = $derived(`${project} ${launch.hcomName ? `@${launch.hcomName}` : ''}：${text}${launch.error ? `（${launch.error}）` : ''}`);
	const over = $derived(launch.state !== 'starting');
</script>

<div class="person launch" class:over data-launch={launch.id} data-state={launch.state} title={label}>
	<button class="open" aria-label={label} onclick={onopen}></button>
	<strong class="project">{project}</strong>
	<span class="who">
		<LaunchMark state={launch.state} />
		<span class="handle">{handle}</span>
		<span class="tag">{LAUNCH_CARD_TAG[launch.state]}</span>
	</span>
	<span class="phase">{text}</span>
	{#if over}
		<button class="dismiss" aria-label="移除這張卡" title="移除這張卡" onclick={() => ondismiss(launch.id)}><X size="1em" aria-hidden="true" /></button>
	{/if}
</div>

<style>
	/* Framed and spaced like a controller's card (RosterCard), which is a button. */
	.person {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
		padding: 0.55rem 0.6rem;
		background: var(--surface);
		border: 1px dashed var(--line);
		border-radius: var(--radius);
	}
	/* The whole card opens; the text above it lets the pointer through. */
	.open {
		position: absolute;
		inset: 0;
		padding: 0;
		background: none;
		border: 0;
		border-radius: inherit;
	}
	.project,
	.who,
	.phase {
		pointer-events: none;
	}
	.over .project {
		/* Room for the remove button in the corner. */
		padding-right: 1.6rem;
	}
	.project,
	.phase,
	.handle {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.who {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-width: 0;
	}
	.handle {
		font-family: var(--mono);
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.phase {
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.over[data-state='failed'] .phase {
		color: var(--danger);
	}
	/* The phase line says it on a wide screen; a phone's two-line tag has only this word. */
	.tag {
		display: none;
		flex: none;
		font-size: max(0.75rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.over[data-state='failed'] .tag {
		color: var(--danger);
	}
	/* In the corner, above the card's own button. */
	.dismiss {
		position: absolute;
		top: 0;
		right: 0;
		z-index: 1;
		display: flex;
		align-items: flex-start;
		justify-content: flex-end;
		width: 2.75rem;
		height: 2.75rem;
		padding: 0.45rem 0.5rem;
		background: none;
		border: 0;
		color: var(--muted);
	}
	.dismiss:hover {
		color: var(--text);
	}

	@media (max-width: 760px) {
		.tag {
			display: inline;
		}
	}
</style>
