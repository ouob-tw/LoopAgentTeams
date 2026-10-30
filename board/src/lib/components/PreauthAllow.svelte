<script lang="ts">
	// The choice of one action: joined buttons, the chosen one filled in the colour of what it means,
	// with a mark and a label so its colour is not all that says so.
	import { ALLOW_CHOICES, type AllowChoice } from '#lib/board/preauth.ts';

	let {
		label,
		value,
		choices = ALLOW_CHOICES.map((choice) => choice.value),
		onpick
	}: { label: string; value: AllowChoice; choices?: AllowChoice[]; onpick: (choice: AllowChoice) => void } = $props();
</script>

<div class="allow" role="group" aria-label={label}>
	{#each ALLOW_CHOICES.filter((choice) => choices.includes(choice.value)) as choice (choice.value)}
		<button class={choice.value} aria-pressed={value === choice.value} onclick={() => onpick(choice.value)}>
			<span class="mark" aria-hidden="true">{choice.mark}</span>{choice.label}
		</button>
	{/each}
</div>

<style>
	.allow {
		display: inline-flex;
	}
	button {
		padding: 0.2rem 0.5rem;
		font-size: max(0.85rem, var(--min-font, 0px));
		white-space: nowrap;
		border-radius: 0;
		margin-left: -1px;
	}
	button:first-child {
		margin-left: 0;
		border-radius: var(--radius) 0 0 var(--radius);
	}
	button:last-child {
		border-radius: 0 var(--radius) var(--radius) 0;
	}
	.mark {
		margin-right: 0.25em;
		color: var(--muted);
	}
	[aria-pressed='true'] .mark {
		color: inherit;
	}
	.allow[aria-pressed='true'] {
		background: var(--ok);
		border-color: var(--ok);
	}
	.ask[aria-pressed='true'] {
		background: var(--warn);
		border-color: var(--warn);
	}
	.inherit[aria-pressed='true'] {
		background: var(--inherit-bg);
		border-color: var(--inherit-bg);
		color: var(--inherit-text);
	}
</style>
