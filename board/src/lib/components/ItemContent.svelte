<script lang="ts">
	// The full content of one inbox item. A question that is still waiting can be answered here.
	import { ANSWER_STATE_TEXT } from '#lib/board/answers.ts';
	import { answering, complete, outdated } from '#lib/board/answering.svelte.ts';
	import { formatTime } from '#lib/board/format.ts';
	import { renderMarkdown } from '#lib/board/markdown.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';
	import { itemLabel, type HelperOption, type InboxItem } from '#lib/board/types.ts';

	let {
		item: current,
		inInbox,
		recorded = false,
		onread
	}: {
		item: InboxItem;
		/** False once the item has left the inbox: an archived report, or a question that is gone. */
		inInbox: boolean;
		/** The question left the inbox because its controller recorded the answer. */
		recorded?: boolean;
		onread: (key: string) => Promise<void>;
	} = $props();

	const KIND_TEXT = { single: '單選', multi: '複選', text: '純文字' };

	// Once an item has left the inbox the page only has it as it was when opened; what is shown is
	// the last version that was in the inbox, so a sent answer stays on screen after it is recorded.
	// svelte-ignore state_referenced_locally
	let lastListed = $state.raw(current);
	$effect.pre(() => {
		if (inInbox) lastListed = current;
	});
	const item = $derived(inInbox ? current : lastListed);

	let marking = $state(false);

	async function read() {
		marking = true;
		try {
			await onread(item.key);
		} catch {
			toasts.show('failed', '沒有標記成功，請再試一次。');
		} finally {
			marking = false;
		}
	}

	const draft = $derived(answering.draft(item.key));
	const submitted = $derived(answering.submitted[item.key]);
	const notice = $derived(answering.notifyResults[item.key]);
	const sending = $derived(answering.sending[item.key] ?? false);
	const notifying = $derived(answering.notifying[item.key] ?? false);

	function choose(position: number, single: boolean) {
		if (item.kind !== 'question') return;
		if (single) return answering.edit(item, { select: [position], other: false });
		const select = draft.select.includes(position)
			? draft.select.filter((chosen) => chosen !== position)
			: [...draft.select, position];
		answering.edit(item, { select });
	}

	function chooseOther(single: boolean) {
		if (item.kind !== 'question') return;
		answering.edit(item, single ? { select: [], other: true } : { other: !draft.other });
	}

	// A floating notice while the draft is for an older version, so the form does not move.
	$effect(() => {
		const key = `outdated:${item.key}`;
		const stale = item.kind === 'question' && inInbox && item.unsent && outdated(item.question, draft);
		toasts.stand(key, 'failed', stale ? '主控在你作答途中改了這一題，畫面上是目前的版本。你填的是舊版的答覆，送出會被拒絕；請對照後重新作答。' : null);
		return () => toasts.stand(key, 'failed', null);
	});

	async function submit() {
		if (item.kind !== 'question') return;
		const key = item.key;
		await answering.submit(item);
		const result = answering.outcomes[key];
		const logError = answering.submitted[key]?.logError;
		if (logError) toasts.show('failed', `答覆已經送出，但送出紀錄寫入失敗：${logError}。看板的送出紀錄裡不會有這一筆。`);
		if (result?.status === 'question_changed') {
			toasts.show('failed', '題目已變更，剛才的答覆沒有送出。畫面上是目前的版本，請確認後重新作答。');
		} else if (result?.status === 'not_pending') {
			toasts.show('info', '這一題已經送出過答覆（例如在 Herdr 待答面板），不能再作答。');
		} else if (result?.status === 'invalid_answer') {
			toasts.show('failed', `答覆不符合這一題的格式，沒有送出：${result.reason}（你填的內容還在）`);
		} else if (result?.status === 'error') {
			toasts.show('failed', `送出失敗：${result.reason}（你填的內容還在；這一題目前的狀態以畫面為準，重送前請先確認）`);
		} else if (result?.status === 'unknown') {
			toasts.show('failed', '沒有收到看板伺服器的回應，不確定有沒有送出；請按「重新整理」確認這一題的狀態（你填的內容還在）。');
		} else if (result?.status === 'ended') {
			toasts.show('failed', result.reason ?? '主控已結束，沒有送出。');
		}
	}

	async function notify() {
		if (item.kind !== 'question') return;
		const key = item.key;
		const wasFailed = !!answering.submitted[key]?.notifyFailed;
		await answering.notify(item);
		const result = answering.notifyResults[key];
		if (result?.status === 'delivered') toasts.show('ok', '通知已送達主控。');
		else if (result?.status === 'no_pending') {
			toasts.show('info', `沒有待送的通知。${wasFailed ? '這不代表主控已經收到，請在聊天告訴主控。' : ''}`);
		} else if (result?.status === 'failed') toasts.show('failed', `仍未送達：${result.reason}`);
		else if (result?.status === 'unknown') toasts.show('failed', '沒有收到看板伺服器的回應，不確定有沒有通知到。');
		else if (result) toasts.show('failed', `沒有通知：${result.reason}`);
	}
