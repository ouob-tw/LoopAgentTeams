<script lang="ts">
	// What the user sent to this controller from the board, on any logged-in device: messages typed
	// into its client, answers to its questions, the launch that started it, its wakes and its
	// model switches.
	import { ANSWER_STATE_TEXT } from '#lib/board/answers.ts';
	import { formatTime } from '#lib/board/format.ts';
	import { CLIENT_LABEL, LAUNCH_STATE_TEXT, latCommand } from '#lib/board/launch.ts';
	import { messaging } from '#lib/board/messaging.svelte.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';
	import { choiceText, settingsText, SWITCH_STATE_TEXT } from '#lib/board/models.ts';
	import type { Controller } from '#lib/board/types.ts';
	import { RESUME_CLOSE_TEXT, RESUME_OVERDUE_TEXT, wakeText } from '#lib/board/wake.ts';

	let { controller }: { controller: Controller } = $props();

	const entries = $derived(messaging.sent[controller.id]);
	// Each new board data hands this component a new `controller` object, so the log is read again
	// then: that is when an answer goes from sent to recorded.
	$effect(() => void messaging.load(controller.id));

	// Shown while the problem lasts, without pushing the log down.
	$effect(() => {
		const id = controller.id;
		toasts.stand(`sent-read:${id}`, 'failed', messaging.loadFailed[id] ? `@${controller.hcomName} 的送出紀錄讀取失敗。` : null);
		const logError = messaging.logError[id];
		toasts.stand(`sent-write:${id}`, 'failed', logError ? `送出紀錄寫入失敗，答覆的狀態可能不是最新的：${logError}` : null);
		return () => {
			toasts.stand(`sent-read:${id}`, 'failed', null);
			toasts.stand(`sent-write:${id}`, 'failed', null);
		};
	});
</script>

<section class="sent">
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
						{#if entry.model || entry.effort}
							<p class="title">模型 {entry.model ?? 'client 預設'}・思考強度 {entry.effort ?? 'client 預設'}</p>
						{/if}
						<p class="text">{latCommand(entry.client, entry.text)}</p>
					{:else if entry.kind === 'switch'}
						<p class="meta">
							<time datetime={entry.time}>{formatTime(entry.time)}</time>
							<span>切換模型與思考強度{entry.route === 'restart' ? '（停止再接回）' : entry.route === 'inject' ? '（輸入框）' : ''}</span>
							{#if entry.state === 'refused' || entry.state === 'failed'}
								<span class="failed">✗ {entry.error}</span>
							{:else}
								<span class:failed={entry.open && entry.state !== 'resuming'}>{entry.open ? '' : '✓ '}{SWITCH_STATE_TEXT[entry.state]}</span>
							{/if}
						</p>
						<p class="text">改為 {choiceText(entry.to)}</p>
						{#if entry.from}<p class="title">切換前 {settingsText(entry.from)}</p>{/if}
						{#if entry.open && entry.error}<p class="title failed">{entry.error}</p>{/if}
					{:else if entry.kind === 'wake'}
						<p class="meta">
							<time datetime={entry.time}>{formatTime(entry.time)}</time>
							<span>
								{entry.switchId ? '切換模型時接回' : '喚醒'}{entry.route === 'inject' ? '（輸入框）' : entry.route === 'resume' ? `（接回${entry.herdrWorkspaceLabel ? `，Herdr 工作區 ${entry.herdrWorkspaceLabel}` : ''}）` : ''}
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
						{#if entry.text}<p class="text">{entry.text}</p>{/if}
						{#if entry.choice && (entry.choice.model || entry.choice.effort)}
							<p class="title">{choiceText(entry.choice)}{entry.carriedEffort ? `（思考強度沿用 ${entry.carriedEffort}）` : ''}</p>
						{/if}
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
		font-size: max(0.75rem, var(--min-font, 0px));
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.text {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.title {
		font-size: max(0.85rem, var(--min-font, 0px));
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.note {
		font-size: max(0.85rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.failed {
		color: var(--danger);
	}
	.empty {
		font-size: max(0.85rem, var(--min-font, 0px));
		color: var(--muted);
	}
</style>
