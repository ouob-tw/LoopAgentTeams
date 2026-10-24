<script module lang="ts">
	/** The deny reasons written and not sent, by ask ID: kept while the page is open, so they survive
	 *  opening something else and a send that failed. */
	const reasons = $state<Record<string, string>>({});
	/** Asks someone else answered first, as this page was told when it sent. */
	const takenHere = $state<Record<string, boolean>>({});
</script>

<script lang="ts">
	// One permission request of Claude or Codex on its agent's page: the tool and what it would run
	// or change (in a fixed-width font, folded when long), 允許 and 拒絕 with an optional reason.
	// Once Claude's wait ran out it still takes an answer, sent to it as a message; Codex's request
	// handed back to its terminal, or one answered in Claude's terminal, is read-only and says why.
	import { request } from '#lib/board/api.ts';
	import {
		ASK_TAKEN_REASON,
		askAnswerable,
		BOARD_ASK_STATE_TEXT,
		NOT_ADOPTED_NOTE,
		PERMISSION_DECISION_TEXT,
		permissionText,
		RESEND_NOTE,
		TURN_ENDED_NOTE,
		type AskAnswerResponse,
		type BoardAsk,
		type PermissionDecision
	} from '#lib/board/board-asks.ts';
	import { clock } from '#lib/board/clock.svelte.ts';
	import { noticeTime } from '#lib/board/format.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';

	let { ask }: { ask: BoardAsk } = $props();

	/** Longer than this, the content is folded until opened. */
	const FOLD_LINES = 12;
	const FOLD_CHARS = 800;

	let sending = $state(false);
	let unfolded = $state(false);
	let now = $state(Date.now());
	$effect(() => {
		if (ask.state !== 'waiting') return;
		const timer = setInterval(() => (now = Date.now()), 1_000);
		return () => clearInterval(timer);
	});

	const input = $derived(ask.toolInput ?? {});
	const content = $derived(permissionText(input));
	const description = $derived(typeof input.description === 'string' && typeof input.command === 'string' ? input.description : null);
	const long = $derived(content.split('\n').length > FOLD_LINES || content.length > FOLD_CHARS);
	const answerable = $derived(askAnswerable(ask.state) && !takenHere[ask.id]);
	const left = $derived(Math.max(0, Math.ceil((Date.parse(ask.deadlineAt) - now) / 1000)));
	const leftText = $derived(`${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`);

	/** The card's state line once it takes no answer: what came of it, and the answer given. */
	const stateText = $derived.by(() => {
		if (takenHere[ask.id]) return ASK_TAKEN_REASON;
		const said = BOARD_ASK_STATE_TEXT[ask.state];
		const picked = ask.decision ? PERMISSION_DECISION_TEXT[ask.decision] : null;
		if (ask.state === 'terminal') return `${said}：${ask.actual ? PERMISSION_DECISION_TEXT[ask.actual] : ''}${ask.notAdopted ? `・${NOT_ADOPTED_NOTE}（你選了${picked}）` : ''}`;
		if (ask.state === 'filled' && picked) return `${said}：${picked}`;
		if (ask.state === 'sent' && picked) return `已送出：${picked}・等確認 Claude 採用的結果`;
		return picked && ask.state !== 'allowed_waiting' ? `${said}・你的答案：${picked}` : said;
	});

	/** Send the decision, or with `resend` the message already taken again. */
	async function submit(decision: PermissionDecision | null) {
		if (sending) return;
		sending = true;
		const result = await request<AskAnswerResponse>(decision ? '/api/asks/answer' : '/api/asks/resend', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(decision ? { id: ask.id, decision, reason: decision === 'deny' ? (reasons[ask.id] ?? '') : '' } : { id: ask.id })
		});
		sending = false;
		if (!result.ok && result.unpaired) return;
		const body = (result.ok ? result.value : result.body) as AskAnswerResponse | null | undefined;
		if (body?.status === 'accepted') {
			delete reasons[ask.id];
			if (body.logError) toasts.show('failed', `答案已經送出，但送出紀錄寫入失敗：${body.logError}。`);
		} else if (body?.status === 'agent_gone') {
			delete reasons[ask.id];
			toasts.show('failed', `沒有送出：${body.reason}`);
		} else if (body?.status === 'taken') {
			takenHere[ask.id] = true;
			toasts.show('info', `${body.reason}，你的答案沒有送出。`);
		} else if (body?.reason) {
			toasts.show('failed', `沒有送出：${body.reason}（你寫的理由還在）`);
		} else {
			toasts.show('failed', '沒有收到看板伺服器的回應，不確定有沒有送出；請看卡片的狀態再決定要不要重送（你寫的理由還在）。');
		}
	}
