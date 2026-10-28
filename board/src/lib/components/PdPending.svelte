<script lang="ts">
	// The pd 待核准 section above the inbox: one card per request pd's daemon holds for approval,
	// with what it asks for and the time it has left. 核准 only opens the request's own page on pd's
	// passkey site in a new tab, where the device's own unlock approves it; the board has no way to
	// approve and never asks for a code. 拒絕 denies it through the board at once, as `pd deny` does
	// without a code. With nothing waiting, or pd missing or down, one quiet line says so.
	import { request } from '#lib/board/api.ts';
	import { timeText, type PdRequest, type PdSnapshot } from '#lib/board/pd.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';

	let { pd }: { pd: { snapshot: PdSnapshot; at: number } | null } = $props();

	const requests = $derived(pd?.snapshot.ok ? pd.snapshot.requests : []);
	let now = $state(Date.now());
	$effect(() => {
		if (!requests.length) return;
		const timer = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(timer);
	});
	/** The requests being denied, by number. */
	let denying = $state<number[]>([]);

	async function deny(item: PdRequest) {
		denying = [...denying, item.id];
		const result = await request<{ ok: true }>('/api/pd/deny', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id: item.id })
		});
		denying = denying.filter((id) => id !== item.id);
		if (result.ok) return toasts.show('ok', `已拒絕 pd 請求 #${item.id}（${item.item}）`);
		if (result.unpaired) return;
		const said = (result.body as { error?: unknown } | undefined)?.error;
		toasts.show('failed', typeof said === 'string' ? said : '沒有拒絕成功：看板沒有回應，請稍後再試。');
	}
</script>

{#if pd}
	<section class="pd" aria-label="pd 待核准">
		{#if !pd.snapshot.ok}
			<p class="quiet">pd 待核准：{pd.snapshot.reason}</p>
		{:else if !requests.length}
			<p class="quiet">pd 目前沒有待核准的請求</p>
		{:else}
			<h2>pd 待核准 <span class="count">（{requests.length}）</span></h2>
			<ul class="cards">
				{#each requests as item (item.id)}
					{@const time = timeText(item, now - pd.at)}
					<li class="card" data-pd-request={item.id}>
						<p class="head">
							<span class="item">{item.item}</span>
							<span class="number">#{item.id}</span>
							<span class="time" class:low={time.low} role="timer">{time.text}</span>
						</p>
						<dl>
							<dt>欄位</dt>
							<dd>{item.fields.join('、')}</dd>
							<dt>指令</dt>
							<dd><code>{item.command.join(' ')}</code></dd>
							<dt>工作目錄</dt>
							<dd><code>{item.cwd}</code></dd>
							<dt>呼叫者</dt>
							<dd>{item.caller}（對方自稱，未驗證）</dd>
						</dl>
						<p class="actions">
							{#if item.approvalUrl}
								<a class="approve" href={item.approvalUrl} target="_blank" rel="noopener noreferrer">核准</a>
							{:else}
								<span class="quiet">pd 沒有給核准頁連結</span>
							{/if}
							<button type="button" class="deny" disabled={denying.includes(item.id)} onclick={() => void deny(item)}
								>{denying.includes(item.id) ? '拒絕中…' : '拒絕'}</button
							>
						</p>
					</li>
				{/each}
			</ul>
			<p class="quiet">核准會在新分頁開啟 pd 的 passkey 核准頁，用這台裝置的解鎖驗證；看板本身不能核准。</p>
		{/if}
	</section>
{/if}

<style>
	.pd {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		min-width: 0;
		margin-bottom: 0.8rem;
	}
	h2 {
		margin: 0;
		font-size: max(0.95rem, var(--min-font, 0px));
	}
	.count,
	.quiet,
	.number {
		color: var(--muted);
		font-weight: 400;
	}
	.quiet {
		margin: 0;
		font-size: max(0.8rem, var(--min-font, 0px));
	}
	.cards {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}
	.card {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		min-width: 0;
		padding: 0.55rem 0.65rem;
		border: 1px solid var(--line);
		border-left: 3px solid var(--warn);
		border-radius: var(--radius);
		background: var(--surface);
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.2rem 0.6rem;
		margin: 0;
	}
	.item {
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.number {
		font-size: max(0.75rem, var(--min-font, 0px));
	}
	.time {
		margin-left: auto;
		font-family: var(--mono);
		font-size: max(0.85rem, var(--min-font, 0px));
	}
	.time.low {
		color: var(--danger);
	}
	dl {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 0.2rem 0.8rem;
		margin: 0;
		font-size: max(0.9rem, var(--min-font, 0px));
	}
	dt {
		color: var(--muted);
	}
	dd {
		margin: 0;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	code {
		font-family: var(--mono);
		font-size: 0.9em;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem;
		margin: 0;
	}
	/* A link drawn as the board's main button: it opens pd's page, it does not approve here. */
	.approve {
		padding: 0.5rem 0.8rem;
		border: 1px solid var(--accent);
		border-radius: var(--radius);
		background: var(--accent);
		color: var(--bg);
		font-weight: 600;
		text-decoration: none;
	}
	.deny {
		border-color: var(--danger);
		color: var(--danger);
	}
	@media (max-width: 480px) {
		dl {
			grid-template-columns: 1fr;
		}
		dt:not(:first-child) {
			margin-top: 0.3rem;
		}
		.time {
			margin-left: 0;
		}
		.actions > * {
			flex: 1;
			text-align: center;
		}
	}
</style>
