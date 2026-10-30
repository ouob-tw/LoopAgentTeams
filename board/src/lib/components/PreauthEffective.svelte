<script lang="ts">
	// What is in effect once the two pre-authorization files are merged, each value with the layer it
	// comes from. The helper does the merging.
	import { PREAUTH_ACTIONS, effectiveRows, originText, type PreauthSettings } from '#lib/board/preauth.ts';

	let { settings }: { settings: PreauthSettings } = $props();
</script>

<section class="effective" aria-label="目前生效">
	<h3>目前生效</h3>
	{#each PREAUTH_ACTIONS as action (action.name)}
		<section aria-label={action.label}>
			<h4>{action.label}</h4>
			<dl>
				{#each effectiveRows(action.name, settings.effective.actions[action.name]) as row (row.label)}
					<div><dt>{row.label}</dt><dd>{row.text}</dd></div>
				{/each}
			</dl>
		</section>
	{/each}
	<section aria-label="參謀範圍">
		<h4>參謀範圍</h4>
		<dl>
			<div><dt>可自行定案</dt><dd class="lines">{originText(settings.effective.advisor.may_settle, '\n')}</dd></div>
			<div><dt>仍要問</dt><dd class="lines">{originText(settings.effective.advisor.must_ask, '\n')}</dd></div>
		</dl>
		{#if settings.project_advisor}<p class="note">專案檔的 [advisor] 不生效</p>{/if}
	</section>
</section>

<style>
	.effective {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		padding-bottom: 0.9rem;
		border-bottom: 1px solid var(--line);
	}
	h3 {
		margin: 0;
		font-size: max(1rem, var(--min-font, 0px));
	}
	h4 {
		margin: 0 0 0.2rem;
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	dl {
		margin: 0;
	}
	dl div {
		display: flex;
		gap: 0.6rem;
	}
	dt {
		flex: none;
		width: 5.5em;
		color: var(--muted);
	}
	dd {
		margin: 0;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.lines {
		white-space: pre-line;
	}
	dl,
	.note {
		font-size: max(0.85rem, var(--min-font, 0px));
	}
	.note {
		margin: 0.2rem 0 0;
		color: var(--warn);
	}
</style>
