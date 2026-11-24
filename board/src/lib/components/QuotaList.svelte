<script lang="ts">
	// The 額度 tab: the Claude and the Codex accounts one above the other, each group with when its
	// account in use was read, in yellow once that is too old. One card per account, the one in
	// use first and framed: its email and plan (and for Codex how CPA routes it now), then a line per
	// quota window with the percent left and when it resets; a Codex account whose latest usage read
	// failed keeps its last numbers with their time and says so. Read-only: nothing here switches an account or asks for new
	// data; the server reads the sources by itself.
	import {
		agoText,
		groupObservedAt,
		isStale,
		level,
		ordered,
		percentText,
		planView,
		remaining,
		resetText,
		STATE_TEXT,
		UNREADABLE_TEXT,
		updatedText,
		waiting,
		type QuotaAccount,
		type QuotaClient,
		type QuotaSnapshot,
		type QuotaStateKind
	} from '#lib/board/quota.ts';

	let { quota }: { quota: QuotaSnapshot | null } = $props();

	let now = $state(Date.now());
	// Ages and the warnings move on while nothing new comes in.
	$effect(() => {
		const timer = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(timer);
	});

	/** A shape beside each state's word, so it does not rest on color alone. */
	const STATE_MARK: Record<QuotaStateKind, string> = { ready: '●', cooling: '◐', disabled: '⊘', unknown: '?' };

	const GROUPS: { client: QuotaClient; title: string }[] = [
		{ client: 'claude', title: 'Claude' },
		{ client: 'codex', title: 'Codex' }
	];
</script>

