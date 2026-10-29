<script lang="ts">
	// The full content of one inbox item. A question that is still waiting can be answered here; one
	// that is answered is read-only, its choice marked among its options and the note under them.
	import { lastSegment } from '#lib/board/agents.ts';
	import { ANSWER_STATE_TEXT, chosenIn } from '#lib/board/answers.ts';
	import { answering, complete } from '#lib/board/answering.svelte.ts';
	import { clock } from '#lib/board/clock.svelte.ts';
	import { noticeTime } from '#lib/board/format.ts';
	import { renderLinks, renderMarkdown } from '#lib/board/markdown.ts';
	import CopyButton from './CopyButton.svelte';
	import { toasts } from '#lib/board/toasts.svelte.ts';
	import type { Translation } from '#lib/board/translate.ts';
	import { isAnswered, itemLabel, type HelperOption, type InboxItem } from '#lib/board/types.ts';

	let {
		item: current,
		listed,
		recorded = false,
		handle,
		translation = null,
		onunread,
		onread
	}: {
		item: InboxItem;
		/** False once the page lists the item nowhere, in the inbox or among the processed items: a
		 *  question that is gone. */
		listed: boolean;
		/** The question left the inbox because its controller recorded the answer. */
		recorded?: boolean;
		/** The controller's name, shown before the time where the item stands among its messages. */
		handle?: string;
		/** A report's message translated, as Transcript has it: shown in place of the message. */
		translation?: Translation | null;
		onunread: (key: string) => Promise<void>;
		/** Given where opening the report does not read it: an unread report offers to be marked read. */
		onread?: (key: string) => Promise<void>;
	} = $props();

	let showOriginal = $state(false);

	const KIND_TEXT = { single: '單選', multi: '複選', text: '純文字' };

	// Once an item is listed nowhere the page only has it as it was when opened; what is shown is
	// the last version that was listed, so a sent answer stays on screen after it is recorded.
	// svelte-ignore state_referenced_locally
	let lastListed = $state.raw(current);
	$effect.pre(() => {
		if (listed) lastListed = current;
	});
	const item = $derived(listed ? current : lastListed);

	let marking = $state(false);

	async function mark(change: (key: string) => Promise<void>) {
		marking = true;
		try {
			await change(item.key);
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
	const answerable = $derived(item.kind === 'question' && listed && item.unsent);
	/** The answer to show on a question that can no longer be answered: as its data has it, or as
	 *  it was sent from this page when the data does not carry it yet. */
	const shownAnswer = $derived.by(() => {
		if (item.kind !== 'question') return null;
		if (!item.unsent && item.question.answer) return { answer: item.question.answer, note: item.question.note };
		return !answerable && submitted ? { answer: submitted.answer, note: submitted.note } : null;
	});
	/** The answer is settled: sent from here or elsewhere, answered, or recorded. A question gone
	 *  from the page with no answer sent is not. */
	const decided = $derived(item.kind === 'question' && !answerable && (isAnswered(item) || recorded || !item.unsent || !!submitted));
	const chosen = $derived(item.kind === 'question' && shownAnswer ? chosenIn(item.question, shownAnswer.answer) : null);

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

	// The question changed under the draft: it moves to the version on screen at once, so the next
	// choice and send are for that version and do not have to be refused first.
	$effect(() => {
		if (item.kind === 'question' && listed && item.unsent && answering.rebase(item)) {
			toasts.show('failed', '主控改了這一題，畫面上是新版本；已清掉你選的選項，請重新選擇（你打的文字和備註還在）。');
		}
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
			toasts.show('failed', result.reason ?? '主控已停用 LAT 或已關閉，沒有送出。');
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

{#snippet check()}<span class="check" aria-label="你的答覆">✓</span>{/snippet}

{#snippet pickedText(text: string)}
	<li class="picked">{@render check()}<span class="option text">{text}</span></li>
{/snippet}

{#snippet optionBody(option: HelperOption)}
	<span class="letter">{option.letter}</span>
	<div>
		<span class="option">{option.label}</span>
		{#if option.recommended}<em>建議</em>{/if}
		{#if option.impact}<div class="impact md">{@html renderMarkdown(option.impact)}</div>{/if}
	</div>
{/snippet}

<article class="content" data-kind={item.kind} data-decided={decided || undefined} data-content={item.key}>
	{#if item.kind !== 'question' && item.message}<CopyButton text={item.message} />{/if}
	<header>
		<span class="label" class:open={answerable}>{itemLabel(item)}</span>
		{#if item.kind === 'question'}
			<span class="id">{item.question.id} r{item.question.revision}</span>
			<span>{KIND_TEXT[item.question.kind] ?? item.question.kind}</span>
		{/if}
		{#if handle}<span class="handle" title="@{handle}">@{lastSegment(handle)}</span>{/if}
		<time datetime={item.time}>{noticeTime(item.time, clock.now, clock.timeZone)}</time>
	</header>
	<h2>{@html item.title ? renderLinks(item.title) : '（沒有標題）'}</h2>

	{#if item.kind === 'question'}
		{@const question = item.question}
		{@const single = question.kind === 'single'}
		{@const choice = question.kind !== 'text'}
		{#if recorded && !isAnswered(item)}
			<p class="notice recorded" role="status">✓ {ANSWER_STATE_TEXT.recorded}：主控已記錄這一題的答覆。</p>
		{:else if !listed}
			<p class="notice" role="status">這一題已經不在待辦：主控已停用 LAT 或已關閉，或題目已被移除。不能再作答。</p>
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
					{:else if chosen?.select.includes(position)}
						<li class="picked">{@render check()}{@render optionBody(option)}</li>
					{:else}
						<li>{@render optionBody(option)}</li>
					{/if}
				{/each}
				{#if chosen?.other}
					{@render pickedText(`其他：${chosen.other}`)}
				{/if}
				{#each chosen?.unknown ?? [] as part, index (index)}
					{@render pickedText(part)}
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
		{#if chosen && !choice}
			<ul class="options">
				{@render pickedText(chosen.other)}
			</ul>
		{/if}
		{#if shownAnswer?.note}
			<p class="your-note text">你的備註：{shownAnswer.note}</p>
		{/if}
		{#if question.recommendation}
			<section class="recommendation">
				<h3>推薦</h3>
				<div class="text md">{@html renderMarkdown(question.recommendation)}</div>
			</section>
		{/if}
		{#if question.details}
			<div class="text md">{@html renderMarkdown(question.details)}</div>
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
		{:else if listed && !isAnswered(item)}
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
	{:else}
		{#if translation?.status === 'done'}
			<div class="text message md" lang="zh-Hant-TW">{@html renderMarkdown(translation.text)}</div>
			<button class="original-toggle" aria-expanded={showOriginal} onclick={() => (showOriginal = !showOriginal)}>{showOriginal ? '收起原文' : '看原文'}</button>
			{#if showOriginal}<div class="text message md original" lang="en">{@html renderMarkdown(item.message)}</div>{/if}
		{:else if item.message}
			{#if translation?.status === 'pending'}<p class="state" role="status">翻譯中</p>{/if}
			<div class="text message md">{@html renderMarkdown(item.message)}</div>
			{#if translation?.status === 'failed'}<p class="state">翻譯失敗，顯示原文（{translation.reason}）</p>{/if}
		{:else}
			<p class="text message">（這筆回報沒有內容）</p>
		{/if}
		<footer>
			{#if item.archived}
				<span class="state">已封存{item.readAt ? `，${noticeTime(item.readAt, clock.now, clock.timeZone)} 標為已讀` : ''}</span>
			{:else if item.readAt}
				<span class="state">已讀（{noticeTime(item.readAt, clock.now, clock.timeZone)}）</span>
				<button onclick={() => mark(onunread)} disabled={marking}>標為未讀</button>
			{:else}
				<span class="state">未讀</span>
				{#if onread}<button onclick={() => mark(onread)} disabled={marking}>標為已讀</button>{/if}
			{/if}
		</footer>
	{/if}
</article>

<style>
	.content {
		position: relative;
		background: var(--surface);
		border: 1px solid var(--line);
		border-left: 3px solid var(--ok);
		border-radius: var(--radius);
		padding: 0.9rem 1rem;
	}
	.content[data-kind='question'] {
		border-left-color: var(--warn);
	}
	.content[data-kind='question'][data-decided] {
		border-left-color: var(--line);
	}
	header {
		padding-right: 1.6rem;
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
	/* A question that can still be answered: filled like its label in the inbox list. */
	.label.open {
		border-color: transparent;
		background: var(--warn);
		color: var(--bg);
	}
	.id {
		font-family: var(--mono);
	}
	time,
	.handle {
		margin-left: auto;
	}
	.handle {
		overflow-wrap: anywhere;
	}
	.handle + time {
		margin-left: 0;
	}
	h2 {
		margin: 0.4rem 0 0.5rem;
		font-size: max(1.1rem, var(--min-font, 0px));
		overflow-wrap: anywhere;
	}
	/* Like the links in markdown. */
	h2 :global(a) {
		color: var(--accent);
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
	.original-toggle {
		padding: 0.1rem 0;
		border: 0;
		background: none;
		color: var(--muted);
		font: inherit;
		font-size: max(0.8rem, var(--min-font, 0px));
		cursor: pointer;
	}
	.original {
		margin-top: 0.3rem;
		padding-left: 0.6rem;
		border-left: 2px solid var(--line);
		color: var(--muted);
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
	/* The answer's choice: framed and marked in the accent colour, among the options. */
	.options li.picked {
		border: 2px solid var(--accent);
		padding: calc(0.5rem - 1px) calc(0.7rem - 1px);
		background: color-mix(in srgb, var(--accent) 10%, transparent);
	}
	.check {
		flex: none;
		font-weight: 700;
		color: var(--accent);
	}
	.options .option.text {
		flex: 1;
		min-width: 0;
		margin: 0;
	}
	.your-note {
		padding: 0.4rem 0.7rem;
		border-radius: var(--radius);
		background: color-mix(in srgb, var(--text) 6%, transparent);
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
	:global(:root[data-theme='light']) .options li.picked {
		border: 3px solid var(--text);
		padding: calc(0.5rem - 2px) calc(0.7rem - 2px);
		background: none;
	}
	:global(:root[data-theme='light']) .options li.picked .option,
	:global(:root[data-theme='light']) .check {
		font-weight: 700;
		color: var(--text);
	}
	:global(:root[data-theme='light']) .label.open {
		border-color: var(--warn);
		font-weight: 600;
	}
	/* The answered option's own line, letter and text, is black on white; its description below
	   keeps the heavy frame. */
	:global(:root[data-theme='light']) .options li.picked {
		gap: 0;
	}
	:global(:root[data-theme='light']) .options li.picked :is(.check, .letter, .option) {
		padding: 0 0.35rem;
		background: var(--text);
		color: var(--bg);
	}
	:global(:root[data-theme='light']) .your-note {
		border: 1px solid var(--line);
		background: none;
	}
</style>
