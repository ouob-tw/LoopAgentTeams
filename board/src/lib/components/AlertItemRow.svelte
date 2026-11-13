<script lang="ts">
	// One automation red card in the 待辦 list: a red edge and label, the task with how it ended,
	// and under it 自動化 and when, in Asia/Taipei like every automation time, whatever the host's zone.
	import { clock } from '#lib/board/clock.svelte.ts';
	import { noticeTime } from '#lib/board/format.ts';
	import { ALERT_KIND_TEXT, type AutomationAlert } from '#lib/board/alerts.ts';
	import { TIME_ZONE } from '#lib/board/automation.ts';

	let { alert, current = false, onopen }: { alert: AutomationAlert; current?: boolean; onopen: (alert: AutomationAlert) => void } = $props();

	const at = $derived(new Date(alert.updatedAt ?? alert.createdAt).toISOString());
</script>

<div class="row" class:current data-item="alert:{alert.id}" data-alert-row={alert.id} data-kind={alert.kind}>
	<button class="main" aria-current={current ? 'true' : undefined} onclick={() => onopen(alert)}>
		<span class="clamp">
			<span class="kind">{ALERT_KIND_TEXT[alert.kind]}</span>
			<span class="title">{alert.taskName}：{alert.summary}</span>
		</span>
	</button>
	<div class="under">
		<span>自動化</span>
		<time datetime={at}>{noticeTime(at, clock.now, TIME_ZONE)}</time>
	</div>
</div>

<style>
	.row {
		position: relative;
		padding: 0.5rem 0.6rem 0.5rem 0.9rem;
		border: 1px solid var(--line);
		border-left: 6px solid var(--danger);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		line-height: 1.6;
	}
	.row.current,
	.row:has(.main:focus-visible) {
		border-color: var(--danger);
		outline: 1px solid var(--danger);
		outline-offset: -2px;
	}
	.main {
		display: block;
		width: 100%;
		padding: 0;
		background: none;
		border: 0;
		text-align: left;
	}
	.main:focus-visible {
		outline: 2px solid transparent;
	}
	.clamp {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
		overflow-wrap: anywhere;
	}
	.kind {
		display: inline-block;
		margin-right: 0.5rem;
		padding: 0 0.45rem;
		border-radius: var(--radius-pill);
		background: var(--danger);
		color: var(--bg);
		font-weight: 700;
		white-space: nowrap;
	}
	.title {
		font-weight: 700;
	}
	.under {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 0.2rem 0.6rem;
		margin-top: 0.2rem;
		color: var(--muted);
		white-space: nowrap;
	}
	:global(:root[data-theme='light']) .row.current {
		outline-width: 2px;
	}
</style>
