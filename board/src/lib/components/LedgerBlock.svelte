<script lang="ts">
	// A controller's work ledger: one line per ticket (its link and title, the progress strip,
	// what it is doing now, what each stage ran on, its time), opened to show the rows that make
	// it up with their evidence. In a narrow panel each line becomes a card read top to bottom.
	// No ledger, or one that cannot be read, says so here only.
	import { clock } from '#lib/board/clock.svelte.ts';
	import { noticeTime } from '#lib/board/format.ts';
	import { countsText, lateText, minutesText, rowMinutes, ticketTime, type LedgerRow, type LedgerView } from '#lib/board/ledger.ts';

	let { ledger }: { ledger: LedgerView } = $props();

	/** Today's times without the date, as the notices show them. */
	const time = (iso: string | null) => (iso ? noticeTime(iso, clock.now, clock.timeZone) : '—');
	const STEP_WORDS: Record<string, string> = { done: '完成', active: '進行中', pending: '還沒到', skipped: '跳過' };
	const MARKS: Record<string, string> = { done: '✓', active: '●', pending: '○', skipped: '—' };

	const rows = $derived(ledger.state === 'ok' ? new Map(ledger.items.map((row) => [row.id, row])) : new Map<number, LedgerRow>());
	const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
	const rowTime = (row: LedgerRow) => {
		// Counted to the read, as lat-ledger counts the ticket's time.
		const read = ledger.state === 'ok' && ledger.readAt ? Date.parse(ledger.readAt) : clock.now;
		const spent = rowMinutes(row, read);
		return spent === null ? '' : minutesText(spent);
	};
</script>