</script>

<article class="content" data-ask={ask.id} data-kind="permission" data-state={takenHere[ask.id] ? 'taken' : ask.state}>
	<header>
		<span class="label">權限確認</span>
		<span class="tool">{ask.tool}</span>
		<time datetime={ask.createdAt}>{noticeTime(ask.createdAt, clock.now, clock.timeZone)}</time>
	</header>

	{#if ask.turnEnded && (answerable || ask.state === 'allowed_waiting')}
		<p class="note" role="note">{TURN_ENDED_NOTE}</p>
	{/if}
	{#if description}<p class="description">{description}</p>{/if}
	<pre class="input" class:folded={long && !unfolded}>{content}</pre>
	{#if long}
		<button class="fold" type="button" aria-expanded={unfolded} onclick={() => (unfolded = !unfolded)}>{unfolded ? '收起' : '展開全部'}</button>
	{/if}

	{#if answerable}
		<textarea rows="2" aria-label="拒絕理由" placeholder="拒絕理由（選填，拒絕時會告訴它）" disabled={sending} bind:value={() => reasons[ask.id] ?? '', (text) => (reasons[ask.id] = text)}></textarea>
		<div class="actions">
			<button class="primary" disabled={sending} onclick={() => submit('allow')}>允許</button>
			<button disabled={sending} onclick={() => submit('deny')}>拒絕</button>
			{#if ask.state === 'waiting'}
				<span class="state" role="timer">{sending ? '送出中…' : `剩 ${leftText}`}</span>
			{:else}
				<span class="state" role="status">{sending ? '送出中…' : BOARD_ASK_STATE_TEXT[ask.state]}</span>
			{/if}
		</div>
	{:else if ask.state === 'relay_unknown' && !takenHere[ask.id]}
		<div class="actions">
			<button class="primary" disabled={sending} onclick={() => submit(null)}>{sending ? '送出中…' : '再送一次'}</button>
			<span class="state" role="status">{BOARD_ASK_STATE_TEXT.relay_unknown}・{RESEND_NOTE}</span>
		</div>
	{:else}
		<p class="state" role="status">{stateText}</p>
		{#if ask.decision === 'deny' && ask.reason}<p class="reason">理由：{ask.reason}</p>{/if}
	{/if}
</article>

<style>
	.content {
		background: var(--surface);
		border: 1px solid var(--line);
		border-left: 3px solid var(--warn);
		border-radius: var(--radius);
		padding: 0.9rem 1rem;
	}
	.content:not([data-state='waiting'], [data-state='timed_out'], [data-state='relay_unknown'], [data-state='allowed_waiting']) {
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
	.tool {
		font-family: var(--mono);
		color: var(--text);
		overflow-wrap: anywhere;
	}
	time {
		margin-left: auto;
	}
	.note {
		margin: 0.5rem 0 0;
		padding: 0.4rem 0.6rem;
		border: 1px solid var(--warn);
		border-radius: var(--radius);
		font-size: max(0.85rem, var(--min-font, 0px));
	}
	.description {
		margin: 0.5rem 0 0;
		overflow-wrap: anywhere;
	}
	.input {
		margin: 0.5rem 0 0;
		padding: 0.5rem 0.6rem;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		font-family: var(--mono);
		font-size: max(0.85rem, var(--min-font, 0px));
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.input.folded {
		max-height: 14em;
		overflow: hidden;
	}
	.fold {
		margin-top: 0.3rem;
		padding: 0;
		background: none;
		border: none;
		color: var(--accent);
		font: inherit;
		font-size: max(0.85rem, var(--min-font, 0px));
		cursor: pointer;
	}
	textarea {
		display: block;
		width: 100%;
		margin-top: 0.7rem;
		background: var(--bg);
		color: inherit;
		font: inherit;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: 0.5rem 0.6rem;
		resize: vertical;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		align-items: center;
		margin-top: 0.6rem;
		font-size: max(0.85rem, var(--min-font, 0px));
	}
	.state,
	.reason {
		margin: 0.6rem 0 0;
		font-size: max(0.85rem, var(--min-font, 0px));
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.actions .state {
		margin: 0;
	}
</style>
