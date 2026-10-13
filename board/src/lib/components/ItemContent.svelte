<script lang="ts">
	// The full content of one inbox item. Questions are shown read-only here.
	import { formatTime } from '#lib/board/format.ts';
	import { itemLabel, type InboxItem } from '#lib/board/types.ts';

	let {
		item,
		inInbox,
		onread
	}: {
		item: InboxItem;
		/** False once the item has left the inbox: an archived report, or a question that is gone. */
		inInbox: boolean;
		onread: (key: string) => Promise<void>;
	} = $props();

	const KIND_TEXT = { single: '單選', multi: '複選', text: '純文字' };

	let marking = $state(false);
	let failed = $state(false);

	async function read() {
		marking = true;
		failed = false;
		try {
			await onread(item.key);
		} catch {
			failed = true;
		} finally {
			marking = false;
		}
	}
</script>

<article class="content" data-kind={item.kind} data-content={item.key}>
	<header>
		<span class="label">{itemLabel(item)}</span>
		{#if item.kind === 'question'}
			<span class="id">{item.question.id} r{item.question.revision}</span>
			<span>{KIND_TEXT[item.question.kind] ?? item.question.kind}</span>
		{/if}
		<time>{formatTime(item.time)}</time>
	</header>
	<h2>{item.title || '（沒有標題）'}</h2>

	{#if item.kind === 'question'}
		{@const question = item.question}
		{#if !inInbox}
			<p class="notice" role="status">這一題已經不在信箱：主控已記錄答覆，或主控已結束。</p>
		{/if}
		{#if question.context}
			<p class="text">{question.context}</p>
		{/if}
		{#if question.options.length}
			<ul class="options">
				{#each question.options as option (option.letter)}
					<li>
						<span class="letter">{option.letter}</span>
						<div>
							<span class="option">{option.label}</span>
							{#if option.recommended}<em>建議</em>{/if}
							{#if option.impact}<p class="impact">{option.impact}</p>{/if}
						</div>
					</li>
				{/each}
			</ul>
		{/if}
		{#if question.recommendation}
			<section class="recommendation">
				<h3>推薦</h3>
				<p class="text">{question.recommendation}</p>
			</section>
		{/if}
		{#if inInbox}
			<p class="state">{item.unsent ? '還沒回答。' : '已送出，等主控記錄。'}</p>
		{/if}
		{#if !item.unsent && question.answer}
			<dl>
				<dt>答覆</dt>
				<dd class="text">{question.answer}</dd>
				{#if question.note}
					<dt>備註</dt>
					<dd class="text">{question.note}</dd>
				{/if}
			</dl>
		{/if}
	{:else}
		<p class="text message">{item.message || '（這筆回報沒有內容）'}</p>
		<footer>
			{#if !inInbox}
				<span class="state">已封存{item.readAt ? `，${formatTime(item.readAt)} 標為已讀` : ''}</span>
			{:else if item.readAt}
				<span class="state">已讀（{formatTime(item.readAt)}）</span>
			{:else}
				<button class="primary" onclick={read} disabled={marking}>標為已讀</button>
				{#if failed}<span class="failed" role="alert">沒有標記成功，請再試一次。</span>{/if}
			{/if}
		</footer>
	{/if}
</article>

<style>
	.content {
		background: var(--surface);
		border: 1px solid var(--line);
		border-left: 3px solid var(--ok);
		border-radius: var(--radius);
		padding: 0.9rem 1rem;
	}
	.content[data-kind='question'] {
		border-left-color: var(--warn);
	}
	header {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		align-items: baseline;
		font-size: 0.75rem;
		color: var(--muted);
	}
	.label {
		padding: 0.05rem 0.45rem;
		border: 1px solid var(--line);
		border-radius: var(--radius-pill);
		color: var(--text);
	}
	.id {
		font-family: var(--mono);
	}
	time {
		margin-left: auto;
	}
	h2 {
		margin: 0.4rem 0 0.5rem;
		font-size: 1.1rem;
		overflow-wrap: anywhere;
	}
	h3 {
		margin: 0 0 0.2rem;
		font-size: 0.8rem;
		color: var(--muted);
	}
	.text {
		margin: 0 0 0.7rem;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.options {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		margin: 0 0 0.8rem;
		padding: 0;
		list-style: none;
	}
	.options li {
		display: flex;
		gap: 0.7rem;
		padding: 0.5rem 0.7rem;
		border: 1px solid var(--line);
		border-radius: var(--radius);
	}
	.letter {
		font-family: var(--mono);
		font-weight: 700;
	}
	.option {
		overflow-wrap: anywhere;
	}
	em {
		margin-left: 0.4rem;
		padding: 0 0.4rem;
		border: 1px solid var(--accent);
		border-radius: var(--radius-pill);
		font-size: 0.7rem;
		font-style: normal;
		color: var(--accent);
		white-space: nowrap;
	}
	.impact {
		margin: 0.15rem 0 0;
		font-size: 0.85rem;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.recommendation {
		margin-bottom: 0.7rem;
		padding: 0.5rem 0.7rem;
		border: 1px dashed var(--line);
		border-radius: var(--radius);
	}
	.recommendation .text {
		margin: 0;
	}
	.state {
		margin: 0;
		font-size: 0.85rem;
		color: var(--muted);
	}
	.notice {
		margin: 0 0 0.7rem;
		padding: 0.4rem 0.7rem;
		border: 1px solid var(--line);
		border-radius: var(--radius);
	}
	dl {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.2rem 1rem;
		margin: 0.6rem 0 0;
	}
	dt {
		color: var(--muted);
	}
	dd {
		margin: 0;
	}
	footer {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		align-items: center;
	}
	.failed {
		color: var(--danger);
		font-size: 0.85rem;
	}
</style>
