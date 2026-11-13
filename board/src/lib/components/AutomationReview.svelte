<script lang="ts">
	// The checking agent's part of one run: while it checks, how long and a link to its live screen;
	// once it judged, its conclusion and each checklist item with ✓ or ✕ and why; when it ended
	// without a verdict, why. Its conversation is linked like a task's agent's.
	import type { RunReview } from '#lib/board/automation.ts';

	let { review, now, limitMinutes, onopenagent }: { review: RunReview; now: number; limitMinutes: number; onopenagent: (sessionId: string) => void } = $props();

	const passed = $derived((review.items ?? []).filter((item) => item.ok).length);
	const open = (event: MouseEvent) => {
		event.preventDefault();
		onopenagent(review.sessionId!);
	};
</script>

<div class="review" data-review={review.status}>
	{#if review.status === 'checking'}
		<b>檢查官正在檢查</b>
		<p>已檢查 {Math.max(0, Math.floor((now - review.startedAt) / 60_000))} 分鐘，上限 {limitMinutes} 分鐘</p>
	{:else if review.status === 'pass'}
		<b>檢查官的結論：通過（{passed} 條都過）</b>
	{:else if review.status === 'fail'}
		<b class="bad">檢查官的結論：沒過</b>
		{#if review.reason}<p class="bad">{review.reason}</p>{/if}
	{:else}
		<b class="bad">檢查沒有做完</b>
		{#if review.reason}<p>{review.reason}</p>{/if}
	{/if}
	{#if review.items?.length && review.status !== 'pass'}
		<ul>
			{#each review.items as item, index (index)}
				<li class:failed={!item.ok}><b aria-label={item.ok ? '通過' : '沒過'}>{item.ok ? '✓' : '✕'}</b><span>{item.label}{item.reason ? `：${item.reason}` : ''}</span></li>
			{/each}
		</ul>
	{:else if review.items?.length}
		<details>
			<summary>看逐條理由</summary>
			<ul>
				{#each review.items as item, index (index)}
					<li><b aria-label="通過">✓</b><span>{item.label}{item.reason ? `：${item.reason}` : ''}</span></li>
				{/each}
			</ul>
		</details>
	{/if}
	{#each review.accountSwitches ?? [] as note, index (index)}
		<p class="hint">檢查官換帳號：{note}</p>
	{/each}
	{#if review.closeError}
		<p class="bad">{review.closeError}</p>
	{/if}
	{#if review.sessionId}
		<a href={`?agent=${encodeURIComponent(review.sessionId)}`} onclick={open}>{review.status === 'checking' ? '打開檢查官看即時畫面' : '看檢查官的紀錄'} ›</a>
	{/if}
	{#if review.status === 'checking'}
		<p class="hint">{review.agentName ? `它也出現在 Herdr 分頁（@${review.agentName}），只讀不改，檢查完會自動關掉。` : '檢查官正在開啟…'}</p>
	{/if}
</div>

<style>
	.review {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		margin-top: 0.3rem;
		min-width: 0;
	}
	p {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.bad,
	li.failed {
		color: var(--danger);
	}
	.hint {
		color: var(--muted);
	}
	ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	li {
		display: flex;
		gap: 0.5rem;
		overflow-wrap: anywhere;
	}
	li b {
		flex: none;
		width: 1.2rem;
	}
	li span {
		min-width: 0;
		/* A full-width ）at a line's end keeps its whole width, so it never sticks out past the box. */
		text-spacing-trim: space-all;
	}
	a {
		align-self: flex-start;
		min-height: 44px;
		display: inline-flex;
		align-items: center;
		color: var(--accent);
		font-weight: 700;
	}
	summary {
		min-height: 44px;
		display: flex;
		align-items: center;
		color: var(--accent);
		cursor: pointer;
	}
</style>
