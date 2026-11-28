<script lang="ts">
	// 示意頁分享 in the settings dialog's 帳號與分享: which published demos open without the board's
	// login, one switch each (lib/server/demo-share.ts). Shared ones are listed first, then the
	// newest, as of when the dialog opened. Read again each time it opens. Opened from a demo page's
	// 分享 button (demo-share-button.ts), it scrolls to that demo's switch and marks its row.
	import { tick } from 'svelte';
	import { request } from '#lib/board/api.ts';
	import { testDevice } from '#lib/board/test-device.svelte.ts';

	type Demo = { name: string; shared: boolean };
	/** From this many, a filter box finds a demo by its name. */
	const FILTER_FROM = 8;

	let demos = $state.raw<Demo[] | null>(null);
	let saving = $state<string | null>(null);
	let refusal = $state<string | null>(null);
	let filter = $state('');
	/** The demo the dialog was opened at, marked until it opens again. */
	let target = $state<string | null>(null);
	/** That demo, when the list does not have it (deleted since). */
	let gone = $state<string | null>(null);
	let list = $state<HTMLUListElement>();
	let read = 0;

	const shown = $derived(demos?.filter((demo) => demo.name.includes(filter.trim().toLowerCase())) ?? []);
	const sharedCount = $derived(demos?.filter((demo) => demo.shared).length ?? 0);

	/** Read the list again; with `at`, then scroll to that demo's switch and focus it. */
	export async function load(at?: string) {
		const mine = ++read;
		target = at ?? null;
		gone = null;
		if (at) filter = '';
		const result = await request<{ demos: Demo[] }>('/api/demo-share');
		if (mine !== read) return;
		if (result.ok) {
			demos = result.value.demos;
			refusal = null;
			if (at) await reveal(at);
		} else if (!result.unpaired) refusal = '讀不到示意頁分享設定，請檢查網路後再試。';
	}

	async function reveal(name: string) {
		await tick();
		const box = [...(list?.querySelectorAll<HTMLInputElement>('input[role="switch"]') ?? [])].find((input) => input.dataset.demo === name);
		if (!box) {
			gone = name;
			return;
		}
		box.closest('li')?.scrollIntoView({ block: 'center' });
		box.focus({ preventScroll: true });
	}

	/** A switch shows what the server holds: one whose save failed goes back. */
	async function save(name: string, box: HTMLInputElement) {
		saving = name;
		++read;
		const result = await request<{ demos: Demo[] }>('/api/demo-share', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name, shared: box.checked })
		});
		saving = null;
		if (result.ok) {
			// Keep the order the dialog opened with, so the row just switched stays under the finger.
			const shared = new Set(result.value.demos.filter((demo) => demo.shared).map((demo) => demo.name));
			demos = (demos ?? []).map((demo) => ({ ...demo, shared: shared.has(demo.name) }));
			refusal = null;
			return;
		}
		box.checked = !box.checked;
		if (!result.unpaired) refusal = '沒有改到，請檢查網路後再按一次。';
	}
</script>

<section class="share">
	<h4>示意頁分享{#if sharedCount}<span class="count">（已分享 {sharedCount} 頁）</span>{/if}</h4>
	<p class="note">開啟的頁面，任何拿到網址的人不必登入都看得到。</p>
	{#if gone}<p class="failed" role="status">清單裡沒有 {gone}，這一頁可能已經刪除。</p>{/if}
	{#if refusal}
		<div role="alert">
			<p class="failed">{refusal}</p>
			<button disabled={saving !== null} onclick={() => void load()}>重新載入</button>
		</div>
	{/if}
	{#if demos === null}
		{#if !refusal}<p class="note">讀取中…</p>{/if}
	{:else if !demos.length}
		<p class="note">還沒有發布的示意頁。</p>
	{:else}
		{#if demos.length >= FILTER_FROM}
			<input type="search" aria-label="找示意頁" placeholder="找示意頁" bind:value={filter} />
		{/if}
		<ul class="demos" aria-label="示意頁分享" bind:this={list}>
			{#each shown as demo (demo.name)}
				<li class:target={demo.name === target} aria-current={demo.name === target ? 'true' : undefined}>
					<label title={demo.name}>
						<input
							type="checkbox"
							role="switch"
							data-demo={demo.name}
							checked={demo.shared}
							disabled={saving !== null || testDevice.view !== null}
							onchange={(event) => void save(demo.name, event.currentTarget)}
						/>
						<span>{demo.name}</span>
					</label>
				</li>
			{:else}
				<li class="note">沒有符合的示意頁。</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.share {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	h4 {
		margin: 0;
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.count {
		font-weight: 400;
	}
	.note {
		margin: 0;
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	[role='alert'] button {
		min-height: 44px;
		margin-top: 0.35rem;
	}
	.failed {
		margin: 0;
		color: var(--danger);
		overflow-wrap: anywhere;
	}
	input[type='search'] {
		min-height: 44px;
		width: 100%;
		box-sizing: border-box;
	}
	/* A long list scrolls inside its frame, so the groups below stay near. */
	.demos {
		max-height: 17.6rem;
		overflow-y: auto;
		margin: 0;
		padding: 0 0.6rem;
		list-style: none;
		border: 1px solid var(--line);
		border-radius: var(--radius);
	}
	.demos > .note {
		padding: 0.6rem 0;
	}
	/* The row the dialog was opened at, from that demo page's 分享 button. */
	.target {
		margin: 0 -0.6rem;
		padding: 0 calc(0.6rem - 2px);
		border: 2px solid var(--text);
		border-radius: var(--radius);
	}
	/* The whole row takes the tap, a finger high (ui-baseline). */
	label {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		min-height: 44px;
		min-width: 0;
	}
	label input {
		flex: none;
		width: 1.2rem;
		height: 1.2rem;
		margin: 0;
	}
	label span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	@media (max-width: 600px) {
		.share {
			gap: 0.2rem;
		}
	}
</style>