{#snippet card(account: QuotaAccount, client: QuotaClient, groupAt: number | null)}
	{@const plan = planView(account.plan, now)}
	<!-- An account's own age only when it is not the one the group's header shows. -->
	{@const ownAge = !account.current && account.observedAt !== null && account.observedAt !== groupAt}
	<li class="card" class:current={account.current}>
		<p class="who">
			{#if account.current}<span class="badge">使用中</span>{/if}
			<span class="email">{account.email}</span>
			{#if plan}<span class="plan" class:recorded={plan.recorded} title={plan.title}>{plan.text}</span>{/if}
			{#if account.state}
				<span class="state {account.state.kind}">
					<span class="mark" aria-hidden="true">{STATE_MARK[account.state.kind]}</span><span>{STATE_TEXT[account.state.kind]}{account.state.note ? `・${account.state.note}` : ''}</span>
				</span>
			{/if}
		</p>
		{#if ownAge || (account.unreadable && account.windows.length)}
			<p class="age" class:stale={ownAge && isStale(account.observedAt, now, client)}>
				{#if ownAge}<span>{agoText(account.observedAt!, now)}更新</span>{/if}
				{#if account.unreadable && account.windows.length}<span class="unreadable">⚠ {UNREADABLE_TEXT}</span>{/if}
			</p>
		{/if}
		{#if account.windows.length}
			<ul class="windows">
				{#each account.windows as window, index (index)}
					{@const old = waiting(window, now)}
					<li class="window" class:old>
						<span class="label">{window.label}</span>
						{#if window.used === null}
							<span class="none">沒有紀錄</span>
						{:else}
							<span class={['percent', !old && level(remaining(window.used))]}>{percentText(window.used)}</span>
							<span class="reset">{old ? '等待新資料' : window.resetsAt === null ? '' : resetText(window.resetsAt, now)}</span>
						{/if}
					</li>
				{/each}
			</ul>
		{:else if account.unreadable}
			<p class="none unreadable">⚠ {UNREADABLE_TEXT}</p>
		{:else}
			<p class="none">{account.note ?? '沒有紀錄'}</p>
		{/if}
	</li>
{/snippet}

<div class="quota">
	{#each GROUPS as { client, title } (client)}
		{@const group = quota?.[client]}
		<section class="group" data-client={client}>
			<header>
				<h2>{title}</h2>
				{#if group?.ok}
					{@const at = groupObservedAt(group.accounts)}
					<span class="updated" class:stale={isStale(at, now, client)}>
						{updatedText(at, now)}
					</span>
				{/if}
			</header>
			{#if !quota}
				<p class="none">讀取中…</p>
			{:else if !group?.ok}
				<p class="failed">讀不出額度：{group?.reason}</p>
			{:else if !group.accounts.length}
				<p class="none">沒有帳號</p>
			{:else}
				{@const groupAt = groupObservedAt(group.accounts)}
				<ul class="cards">
					{#each ordered(group.accounts) as account, index (index)}
						{@render card(account, client, groupAt)}
					{/each}
				</ul>
			{/if}
		</section>
	{/each}
</div>

<style>
	.quota {
		display: flex;
		flex-direction: column;
		gap: 1.1rem;
		min-width: 0;
	}
	.group {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		min-width: 0;
	}
	header {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.2rem 0.6rem;
	}
	h2 {
		margin: 0;
		font-size: max(0.95rem, var(--min-font, 0px));
	}
	.updated,
	.age {
		font-size: max(0.75rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.updated.stale,
	.age.stale {
		color: var(--warn);
	}
	.cards,
	.windows {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}
	.cards {
		gap: 0.45rem;
	}
	/* The cards' window lines share their columns, so the percents line up whatever the reset reads. */
	.windows {
		display: grid;
		grid-template-columns: minmax(3.5em, auto) auto 1fr;
		gap: 0.3rem 0.5rem;
	}
	.card {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		min-width: 0;
		padding: 0.55rem 0.65rem;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--surface);
	}
	.card.current {
		border: 2px solid var(--accent);
	}
	.who {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.2rem 0.5rem;
		margin: 0;
		min-width: 0;
	}
	.badge {
		padding: 0 0.4rem;
		border-radius: var(--radius-pill);
		background: var(--accent);
		color: var(--bg);
		font-size: max(0.7rem, var(--min-font, 0px));
		font-weight: 600;
	}
	.email {
		min-width: 0;
		overflow-wrap: anywhere;
		font-weight: 600;
	}
	.plan {
		font-size: max(0.8rem, var(--min-font, 0px));
	}
	.state {
		display: inline-flex;
		align-items: baseline;
		gap: 0.2rem;
		font-size: max(0.8rem, var(--min-font, 0px));
		white-space: nowrap;
	}
	.state.ready {
		color: var(--ok);
	}
	.state.cooling {
		color: var(--warn);
	}
	.state.disabled,
	.state.unknown {
		color: var(--muted);
	}
	.age {
		display: flex;
		flex-wrap: wrap;
		gap: 0.2rem 0.6rem;
	}
	.unreadable,
	.none.unreadable {
		color: var(--warn);
	}
	.plan.recorded {
		color: var(--muted);
		opacity: 0.75;
		cursor: help;
	}
	.age,
	.none,
	.failed {
		margin: 0;
	}
	.none {
		color: var(--muted);
		font-size: max(0.8rem, var(--min-font, 0px));
	}
	.failed {
		color: var(--danger);
		overflow-wrap: anywhere;
	}
	/* Label, percent and reset on one line. */
	.window {
		display: grid;
		grid-column: 1 / -1;
		grid-template-columns: subgrid;
		align-items: center;
		font-size: max(0.8rem, var(--min-font, 0px));
	}
	.label {
		max-width: 8em;
		overflow-wrap: anywhere;
		color: var(--muted);
	}
	.percent {
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	.percent.warn {
		color: var(--warn);
	}
	.percent.danger {
		color: var(--danger);
	}
	.window .none {
		grid-column: 2 / 4;
	}
	.reset {
		color: var(--muted);
		font-size: max(0.75rem, var(--min-font, 0px));
		white-space: nowrap;
	}
	.window.old .percent {
		opacity: 0.5;
	}
	.window.old .reset {
		color: var(--warn);
	}
</style>
