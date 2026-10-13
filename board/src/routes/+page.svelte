<script lang="ts">
	// Wide: roster and content side by side. Narrow: the roster strip on top, and one content
	// screen at a time once something is opened.
	import { onMount } from 'svelte';
	import { LiveBoard } from '#lib/board/live.svelte.ts';
	import ControllerInfo from '#lib/components/ControllerInfo.svelte';
	import Roster from '#lib/components/Roster.svelte';

	let { data } = $props();

	// svelte-ignore state_referenced_locally
	const board = new LiveBoard(data.snapshot);
	onMount(() => board.connect());

	let openId = $state<string | null>(null);
	const controllers = $derived(board.snapshot.controllers);
	const open = $derived(controllers.find((controller) => controller.id === openId));
</script>

{#snippet refresh()}
	<button class="refresh" onclick={() => board.refresh()} disabled={board.refreshing} title="立即重新讀取所有資料">
		{board.refreshing ? '讀取中…' : '重新整理'}
	</button>
{/snippet}

{#if board.link === 'offline'}
	<p class="offline" role="status">連線中斷，正在重新連線…</p>
{/if}

{#if board.refreshFailed}
	<p class="problem" role="alert">重新整理失敗，請稍後再試。</p>
{/if}
{#each board.snapshot.errors as error (error)}
	<p class="problem" role="alert">⚠ {error}</p>
{/each}

<div class="shell" class:viewing={open !== undefined}>
	<nav class="roster">
		<header class="summary">
			<span>{controllers.length} 個主控</span>
			{@render refresh()}
		</header>
		<Roster {controllers} currentId={openId} onopen={(id) => (openId = id)} />
	</nav>

	<section class="detail">
		{#if open}
			<div class="topbar">
				<button onclick={() => (openId = null)} aria-label="返回">←</button>
				<strong>{open.project}</strong>
				<span class="handle">@{open.hcomName}</span>
				{@render refresh()}
			</div>
			<ControllerInfo controller={open} />
		{:else}
			<p class="empty">點主控名稱看它的資訊。</p>
		{/if}
	</section>
</div>

<style>
	.offline {
		position: sticky;
		top: 0;
		z-index: 20;
		margin: 0;
		padding: 0.4rem 1rem;
		background: var(--danger);
		color: var(--bg);
		font-weight: 600;
		text-align: center;
	}
	.shell {
		--roster-w: 272px;
		display: grid;
		grid-template-columns: min(var(--roster-w), 30vw) 1fr;
		min-height: 100dvh;
	}
	.roster {
		min-width: 0;
		border-right: 1px solid var(--line);
		padding: 1rem;
	}
	.summary {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.8rem;
		font-size: 0.8rem;
		color: var(--muted);
	}
	.refresh {
		margin-left: auto;
		padding: 0.15rem 0.6rem;
		font-size: 0.8rem;
		color: var(--text);
	}
	.problem {
		margin: 0;
		padding: 0.4rem 1rem;
		border-bottom: 1px solid var(--line);
		font-size: 0.8rem;
		color: var(--danger);
		overflow-wrap: anywhere;
	}
	.detail {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		min-width: 0;
		max-width: 46rem;
		padding: 1.5rem;
	}
	.empty {
		color: var(--muted);
	}
	.topbar {
		display: none;
		position: sticky;
		top: 0;
		z-index: 5;
		align-items: center;
		gap: 0.7rem;
		margin: -1rem -1rem 0;
		padding: 0.6rem 1rem;
		background: var(--bg);
		border-bottom: 1px solid var(--line);
	}
	.handle {
		font-family: var(--mono);
		font-size: 0.8rem;
		color: var(--muted);
	}

	@media (max-width: 760px) {
		.shell {
			display: block;
		}
		.roster {
			border-right: 0;
		}
		.detail {
			display: none;
			padding: 1rem;
		}
		.viewing .roster {
			display: none;
		}
		.viewing .detail {
			display: flex;
		}
		.topbar {
			display: flex;
		}
	}
</style>
