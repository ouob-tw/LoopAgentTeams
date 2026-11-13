<script lang="ts">
	// A controller's review tab: the latest round's review file as lat-unattended read it. A banner
	// with the parked count and the cross-check's state, the goal and what counts as done (every
	// version, the user's changes too) folded to one line, 最該先看的幾項, then the rest of the items
	// by section, each folded to its title and one line of what was done. The file changes on its own,
	// so it is read again whenever the status read says its file was written.
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { request } from '#lib/board/api.ts';
	import { isParked, verificationText, type Review, type ReviewItem as Item } from '#lib/board/review.ts';
	import type { Controller } from '#lib/board/types.ts';
	import ReviewItem from './ReviewItem.svelte';

	let { controller }: { controller: Controller } = $props();

	const summary = $derived(controller.unattended.state === 'unknown' || controller.unattended.state === 'error' ? null : (controller.unattended.review ?? null));
	/** Changes with every write of the review file. */
	const written = $derived(summary?.state === 'ok' ? `${summary.stamp}:${summary.verified}` : null);

	let review = $state<Review | null>(null);
	let problem = $state<string | null>(null);
	let goalOpen = $state(false);
	/** The latest read started; an older one that answers later is dropped. */
	let reads = 0;

	async function load(id: string) {
		const mine = ++reads;
		const result = await request<{ review: Review | null }>(`/api/review?controller=${encodeURIComponent(id)}`);
		if (mine !== reads) return;
		if (!result.ok) {
			if (result.unpaired) return;
			const reason = (result.kind === 'http' && (result.body as { reason?: string } | null)?.reason) || result.message;
			problem = `讀不到回顧：${reason}`;
			return;
		}
		problem = null;
		review = result.value.review;
	}
	$effect(() => {
		void written;
		void load(controller.id);
	});

	const byId = $derived(new Map((review?.items ?? []).map((item) => [item.id, item])));
	const top = $derived((review?.top ?? []).flatMap((id) => byId.get(id) ?? []));
	const inTop = $derived(new Set(top.map((item) => item.id)));
	/** The sections after 目標 and 最該先看, in the file's order, without the items shown above. */
	const sections = $derived(
		(review?.sections ?? [])
			.filter((section) => !['goal', 'top', 'done'].includes(section.key))
			.map((section) => ({ ...section, items: (review?.items ?? []).filter((item) => item.section === section.key && !inTop.has(item.id)) }))
			.filter((section) => section.items.length)
	);
	const parked = $derived((review?.items ?? []).filter((item) => isParked(item) && item.state === 'open').length);
	const current = $derived(review?.goals.at(-1) ?? null);
	const count = (items: Item[]) => items.length;
</script>

