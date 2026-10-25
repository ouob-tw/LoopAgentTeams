<script lang="ts">
	// A controller's work ledger: one row per item with its status and how late it is first, so a
	// phone shows them without scrolling, then its stage, agent and times; a late row marked. No
	// ledger, or one that cannot be read, says so here only.
	import { clock } from '#lib/board/clock.svelte.ts';
	import { noticeTime } from '#lib/board/format.ts';
	import { lateText, type LedgerView } from '#lib/board/ledger.ts';

	let { ledger }: { ledger: LedgerView } = $props();

	/** Today's times without the date, as the notices show them. */
	const time = (iso: string | null) => (iso ? noticeTime(iso, clock.now, clock.timeZone) : '—');
</script>

<section class="ledger" aria-label="工作總表">
	<!-- Its tab names it, so only when it was updated heads it. -->
	{#if ledger.state === 'ok' && ledger.updatedAt}<p class="updated">更新於 {time(ledger.updatedAt)}</p>{/if}
	{#if ledger.state === 'none'}
		<p class="note">尚無總表</p>
	{:else if ledger.state === 'error'}
		<p class="error">總表讀不出來：{ledger.reason}</p>
	{:else if !ledger.items.length}
		<p class="note">總表還沒有工作項</p>
	{:else}
		<div class="scroll">
			<table>
				<thead>
					<tr><th>#</th><th>票號</th><th>狀態</th><th>遲到</th><th>階段</th><th>負責</th><th>預計完成</th><th>最晚期限</th><th>最後更新</th></tr>
				</thead>
				<tbody>
					{#each ledger.items as row (row.id)}
						{@const late = lateText(row.late)}
						<tr class:late={late !== ''}>
							<td>{row.id}</td>
							<td>{row.ticket}</td>
							<td>{row.status}</td>
							<td class="lateness">{#if late}<b>遲到</b> {late}{:else}—{/if}</td>
							<td>{row.stage}</td>
							<td>{row.agent ?? '未派'}</td>
							<td>{time(row.estimate)}</td>
							<td>{time(row.deadline)}</td>
							<td>{time(row.updatedAt)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<style>
	.ledger {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		min-width: 0;
	}
	.updated,
	.note {
		font-weight: normal;
		font-size: max(0.85rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.updated,
	.note,
	.error {
		margin: 0;
	}
	.error {
		color: var(--danger);
		overflow-wrap: anywhere;
	}
	/* Wide tables scroll inside the block, never the page. */
	.scroll {
		overflow-x: auto;
	}
	table {
		border-collapse: collapse;
		font-size: max(0.85rem, var(--min-font, 0px));
		white-space: nowrap;
	}
	th,
	td {
		padding: 0.25rem 0.5rem;
		border: 1px solid var(--line);
		text-align: left;
	}
	th {
		color: var(--muted);
		font-weight: normal;
	}
	/* A late item: danger-coloured, its lateness in words too. */
	tr.late td {
		background: color-mix(in srgb, var(--danger) 22%, var(--bg));
	}
	tr.late .lateness {
		color: var(--danger);
	}

	/* Light theme: no tints; the late row is framed in the danger colour. */
	:global(:root[data-theme='light']) tr.late td {
		background: var(--bg);
		border-color: var(--danger);
	}
</style>