</script>

{#snippet optionBody(option: HelperOption)}
	<span class="letter">{option.letter}</span>
	<div>
		<span class="option">{option.label}</span>
		{#if option.recommended}<em>建議</em>{/if}
		{#if option.impact}<p class="impact">{option.impact}</p>{/if}
	</div>
{/snippet}

<article class="content" data-kind={item.kind} data-content={item.key}>
	<header>
		<span class="label">{itemLabel(item)}</span>
		{#if item.kind === 'question'}
			<span class="id">{item.question.id} r{item.question.revision}</span>
			<span>{KIND_TEXT[item.question.kind] ?? item.question.kind}</span>
		{/if}
		<time datetime={item.time}>{formatTime(item.time)}</time>
	</header>
	<h2>{item.title || '（沒有標題）'}</h2>

	{#if item.kind === 'question'}
		{@const question = item.question}
		{@const answerable = inInbox && item.unsent}
		{@const single = question.kind === 'single'}
		{@const choice = question.kind !== 'text'}
		{#if recorded}
			<p class="notice recorded" role="status">✓ {ANSWER_STATE_TEXT.recorded}：主控已記錄這一題的答覆。</p>
		{:else if !inInbox}
			<p class="notice" role="status">這一題已經不在信箱：主控已結束，或題目已被移除。不能再作答。</p>
		{/if}
		{#if question.context}
			<div class="text md">{@html renderMarkdown(question.context)}</div>
		{/if}
		{#if question.options.length}
			<ul class="options">
				{#each question.options as option, index (index)}
					{@const position = index + 1}
					{#if answerable && choice}
						<li class:chosen={draft.select.includes(position)}>
							<label>
								<input
									type={single ? 'radio' : 'checkbox'}
									name="answer-{item.key}"
									checked={draft.select.includes(position)}
									disabled={sending}
									onchange={() => choose(position, single)}
								/>
								{@render optionBody(option)}
							</label>
						</li>
					{:else}
						<li>{@render optionBody(option)}</li>
					{/if}
				{/each}
				{#if answerable && choice}
					<li class:chosen={draft.other}>
						<label>
							<input
								type={single ? 'radio' : 'checkbox'}
								name="answer-{item.key}"
								checked={draft.other}
								disabled={sending}
								onchange={() => chooseOther(single)}
							/>
							<span class="option">其他</span>
						</label>
						{#if draft.other}
							<textarea
								rows="2"
								aria-label="其他的內容"
								placeholder="其他：請寫下你的答覆"
								disabled={sending}
								bind:value={() => draft.text, (text) => answering.edit(item, { text })}
							></textarea>
						{/if}
					</li>
				{/if}
			</ul>
		{/if}
		{#if question.recommendation}
			<section class="recommendation">
				<h3>推薦</h3>
				<div class="text md">{@html renderMarkdown(question.recommendation)}</div>
			</section>
		{/if}

		{#if answerable}
			<form
				class="answer"
				onsubmit={(event) => {
					event.preventDefault();
					submit();
				}}
			>
				{#if !choice}
					<label class="field">
						<span>答覆</span>
						<textarea
							rows="3"
							disabled={sending}
							bind:value={() => draft.text, (text) => answering.edit(item, { text })}
						></textarea>
					</label>
				{/if}
				<label class="field">
					<span>備註（可不填）</span>
					<textarea
						rows="2"
						disabled={sending}
						bind:value={() => draft.note, (note) => answering.edit(item, { note })}
					></textarea>
				</label>
				<div class="actions">
					<button class="primary" disabled={sending || !complete(question, draft)}>{sending ? '送出中…' : '送出答覆'}</button>
				</div>
			</form>
		{:else if inInbox}
			{#if item.notifyFailed || submitted?.notifyFailed}
				<p class="state failed" role="alert">
					已送出，但通知主控失敗{submitted?.notifyFailed && submitted.reason ? `：${submitted.reason}` : ''}。{item.notifyFailed
						? '答覆已經寫入，主控還不知道。'
						: '答覆已經寫入；看板的資料裡沒有等待重送的通知，可能已經由別處補送。不確定主控是否知道時，請在聊天告訴主控。'}
				</p>
			{:else}
				<p class="state">{ANSWER_STATE_TEXT.waiting}。</p>
			{/if}
			{#if item.notifyFailed || submitted?.notifyFailed || notice}
				<div class="actions">
					<button onclick={notify} disabled={notifying}>{notifying ? '通知中…' : '重新通知'}</button>
				</div>
			{/if}
		{/if}
		{#if !item.unsent && question.answer}
			{@render answered(question.answer, question.note)}
		{:else if !answerable && submitted}
			{@render answered(submitted.answer, submitted.note)}
		{/if}
	{:else}
		{#if item.message}
			<div class="text message md">{@html renderMarkdown(item.message)}</div>
		{:else}
			<p class="text message">（這筆回報沒有內容）</p>
		{/if}
		<footer>
			{#if !inInbox}
				<span class="state">已封存{item.readAt ? `，${formatTime(item.readAt)} 標為已讀` : ''}</span>
			{:else if item.readAt}
				<span class="state">已讀（{formatTime(item.readAt)}）</span>
			{:else}
				<button class="primary" onclick={read} disabled={marking}>標為已讀</button>
			{/if}
		</footer>
	{/if}
</article>

{#snippet answered(answer: string, note: string)}
	<dl>
		<dt>答覆</dt>
		<dd class="text">{answer}</dd>
		{#if note}
			<dt>備註</dt>
			<dd class="text">{note}</dd>
		{/if}
	</dl>
{/snippet}

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
		font-size: max(0.75rem, var(--min-font, 0px));
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
		font-size: max(1.1rem, var(--min-font, 0px));
		overflow-wrap: anywhere;
	}
	h3 {
		margin: 0 0 0.2rem;
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.text {
		margin: 0 0 0.7rem;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	/* Markdown already turned the line breaks into elements. */
	.text.md {
		white-space: normal;
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
		flex-wrap: wrap;
		gap: 0.7rem;
		padding: 0.5rem 0.7rem;
		border: 1px solid var(--line);
		border-radius: var(--radius);
	}
	.options li.chosen {
		border: 2px solid var(--selected-bg);
		padding: calc(0.5rem - 1px) calc(0.7rem - 1px);
	}
	.options label {
		flex: 1;
		display: flex;
		gap: 0.7rem;
		align-items: baseline;
		min-width: 0;
		cursor: pointer;
	}
	.options input {
		flex: none;
		margin: 0;
	}
	textarea {
		display: block;
		width: 100%;
		background: var(--bg);
		color: inherit;
		font: inherit;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: 0.5rem 0.6rem;
		resize: vertical;
	}
	.answer {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.field textarea {
		font-size: max(1rem, var(--min-font, 0px));
		color: var(--text);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		align-items: center;
		margin-top: 0.4rem;
		font-size: max(0.85rem, var(--min-font, 0px));
		overflow-wrap: anywhere;
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
		font-size: max(0.7rem, var(--min-font, 0px));
		font-style: normal;
		color: var(--accent);
		white-space: nowrap;
	}
	.impact {
		margin: 0.15rem 0 0;
		font-size: max(0.85rem, var(--min-font, 0px));
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
		font-size: max(0.85rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.notice {
		margin: 0 0 0.7rem;
		padding: 0.4rem 0.7rem;
		border: 1px solid var(--line);
		border-radius: var(--radius);
	}
	.notice.recorded {
		border-color: var(--ok);
	}
	.state.failed {
		border-color: var(--danger);
		color: var(--danger);
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
		font-size: max(0.85rem, var(--min-font, 0px));
	}

	/* Light theme: solid borders only, and a chosen option stands out without colour, by its
	   heavy frame and bold text next to the filled radio or checkbox mark. */
	:global(:root[data-theme='light']) .recommendation {
		border-style: solid;
	}
	:global(:root[data-theme='light']) .options li.chosen {
		border-width: 3px;
		padding: calc(0.5rem - 2px) calc(0.7rem - 2px);
	}
	:global(:root[data-theme='light']) .options li.chosen .option {
		font-weight: 700;
	}
</style>
