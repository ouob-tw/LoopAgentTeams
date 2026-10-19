<script lang="ts">
	// Whether hcom reaches an agent, as a small badge: an icon of its own for each state (linked,
	// not linked, not known), so it reads without its colour; the words in its tooltip and label.
	import CircleQuestionMark from '@lucide/svelte/icons/circle-question-mark';
	import Link from '@lucide/svelte/icons/link';
	import Unlink from '@lucide/svelte/icons/unlink';
	import { AGENT_HCOM_LABEL, type AgentHcom } from '#lib/board/types.ts';

	let { hcom }: { hcom: AgentHcom } = $props();

	const ICON = { linked: Link, none: Unlink, unknown: CircleQuestionMark };
	const Icon = $derived(ICON[hcom]);
</script>

<span class="hcom {hcom}" role="img" title={AGENT_HCOM_LABEL[hcom]} aria-label={AGENT_HCOM_LABEL[hcom]}
	><Icon size="1em" aria-hidden="true" /><span aria-hidden="true">HCOM</span></span
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
	.unknown {
		color: var(--warn);
	}
	/* Hue alone may not show on e-ink: the states that need a look are also bold. */
	:global(:root[data-theme='light']) .unknown {
		font-weight: 700;
	}
</style>
