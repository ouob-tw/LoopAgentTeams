<script lang="ts">
	// What the user sent to this controller from the board, on any logged-in device: messages typed
	// into its client, answers to its questions, the launch that started it, and its wakes.
	import { ANSWER_STATE_TEXT } from '#lib/board/answers.ts';
	import { formatTime } from '#lib/board/format.ts';
	import { CLIENT_LABEL, LAUNCH_STATE_TEXT, latCommand } from '#lib/board/launch.ts';
	import { messaging } from '#lib/board/messaging.svelte.ts';
	import type { Controller } from '#lib/board/types.ts';
	import { RESUME_CLOSE_TEXT, RESUME_OVERDUE_TEXT, wakeText } from '#lib/board/wake.ts';

	let { controller }: { controller: Controller } = $props();

	const entries = $derived(messaging.sent[controller.id]);
	// Each new board data hands this component a new `controller` object, so the log is read again
	// then: that is when an answer goes from sent to recorded.
	$effect(() => void messaging.load(controller.id));
</script>

<section class="sent">
	<h3>你傳給 @{controller.hcomName} 的訊息與答覆</h3>
	{#if messaging.loadFailed[controller.id]}
		<p class="failed" role="alert">送出紀錄讀取失敗。</p>
	{/if}
	{#if messaging.logError[controller.id]}
		<p class="failed" role="alert">
			送出紀錄寫入失敗，答覆的狀態可能不是最新的：{messaging.logError[controller.id]}
		</p>
	{/if}
	{#if entries?.length}
		<ol>
			{#each entries as entry (entry.id)}
				<li data-kind={entry.kind}>
					{#if entry.kind === 'answer'}
						<p class="meta">
							<time datetime={entry.time}>{formatTime(entry.time)}</time>
							<span>答覆 {entry.questionId} r{entry.revision}</span>
							<span class:failed={entry.state !== 'waiting' && entry.state !== 'recorded'}>
								{entry.state === 'recorded' ? '✓ ' : ''}{ANSWER_STATE_TEXT[entry.state]}
							</span>
						</p>
						<p class="title">{entry.title || '（沒有標題）'}</p>
						<p class="text">{entry.answer}</p>
						{#if entry.note}<p class="text note">備註：{entry.note}</p>{/if}
					{:else if entry.kind === 'launch'}
						<p class="meta">
							<time datetime={entry.time}>{formatTime(entry.time)}</time>
							<span>從看板新建（{CLIENT_LABEL[entry.client]}）</span>
							<span>✓ {LAUNCH_STATE_TEXT.active}</span>
						</p>
						<p class="title">{entry.folder}</p>
						<p class="text">{latCommand(entry.client, entry.text)}</p>
					{:else if entry.kind === 'wake'}
						<p class="meta">
							<time datetime={entry.time}>{formatTime(entry.time)}</time>
							<span>
								喚醒{entry.route === 'inject' ? '（輸入框）' : entry.route === 'resume' ? `（接回${entry.herdrWorkspaceLabel ? `，Herdr 工作區 ${entry.herdrWorkspaceLabel}` : ''}）` : ''}
							</span>
							{#if entry.outcome === 'failed' || entry.outcome === 'refused'}
								<span class="failed">✗ {entry.outcome === 'refused' ? entry.error : `沒有送達：${entry.error}`}</span>
							{:else}
								<span>✓ {wakeText(entry)}</span>
							{/if}
							{#if entry.closed}
								<span>{RESUME_CLOSE_TEXT[entry.closed]}</span>
							{:else if entry.overdue}
								<span class="failed">{RESUME_OVERDUE_TEXT}</span>
							{/if}
						</p>
						<p class="text">{entry.text}</p>
					{:else}
						<p class="meta">
							<time datetime={entry.time}>{formatTime(entry.time)}</time>
							{#if entry.ok}
								<span>✓ 已送出</span>
							{:else}
								<span class="failed">✗ 沒有送達：{entry.error}</span>
							{/if}
						</p>
						<p class="text">{entry.text}</p>
					{/if}
				</li>
			{/each}
		</ol>
	{:else if entries}
		<p class="empty">還沒有傳過訊息或答覆。</p>
	{/if}
</section>

<style>
	.sent {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	h3 {
		margin: 0;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--muted);
	}
	ol {
		display: grid;
		gap: 0.5rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	li {
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: 0.5rem 0.7rem;
	}
	p {
		margin: 0;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.2rem 0.8rem;
		font-size: 0.75rem;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.text {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.title {
		font-size: 0.85rem;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.note {
		font-size: 0.85rem;
		color: var(--muted);
	}
	.failed {
		color: var(--danger);
	}
	.empty {
		font-size: 0.85rem;
		color: var(--muted);
	}
</style>
