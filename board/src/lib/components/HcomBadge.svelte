<script lang="ts">
	// Whether hcom reaches an agent, as a small badge: an icon of its own for each state (linked,
	// paused, not linked, not known), so it reads without its colour; the words in its tooltip and
	// label. A paused one says so in words too: it is not linked, and not closed either.
	import CircleQuestionMark from '@lucide/svelte/icons/circle-question-mark';
	import Link from '@lucide/svelte/icons/link';
	import Pause from '@lucide/svelte/icons/pause';
	import Unlink from '@lucide/svelte/icons/unlink';
	import { AGENT_HCOM_LABEL, type AgentHcom } from '#lib/board/types.ts';

	let { hcom }: { hcom: AgentHcom } = $props();

	const ICON = { linked: Link, paused: Pause, none: Unlink, unknown: CircleQuestionMark };
	const Icon = $derived(ICON[hcom]);
</script>

<span class="hcom {hcom}" role="img" title={AGENT_HCOM_LABEL[hcom]} aria-label={AGENT_HCOM_LABEL[hcom]}
	><Icon size="1em" aria-hidden="true" /><span aria-hidden="true">{hcom === 'paused' ? AGENT_HCOM_LABEL.paused : 'HCOM'}</span></span
>

<style>
	.hcom {
		display: inline-flex;
		flex: none;
		align-items: center;
		gap: 0.2rem;
		white-space: nowrap;
	}
	.linked {
		color: var(--ok);
	}
	.none {
		color: var(--muted);
	}
	.unknown,
	.paused {
		color: var(--warn);
	}
	/* Hue alone may not show on e-ink: the states that need a look are also bold. */
	:global(:root[data-theme='light']) .unknown,
	:global(:root[data-theme='light']) .paused {
		font-weight: 700;
	}
</style>
