<script lang="ts">
	// The pd 待核准 overlay over the middle column, whichever list it shows: one card per request
	// pd's daemon holds for approval, with what it asks for, the time it has left and its command on
	// one short line that a tap opens to the whole command, folder and caller. 核准 signs pd's
	// one-time challenge with the user's passkey right here (rpId ouob.net); the board server only
	// relays the challenge and the signature, pd's daemon verifies it, and the board never asks for a
	// code. 拒絕 denies it through the board at once, as `pd deny` does without a code. 稍後 folds it
	// to a badge above the column's tabs, which opens it again; a request that appears opens it too
	// and, once the user allowed it (the 開啟通知 button, never asked for unprompted), raises a
	// browser notification whose click comes back to it. With nothing waiting it is not shown; the
	// page says on the 待辦 list when pd is missing or down.
	import { tick } from 'svelte';
	import { request } from '#lib/board/api.ts';
	import { assertionJson, requestOptions, shortCommand, timeText, type PdChallenge, type PdRequest, type PdSnapshot } from '#lib/board/pd.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';

	/** `onaway` takes the focus when folding leaves no badge on screen: a phone hides the middle
	 *  column, badge and all, while it shows a content screen. */
	let { pd, onaway }: { pd: { snapshot: PdSnapshot; at: number } | null; onaway?: () => void } = $props();

	const requests = $derived(pd?.snapshot.ok ? pd.snapshot.requests : []);
	let now = $state(Date.now());
	$effect(() => {
		if (!requests.length) return;
		const timer = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(timer);
	});
	/** The requests being denied or approved, by number. */
	let denying = $state<number[]>([]);
	let approving = $state<number[]>([]);

	/** The requests in the reading before, by daemon start and number: one not in it is new. pd
	 *  numbers from 1 again after its daemon restarts, so the number alone is not enough. A failed
	 *  reading forgets it, for a pd that does not name its daemon start. */
	let previous: Set<string> | null = null;
	const key = (item: PdRequest) => `${item.daemon ?? ''}#${item.id}`;
	/** Whether the overlay is open rather than folded to its badge. */
	let open = $state(true);
	let overlay = $state<HTMLElement>();
	let badge = $state<HTMLElement>();

	/** Open or fold the overlay and put the focus on what stands in its place, as the control
	 *  pressed is gone. */
	async function show(value: boolean) {
		open = value;
		await tick();
		if (value) overlay?.focus();
		else if (badge?.checkVisibility()) badge.focus();
		else onaway?.();
	}

	const notifications = typeof Notification === 'function';
	let permission = $state<NotificationPermission>(notifications ? Notification.permission : 'denied');

	function notify(item: PdRequest) {
		if (!notifications || Notification.permission !== 'granted') return;
		const shown = new Notification(`pd 請求 #${item.id} 等你核准`, { body: `${item.item}：${item.command.join(' ')}`, tag: `pd-${item.id}` });
		shown.onclick = () => {
			window.focus();
			shown.close();
			void show(true);
		};
	}

	$effect(() => {
		if (!pd) return;
		if (!pd.snapshot.ok) {
			previous = new Set();
			return;
		}
		const before = previous;
		previous = new Set(requests.map(key));
		if (before === null) return;
		const fresh = requests.filter((item) => !before.has(key(item)));
		if (fresh.length) open = true;
		for (const item of fresh) notify(item);
	});

	async function allowNotifications() {
		permission = await Notification.requestPermission();
	}

	function failed(result: { unpaired?: boolean; body?: unknown }, fallback: string) {
		if (result.unpaired) return;
		const said = (result.body as { error?: unknown } | undefined)?.error;
		toasts.show('failed', typeof said === 'string' ? said : fallback);
	}

	const post = <T,>(path: string, body: unknown) =>
		request<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

	async function deny(item: PdRequest) {
		denying = [...denying, item.id];
		const result = await post<{ ok: true }>('/api/pd/deny', { id: item.id });
		denying = denying.filter((id) => id !== item.id);
		if (result.ok) return toasts.show('ok', `已拒絕 pd 請求 #${item.id}（${item.item}）`);
		failed(result, '沒有拒絕成功：看板沒有回應，請稍後再試。');
	}

	async function approve(item: PdRequest) {
		// Passkeys need a secure page whose address is under ouob.net: https://lat.ouob.net.
		if (!window.isSecureContext || !navigator.credentials) return toasts.show('failed', '這個網址不能用 passkey：請從 https://lat.ouob.net 開看板，或改用 pd 核准頁。');
		approving = [...approving, item.id];
		try {
			const challenge = await post<{ options: PdChallenge }>('/api/pd/challenge', { id: item.id });
			if (!challenge.ok) return failed(challenge, '沒有開始核准：看板沒有回應，請稍後再試。');
			let credential: Credential | null;
			try {
				credential = await navigator.credentials.get({ publicKey: requestOptions(challenge.value.options) });
			} catch {
				credential = null;
			}
			if (!credential) return toasts.show('failed', `passkey 驗證沒有完成，pd 請求 #${item.id} 仍待核准`);
			const result = await post<{ ok: true }>('/api/pd/approve', { id: item.id, credential: assertionJson(credential as PublicKeyCredential) });
			if (!result.ok) return failed(result, '沒有核准成功：看板沒有回應，請稍後再試。');
			toasts.show('ok', `已核准 pd 請求 #${item.id}（${item.item}）`);
		} finally {
			approving = approving.filter((id) => id !== item.id);
		}
	}
