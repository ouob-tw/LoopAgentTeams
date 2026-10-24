<script module lang="ts">
	import type { AskPick } from '#lib/board/board-asks.ts';

	/** What the user picked and has not sent, by ask ID then question: kept while the page is open,
	 *  so it survives opening something else and a send that failed. */
	const picks = $state<Record<string, AskPick[]>>({});
	/** Asks someone else answered first, as this page was told when it sent: read-only, and saying
	 *  so, whatever the board's data says of them since. */
	const takenHere = $state<Record<string, boolean>>({});
</script>

<script lang="ts">
	// One board ask on its agent's page: the questions an agent's client asked through its menu,
	// answered here as in the terminal, with the options as the pending-question card shows them
	// (one or several to pick, or 其他 with text of one's own) but no note, which the client's answer
	// has no place for. All the questions are sent together. Once taken it is read-only, what was
	// picked marked among the options. Once the hook stopped waiting it still takes an answer, sent
	// to the agent as a message.
	import { ASK_TAKEN_REASON, askAnswerable, BOARD_ASK_STATE_TEXT, EMPTY_PICK, pickComplete, type AskAnswerResponse, type AskQuestion, type BoardAsk } from '#lib/board/board-asks.ts';
	import { request } from '#lib/board/api.ts';
	import { clock } from '#lib/board/clock.svelte.ts';
	import { noticeTime } from '#lib/board/format.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';

	let { ask }: { ask: BoardAsk } = $props();

	let sending = $state(false);
	/** The time, ticking each second while the ask waits, for what is left of the wait. */
	let now = $state(Date.now());
	$effect(() => {
		if (ask.state !== 'waiting') return;
		const timer = setInterval(() => (now = Date.now()), 1_000);
		return () => clearInterval(timer);
	});

	const answerable = $derived(askAnswerable(ask.state) && !takenHere[ask.id]);
	const pickOf = (index: number) => picks[ask.id]?.[index] ?? EMPTY_PICK;
	const complete = $derived(ask.questions.every((question, index) => pickComplete(question, pickOf(index))));
	const left = $derived(Math.max(0, Math.ceil((Date.parse(ask.deadlineAt) - now) / 1000)));
	const leftText = $derived(`${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`);

	function edit(index: number, change: Partial<AskPick>) {
		const current = picks[ask.id] ?? ask.questions.map(() => EMPTY_PICK);
		picks[ask.id] = current.map((pick, at) => (at === index ? { ...pick, ...change } : pick));
	}

	function choose(index: number, position: number, question: AskQuestion) {
		if (!question.multiSelect) return edit(index, { select: [position], other: false });
		const { select } = pickOf(index);
		edit(index, { select: select.includes(position) ? select.filter((chosen) => chosen !== position) : [...select, position] });
	}

	function chooseOther(index: number, question: AskQuestion) {
		edit(index, question.multiSelect ? { other: !pickOf(index).other } : { select: [], other: true });
	}

	async function submit() {
		if (sending || !complete) return;
		sending = true;
		const result = await request<AskAnswerResponse>('/api/asks/answer', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id: ask.id, picks: ask.questions.map((_, index) => pickOf(index)) })
		});
		sending = false;
		if (!result.ok && result.unpaired) return;
		const body = (result.ok ? result.value : result.body) as AskAnswerResponse | null | undefined;
		if (body?.status === 'accepted') {
			delete picks[ask.id];
			if (body.logError) toasts.show('failed', `答案已經送出，但送出紀錄寫入失敗：${body.logError}。`);
		} else if (body?.status === 'agent_gone') {
			delete picks[ask.id];
			toasts.show('failed', `沒有送出：${body.reason}`);
		} else if (body?.status === 'taken') {
			takenHere[ask.id] = true;
			toasts.show('info', `${body.reason}，你的答案沒有送出。`);
		} else if (body?.reason) {
			toasts.show('failed', `沒有送出：${body.reason}（你選的內容還在）`);
		} else {
			toasts.show('failed', '沒有收到看板伺服器的回應，不確定有沒有送出；請看卡片的狀態再決定要不要重送（你選的內容還在）。');
		}
	}
</script>