<section class="review" aria-label="回顧">
	{#if problem}
		<p class="failed" role="alert">{problem}</p>
	{/if}
	{#if !review}
		{#if !problem}<p class="note">讀取中…</p>{/if}
	{:else}
		<div class="banner" class:waiting={parked > 0}>
			<b>擱置等你的事：{parked} 項</b>
			<span class="check" data-verified={review.verified}>{verificationText(review)}</span>
			{#each review.verification?.mismatches ?? [] as mismatch (mismatch.id)}
				<span class="mismatch">不符 {mismatch.id}：{mismatch.text}</span>
			{/each}
		</div>
		{#if review.problems.length}
			<div class="unread" role="alert">
				<b>有來源讀不出來，下面可能少了項目：</b>
				<ul>
					{#each review.problems as line, index (index)}<li>{line}</li>{/each}
				</ul>
			</div>
		{/if}
		{#if current}
			<div class="goal">
				<button type="button" class="line" aria-expanded={goalOpen} onclick={() => (goalOpen = !goalOpen)}>
					<span class="text"><b>目標：</b>{current.goal} · 條件 {current.done.length} 條{review.goals.length > 1 ? ` · 改過 ${review.goals.length - 1} 次` : ''}</span>
					<span class="chevron" class:open={goalOpen}><ChevronRight size="1em" /></span>
				</button>
				{#if goalOpen}
					<ol class="versions">
						{#each [...review.goals].reverse() as version (version.version)}
							<li data-version={version.version}>
								<b>第 {version.version} 版</b>
								<span class="muted">{version.sourceLabel}{version.endedAt ? `，已被取代或結束（${version.endLabel ?? ''}）` : '，生效中'}</span>
								<p class="goal-text">{version.goal}</p>
								<b>做完的條件</b>
								<ul>
									{#each version.done as done, index (index)}<li>{done}</li>{/each}
								</ul>
								<p class="muted">參謀可以替你決定：{version.scope.join('、') || '都不代決'}；額度用完或跑滿 {version.maxHours} 小時就停。</p>
							</li>
						{/each}
					</ol>
				{/if}
			</div>
		{/if}
		{#if top.length}
			<h4>最該先看的幾項</h4>
			<ul class="items" data-section="top">
				{#each top as item (item.id)}<ReviewItem controllerId={controller.id} {item} />{/each}
			</ul>
		{/if}
		{#each sections as section (section.key)}
			<h4>{section.heading}</h4>
			<ul class="items" data-section={section.key}>
				{#each section.items as item (item.id)}<ReviewItem controllerId={controller.id} {item} />{/each}
			</ul>
		{/each}
		{#if review.doneTickets.length}
			<h4>本輪完成的票</h4>
			<ul class="done" data-section="done">
				{#each review.doneTickets as line, index (index)}<li>{line}</li>{/each}
			</ul>
		{/if}
		{#if !count(review.items)}<p class="note">還沒有要看的項目。</p>{/if}
	{/if}
</section>

<style>
	.review {
		min-width: 0;
	}
	.note {
		margin: 0;
		color: var(--muted);
	}
	.failed {
		margin: 0 0 0.6rem;
		color: var(--danger);
		overflow-wrap: anywhere;
	}
	.banner {
		display: flex;
		flex-direction: column;
		margin: 0 0 0.6rem;
		padding: 0.5rem 0.8rem;
		border: 2px solid var(--line);
		border-radius: var(--radius);
	}
	.banner.waiting {
		border-color: var(--warn);
	}
	.banner.waiting b {
		color: var(--warn);
	}
	.check,
	.mismatch,
	.muted {
		color: var(--muted);
	}
	.check[data-verified='false'] {
		color: var(--warn);
		font-weight: 700;
	}
	.unread {
		margin: 0 0 0.6rem;
		padding: 0.4rem 0.8rem;
		border: 2px solid var(--danger);
		border-radius: var(--radius);
		overflow-wrap: anywhere;
	}
	.unread ul {
		margin: 0;
		padding-left: 1.2rem;
	}
	.goal {
		margin: 0 0 0.6rem;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--surface);
	}
	.line {
		display: flex;
		align-items: center;
		gap: 0.2rem;
		box-sizing: border-box;
		width: 100%;
		min-height: 44px;
		padding: 0.3rem 0.8rem;
		border: 0;
		background: none;
		text-align: left;
	}
	.text {
		min-width: 0;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.chevron {
		display: inline-flex;
		flex: none;
		transition: transform 0.15s;
	}
	.chevron.open {
		transform: rotate(90deg);
	}
	.versions {
		margin: 0;
		padding: 0 0.8rem 0.5rem 2rem;
		overflow-wrap: anywhere;
	}
	.versions li {
		margin-top: 0.4rem;
	}
	.versions ul {
		margin: 0;
		padding-left: 1.2rem;
	}
	.goal-text,
	.versions p {
		margin: 0.1rem 0;
	}
	h4 {
		margin: 1rem 0 0.3rem;
		font-size: inherit;
	}
	.items,
	.done {
		margin: 0;
		padding: 0;
	}
	.done {
		padding-left: 1.2rem;
		overflow-wrap: anywhere;
	}
</style>