<section class="ledger" aria-label="工作總表">
	{#if ledger.state === 'none'}
		<p class="note">尚無總表</p>
	{:else if ledger.state === 'error'}
		<p class="error">總表讀不出來：{ledger.reason}</p>
	{:else}
		<!-- Its tab names it, so the counts and when it was updated head it. -->
		<p class="summary">
			{#if ledger.tickets.length}<span class="counts">{countsText(ledger)}</span>{/if}
			{#if ledger.updatedAt}<span class="updated">更新於 {time(ledger.updatedAt)}</span>{/if}
		</p>
		{#if !ledger.tickets.length}
			<p class="note">總表還沒有工作項</p>
		{:else}
			<ul class="tickets">
				{#each ledger.tickets as ticket (ticket.key)}
					{@const ticketRows = ticket.rows.flatMap((id) => rows.get(id) ?? [])}
					{@const late = ticketRows.some((row) => row.late.estimate !== undefined)}
					<li class="ticket" data-state={ticket.state} class:late>
						<details>
							<summary>
								<span class="ref">
									{#if ticket.href}<a href={ticket.href} target="_blank" rel="noopener noreferrer">{ticket.ref}</a>{:else}<b>{ticket.ref}</b>{/if}
									{#if ticket.title}<span class="title">{ticket.title}</span>{/if}
								</span>
								<ol class="steps">
									{#each ticket.steps as step (step.key)}
										<li class="step" data-step={step.state} title="{step.label}：{STEP_WORDS[step.state]}"><span class="mark" aria-hidden="true">{MARKS[step.state]}</span>{step.label}</li>
									{/each}
								</ol>
								<span class="now">{ticket.now}</span>
								<span class="models">
									{#each ticket.settings as stage (stage.label)}<span class="model"><span class="stage">{stage.label}</span> {stage.text}</span>{/each}
								</span>
								<!-- #549 adds the findings per stage as a cell here. -->
								<span class="time">{ticketTime(ticket)}</span>
							</summary>
							<ul class="rows">
								{#each ticketRows as row (row.id)}
									{@const rowLate = lateText(row.late)}
									{@const spent = rowTime(row)}
									{@const open = !['done', 'cancelled'].includes(row.statusKey)}
									{@const hasEvidence = row.evidence.commits.length + row.evidence.files.length + row.evidence.gates.length > 0}
									<li class="row" data-status={row.statusKey} class:late={rowLate !== ''}>
										<dl>
											<dt>#</dt><dd data-label="#">{row.id}</dd>
											<dt>階段</dt><dd data-label="階段">{row.stage}</dd>
											<dt>負責</dt><dd data-label="負責">{row.agent ?? '未派'}</dd>
											{#if row.settings}<dt>模型・思考程度</dt><dd data-label="模型・思考程度">{row.settings}</dd>{/if}
											<dt>狀態</dt>
											<dd data-label="狀態">
												{row.status}{#if row.statusKey === 'blocked' && row.blockedReason}<span class="reason">：{row.blockedReason}</span>{/if}{#if row.statusKey === 'cancelled' && row.cancelReason}<span class="reason">：{row.cancelReason}</span>{/if}{#if rowLate}<span class="lateness">（{rowLate}）</span>{/if}
											</dd>
											{#if spent || (open && row.estimate)}
												<dt>用時</dt>
												<dd data-label="用時">{spent}{#if open && row.estimate}<span class="estimate">預計 {time(row.estimate)}</span>{/if}</dd>
											{/if}
											{#if row.progress}<dt>最新進度</dt><dd data-label="最新進度">{row.progress}</dd>{/if}
											{#if hasEvidence}
												<dt>證據</dt>
												<dd data-label="證據" class="evidence">
													{#each row.evidence.commits as commit (commit.text)}
														{#if commit.href}<a href={commit.href} target="_blank" rel="noopener noreferrer" title={commit.text}>{commit.text.slice(0, 8)}</a>{:else}<code title={commit.text}>{commit.text.slice(0, 8)}</code>{/if}
													{/each}
													{#each row.evidence.files as file (file.text)}
														{#if file.href}<a href={file.href} target="_blank" rel="noopener" title={file.text}>{fileName(file.text)}</a>{:else}<span title={file.text}>{fileName(file.text)}</span>{/if}
													{/each}
													{#each row.evidence.gates as gate (gate)}<code title="測試紀錄 {gate}">測試 {gate.slice(0, 8)}</code>{/each}
												</dd>
											{/if}
										</dl>
									</li>
								{/each}
							</ul>
						</details>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</section>

<style>
	.ledger {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		min-width: 0;
		container-type: inline-size;
		font-size: max(0.85rem, var(--min-font, 0px));
	}
	.summary {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1rem;
	}
	.updated,
	.note {
		font-weight: normal;
		color: var(--muted);
	}
	.summary,
	.note,
	.error {
		margin: 0;
	}
	.error {
		color: var(--danger);
		overflow-wrap: anywhere;
	}

	/* A ticket line in the board's panel (at most about 740px wide): the ticket and its time on
	   top, the strip beside what it is doing now and its models. Narrow (a phone): a card read top
	   to bottom. */
	summary {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		grid-template-areas: 'ref ref time' 'steps now now' 'steps models models';
		gap: 0.25rem 0.75rem;
		align-items: start;
		padding: 0.35rem 0.5rem 0.35rem 1.4rem;
	}
	.ref {
		grid-area: ref;
	}
	.steps {
		grid-area: steps;
	}
	.now {
		grid-area: now;
	}
	.models {
		grid-area: models;
	}
	.time {
		grid-area: time;
		text-align: right;
	}
	.tickets {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}
	.ticket {
		border-bottom: 1px solid var(--line);
		border-left: 3px solid transparent;
	}
	/* A blocked ticket and one past its estimate stand out by their edge, and say why in words. */
	.ticket[data-state='blocked'] {
		border-left-color: var(--warn);
	}
	.ticket.late {
		border-left-color: var(--danger);
	}
	summary {
		position: relative;
		cursor: pointer;
		list-style: none;
	}
	summary::-webkit-details-marker {
		display: none;
	}
	summary::before {
		content: '▸';
		position: absolute;
		left: 0.4rem;
		top: 0.35rem;
		color: var(--muted);
	}
	details[open] > summary::before {
		content: '▾';
	}
	summary:hover {
		background: var(--surface);
	}
	.ref,
	.now,
	.models,
	.time {
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.ref a,
	.ref b {
		margin-right: 0.35rem;
	}
	.models {
		display: flex;
		flex-direction: column;
	}
	.stage {
		color: var(--muted);
	}
	.time {
		color: var(--muted);
	}

	/* The progress strip: done ticked, active a solid dot, not reached hollow, skipped struck. */
	.steps {
		display: flex;
		flex-wrap: nowrap;
		gap: 0.2rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.step {
		display: inline-flex;
		align-items: center;
		gap: 0.1rem;
		padding: 0 0.3rem;
		border: 1px solid var(--line);
		border-radius: var(--radius-pill, 999px);
		white-space: nowrap;
	}
	.step[data-step='done'] {
		border-color: var(--ok);
		color: var(--ok);
	}
	.step[data-step='active'] {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--bg);
	}
	.step[data-step='pending'] {
		color: var(--muted);
		border-style: dashed;
	}
	.step[data-step='skipped'] {
		color: var(--muted);
		text-decoration: line-through;
		opacity: 0.7;
	}

	/* An opened ticket's rows, each a block of labelled lines. */
	.rows {
		list-style: none;
		margin: 0 0.5rem 0.5rem 1.4rem;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.row {
		border: 1px solid var(--line);
		padding: 0.25rem 0.5rem;
	}
	dl {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 0.1rem 0.75rem;
		margin: 0;
	}
	dt {
		color: var(--muted);
	}
	dd {
		margin: 0;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.reason,
	.lateness {
		color: var(--danger);
	}
	.estimate {
		display: block;
		color: var(--muted);
	}
	.evidence > * {
		margin-right: 0.5rem;
		white-space: nowrap;
	}
	.row.late {
		border-color: var(--danger);
	}

	/* Narrow: each ticket a card read top to bottom. */
	@container (max-width: 519px) {
		summary {
			grid-template-columns: minmax(0, 1fr);
			grid-template-areas: 'ref' 'steps' 'now' 'models' 'time';
			gap: 0.3rem;
		}
		.time {
			text-align: left;
		}
		.steps {
			flex-wrap: wrap;
			gap: 0.15rem;
		}
		.step {
			padding: 0 0.2rem;
		}
	}
</style>