<article class="content" data-ask={ask.id} data-state={takenHere[ask.id] ? 'taken' : ask.state}>
	<header>
		<span class="label">看板提問</span>
		<span>{ask.questions.length > 1 ? `${ask.questions.length} 題` : '1 題'}</span>
		<time datetime={ask.createdAt}>{noticeTime(ask.createdAt, clock.now, clock.timeZone)}</time>
	</header>

	{#each ask.questions as question, index (index)}
		{@const pick = pickOf(index)}
		{@const answer = ask.answers?.[question.question]}
		{@const marked = ask.picks?.[index] ?? null}
		<section class="question" data-question={index}>
			<h2>
				{#if question.header}<span class="chip">{question.header}</span>{/if}
				{question.question}
				<small>{question.multiSelect ? '複選' : '單選'}</small>
			</h2>
			<ul class="options">
				{#each question.options as option, at (at)}
					{@const position = at + 1}
					{#if answerable}
						<li class:chosen={pick.select.includes(position)}>
							<label>
								<input
									type={question.multiSelect ? 'checkbox' : 'radio'}
									name="ask-{ask.id}-{index}"
									checked={pick.select.includes(position)}
									disabled={sending}
									onchange={() => choose(index, position, question)}
								/>
								{@render body(option.label, option.description)}
							</label>
						</li>
					{:else if marked?.select.includes(position)}
						<li class="picked"><span class="check" aria-label="你的答案">✓</span>{@render body(option.label, option.description)}</li>
					{:else}
						<li>{@render body(option.label, option.description)}</li>
					{/if}
				{/each}
				{#if answerable}
					<li class:chosen={pick.other}>
						<label>
							<input
								type={question.multiSelect ? 'checkbox' : 'radio'}
								name="ask-{ask.id}-{index}"
								checked={pick.other}
								disabled={sending}
								onchange={() => chooseOther(index, question)}
							/>
							<span class="option">其他</span>
						</label>
						{#if pick.other}
							<textarea
								rows="2"
								aria-label="其他的內容"
								placeholder="其他：請寫下你的答案"
								disabled={sending}
								bind:value={() => pick.text, (text) => edit(index, { text })}
							></textarea>
						{/if}
					</li>
				{:else if marked?.other}
					<li class="picked"><span class="check" aria-label="你的答案">✓</span><span class="option text">其他：{marked.text.trim()}</span></li>
				{:else if !marked && answer !== undefined}
					<!-- Taken without the picks it came from: the answer as the client got it. -->
					<li class="picked"><span class="check" aria-label="你的答案">✓</span><span class="option text">{answer}</span></li>
				{/if}
			</ul>
		</section>
	{/each}

	{#if answerable}
		<form
			class="actions"
			onsubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<button class="primary" disabled={sending || !complete}>{sending ? '送出中…' : '送出答案'}</button>
			{#if ask.state === 'waiting'}
				<span class="state" role="timer">剩 {leftText}{ask.questions.length > 1 && !complete ? '・每一題都要作答' : ''}</span>
			{:else}
				<span class="state" role="status">{BOARD_ASK_STATE_TEXT[ask.state]}{ask.questions.length > 1 && !complete ? '・每一題都要作答' : ''}</span>
			{/if}
		</form>
	{:else}
		<p class="state" role="status">{takenHere[ask.id] ? `${ASK_TAKEN_REASON}${ask.state === 'filled' || ask.state === 'relayed' ? `・${BOARD_ASK_STATE_TEXT[ask.state]}` : ''}` : BOARD_ASK_STATE_TEXT[ask.state]}</p>
	{/if}
</article>

{#snippet body(label: string, description: string | undefined)}
	<div>
		<span class="option">{label}</span>
		{#if description}<div class="impact">{description}</div>{/if}
	</div>
{/snippet}

<style>
	.content {
		background: var(--surface);
		border: 1px solid var(--line);
		border-left: 3px solid var(--warn);
		border-radius: var(--radius);
		padding: 0.9rem 1rem;
	}
	.content:not([data-state='waiting'], [data-state='timed_out']) {
		border-left-color: var(--ok);
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
	time {
		margin-left: auto;
	}
	h2 {
		margin: 0.4rem 0 0.5rem;
		font-size: max(1.05rem, var(--min-font, 0px));
		overflow-wrap: anywhere;
	}
	h2 small {
		margin-left: 0.4rem;
		font-size: max(0.75rem, var(--min-font, 0px));
		font-weight: 400;
		color: var(--muted);
	}
	.chip {
		margin-right: 0.4rem;
		padding: 0 0.4rem;
		border: 1px solid var(--accent);
		border-radius: var(--radius-pill);
		font-size: max(0.7rem, var(--min-font, 0px));
		font-weight: 400;
		color: var(--accent);
		white-space: nowrap;
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
	.option {
		overflow-wrap: anywhere;
	}
	.impact {
		margin: 0.15rem 0 0;
		font-size: max(0.85rem, var(--min-font, 0px));
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		align-items: center;
		font-size: max(0.85rem, var(--min-font, 0px));
	}
	.state {
		margin: 0;
		font-size: max(0.85rem, var(--min-font, 0px));
		color: var(--muted);
	}
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
	}

	/* Light theme, as the pending-question card: a chosen option stands out by its frame and bold text. */
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
</style>