</script>

{#if requests.length && pd}
	{#if open}
		<section class="pd" aria-label="pd 待核准" tabindex="-1" bind:this={overlay}>
			<header>
				<h2>pd 待核准 <span class="count">（{requests.length}）</span></h2>
				<button type="button" class="later" onclick={() => void show(false)}>稍後</button>
			</header>
			<ul class="cards">
				{#each requests as item (item.id)}
					{@const time = timeText(item, now - pd.at)}
					<li class="card" data-pd-request={item.id}>
						<p class="head">
							<span class="item">{item.item}</span>
							<span class="number">#{item.id}</span>
							<span class="time" class:low={time.low} role="timer">{time.text}</span>
						</p>
						<details>
							<summary><code>{shortCommand(item.command)}</code></summary>
							<dl>
								<dt>欄位</dt>
								<dd>{item.fields.join('、')}</dd>
								<dt>指令</dt>
								<dd><code>{item.command.join(' ')}</code></dd>
								<dt>工作目錄</dt>
								<dd><code>{item.cwd}</code></dd>
								<dt>呼叫者</dt>
								<dd>{item.caller}（對方自稱，未驗證）</dd>
							</dl>
						</details>
						<p class="actions">
							<button type="button" class="approve" disabled={approving.includes(item.id)} onclick={() => void approve(item)}
								>{approving.includes(item.id) ? '核准中…' : '核准'}</button
							>
							<button type="button" class="deny" disabled={denying.includes(item.id)} onclick={() => void deny(item)}
								>{denying.includes(item.id) ? '拒絕中…' : '拒絕'}</button
							>
							{#if item.approvalUrl}
								<a class="page" href={item.approvalUrl} target="_blank" rel="noopener noreferrer">改用 pd 核准頁</a>
							{/if}
						</p>
					</li>
				{/each}
			</ul>
			<p class="quiet">核准會在這頁用這台裝置的 passkey 解鎖驗證（通常是指紋或臉部辨識）；看板只轉送簽章，由 pd 驗證，不需要確認碼。</p>
			{#if notifications && permission === 'default'}
				<p class="quiet">
					<button type="button" class="allow" onclick={() => void allowNotifications()}>開啟通知</button>
					有新的 pd 請求時發瀏覽器通知（只在看板開著時）
				</p>
			{/if}
		</section>
	{:else}
		<button type="button" class="pd-badge" bind:this={badge} onclick={() => void show(true)}>pd 待核准 {requests.length}</button>
	{/if}
{/if}

<style>
	/* Where it lies over the column is the page's to say; this is how it looks. */
	.pd {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		min-width: 0;
		padding: 0.6rem;
		background: var(--bg);
		border-top: 3px solid var(--warn);
		box-shadow: 0 0.3rem 1rem color-mix(in srgb, #000 35%, transparent);
	}
	.pd:focus {
		outline: none;
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.6rem;
	}
	h2 {
		margin: 0;
		font-size: max(0.95rem, var(--min-font, 0px));
	}
	.count,
	.quiet,
	.number {
		color: var(--muted);
		font-weight: 400;
	}
	.quiet {
		margin: 0;
		font-size: max(0.8rem, var(--min-font, 0px));
	}
	.cards {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}
	.card {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		min-width: 0;
		padding: 0.55rem 0.65rem;
		border: 1px solid var(--line);
		border-left: 3px solid var(--warn);
		border-radius: var(--radius);
		background: var(--surface);
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.2rem 0.6rem;
		margin: 0;
	}
	.item {
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.number {
		font-size: max(0.75rem, var(--min-font, 0px));
	}
	.time {
		margin-left: auto;
		font-family: var(--mono);
		font-size: max(0.85rem, var(--min-font, 0px));
	}
	.time.low {
		color: var(--danger);
	}
	/* One line however long the command; the rest under it once opened. */
	summary {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		cursor: pointer;
		font-size: max(0.9rem, var(--min-font, 0px));
	}
	details[open] summary {
		margin-bottom: 0.35rem;
	}
	dl {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 0.2rem 0.8rem;
		margin: 0;
		font-size: max(0.9rem, var(--min-font, 0px));
	}
	dt {
		color: var(--muted);
	}
	dd {
		margin: 0;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	code {
		font-family: var(--mono);
		font-size: 0.9em;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem;
		margin: 0;
	}
	/* The board's main button: it signs with the passkey here. */
	.approve {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--bg);
		font-weight: 600;
	}
	.page {
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.pd-badge {
		align-self: flex-start;
		flex: none;
		border-color: var(--warn);
		color: var(--warn);
		font-weight: 600;
		font-size: max(0.85rem, var(--min-font, 0px));
	}
	.deny {
		border-color: var(--danger);
		color: var(--danger);
	}
	@media (max-width: 480px) {
		dl {
			grid-template-columns: 1fr;
		}
		dt:not(:first-child) {
			margin-top: 0.3rem;
		}
		.time {
			margin-left: 0;
		}
		.actions > * {
			flex: 1;
			text-align: center;
		}
	}
</style>
