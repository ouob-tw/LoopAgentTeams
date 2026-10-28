<script lang="ts">
	// The pd 待核准 panel at the top of the middle column, above whichever list it shows: one card per
	// request pd's daemon holds for approval, with what it asks for, the time it has left, who asked
	// and its command on short lines that a tap opens to the whole command, folder and caller, with
	// what pd's check of the caller is worth. 核准 signs pd's one-time challenge with the user's
	// passkey right here (rpId ouob.net); the board server only relays the challenge and the
	// signature, pd's daemon verifies it, and the board never asks for a code. 拒絕 denies it through
	// the board at once, as `pd deny` does without a code. 稍後 folds it to a one-line badge above the
	// column's tabs, which opens it again; a request that appears opens it too and, once the user
	// allowed it (the 開啟通知 button, never asked for unprompted), raises a browser notification
	// whose click comes back to it. With nothing waiting it is not shown; the page says on the 待辦
	// list when pd is missing or down.
	import { tick } from 'svelte';
	import { request } from '#lib/board/api.ts';
	import { assertionJson, callerParts, callerText, requestOptions, shortCommand, timeText, type PdChallenge, type PdRequest, type PdSnapshot } from '#lib/board/pd.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';

	/** `onfresh` hears of new requests. */
	let { pd, onfresh }: { pd: { snapshot: PdSnapshot; at: number } | null; onfresh?: () => void } = $props();

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
	/** Whether the panel is open rather than folded to its badge. */
	let open = $state(true);
	let panel = $state<HTMLElement>();
	let badge = $state<HTMLElement>();

	/** Open or fold the panel and put the focus on what stands in its place, as the control
	 *  pressed is gone. */
	async function show(value: boolean) {
		open = value;
		await tick();
		if (value) panel?.focus();
		else badge?.focus();
	}

	/** Open it and put the focus on it, which scrolls it into view: where a phone's banner leads. */
	export const reveal = () => show(true);

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
		if (fresh.length) {
			open = true;
			onfresh?.();
		}
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
		<section class="pd" aria-label="pd 待核准" tabindex="-1" bind:this={panel}>
			<header>
				<h2>pd 待核准 <span class="count">{requests.length}</span></h2>
				{#if notifications && permission === 'default'}
					<button type="button" class="allow" title="有新的 pd 請求時發瀏覽器通知（只在看板開著時）" onclick={() => void allowNotifications()}>開啟通知</button>
				{/if}
				<button type="button" class="later" onclick={() => void show(false)}>稍後</button>
			</header>
			<ul class="cards">
				{#each requests as item (item.id)}
					{@const time = timeText(item, now - pd.at)}
					{@const caller = callerParts(item)}
					<li class="card" data-pd-request={item.id}>
						<p class="head">
							<span class="item">{item.item}</span>
							<span class="number">#{item.id}</span>
							<span class="time" class:soon={time.soon} class:low={time.low} role="timer">{time.text}</span>
						</p>
						<details>
							<summary>
								<span class="caller" class:verified={item.callerInfo?.verified} class:unverified={item.callerInfo && !item.callerInfo.verified}
									><span class="who">{caller.who}</span><span class="mark">{caller.mark}</span></span
								> <code>{shortCommand(item.command)}</code>
							</summary>
							<dl>
								<dt>欄位</dt>
								<dd>{item.fields.join('、')}</dd>
								<dt>指令</dt>
								<dd><code>{item.command.join(' ')}</code></dd>
								<dt>工作目錄</dt>
								<dd><code>{item.cwd}</code></dd>
								<dt>呼叫者</dt>
								{#if item.callerInfo}
									<dd>{callerText(item)}<span class="notice">（{item.callerInfo.notice}）</span></dd>
								{:else}
									<dd>{item.caller}（對方自稱，未驗證）</dd>
								{/if}
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
		</section>
	{:else}
		<button type="button" class="pd-badge" bind:this={badge} onclick={() => void show(true)}>pd 待核准 <span class="count">{requests.length}</span></button>
	{/if}
{/if}

<style>
	/* Its place at the top of the column is the page's to say; this is how it looks: one panel, a
	   card for each request, with a scroll of its own under its heading once several wait. */
	.pd {
		flex: none;
		min-width: 0;
		max-height: min(60vh, 36rem);
		margin-bottom: 0.5rem;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		overflow-y: auto;
		animation: arrive 160ms ease-out;
	}
	@keyframes arrive {
		from {
			opacity: 0;
			transform: translateY(-0.4rem);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.pd {
			animation: none;
		}
	}
	.pd:focus {
		outline: none;
	}
	.pd:focus-visible {
		outline: 2px solid var(--accent);
	}
	header {
		position: sticky;
		top: 0;
		z-index: 1;
		display: flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.35rem 0.35rem 0.35rem 0.75rem;
		border-bottom: 1px solid var(--line);
		background: color-mix(in srgb, var(--warn) 7%, var(--surface));
	}
	h2 {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 0.45rem;
		margin: 0;
		font-size: max(0.85rem, var(--min-font, 0px));
		font-weight: 600;
	}
	/* The dot that says something waits, and the panel's count beside it. */
	h2::before,
	.pd-badge::before {
		content: '';
		flex: none;
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		background: var(--warn);
	}
	.count {
		display: inline-block;
		min-width: 1.4em;
		padding: 0 0.4em;
		border-radius: var(--radius-pill);
		background: var(--warn);
		color: var(--bg);
		font-family: var(--mono);
		font-size: max(0.75rem, var(--min-font, 0px));
		line-height: 1.5;
		text-align: center;
	}
	.later,
	.allow {
		padding: 0.2rem 0.6rem;
		background: none;
		border-color: transparent;
		color: var(--muted);
		font-size: max(0.85rem, var(--min-font, 0px));
	}
	.later:hover,
	.allow:hover {
		color: var(--text);
		border-color: var(--line);
	}
	.cards {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.card {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		min-width: 0;
		padding: 0.65rem 0.75rem 0.7rem;
	}
	.card + .card {
		border-top: 1px solid var(--line);
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.1rem 0.45rem;
		margin: 0;
	}
	.item {
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.number,
	.time {
		font-family: var(--mono);
		font-size: max(0.75rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.time {
		margin-left: auto;
		font-variant-numeric: tabular-nums;
	}
	.time.soon {
		color: var(--warn);
	}
	.time.low {
		color: var(--danger);
		font-weight: 600;
	}
	/* Who asked on a line of its own, then the command; a line too long ends in an ellipsis, the
	   caller's name giving way before its mark. The rest is under it once opened. The marker is
	   drawn here, Safari's hidden. */
	summary {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: center;
		gap: 0.3rem 0.4rem;
		white-space: nowrap;
		cursor: pointer;
		font-size: max(0.8rem, var(--min-font, 0px));
	}
	summary::-webkit-details-marker {
		display: none;
	}
	summary::before {
		content: '▸';
		content: '▸' / '';
		color: var(--muted);
	}
	details[open] summary::before {
		content: '▾';
		content: '▾' / '';
	}
	.caller {
		display: flex;
		justify-self: start;
		max-width: 100%;
		padding: 0 0.55rem;
		border: 1px solid var(--line);
		border-radius: var(--radius-pill);
		color: var(--muted);
	}
	.who {
		min-width: 2em;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.mark {
		flex: none;
	}
	.verified .mark {
		margin-left: 0.25rem;
		color: var(--ok);
		font-weight: 600;
	}
	.unverified .mark {
		margin-left: 0.35rem;
		color: var(--warn);
	}
	summary code {
		grid-column: 2;
		justify-self: start;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		padding: 0.1rem 0.5rem;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: calc(var(--radius) - 2px);
	}
	dl {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 0.25rem 0.8rem;
		margin: 0.45rem 0 0;
		padding: 0.5rem 0.6rem;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: calc(var(--radius) - 2px);
		font-size: max(0.8rem, var(--min-font, 0px));
	}
	dt,
	.notice {
		color: var(--muted);
	}
	dd {
		margin: 0;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	code {
		font-family: var(--mono);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin: 0.1rem 0 0;
	}
	.actions button {
		padding: 0.3rem 1rem;
		font-size: max(0.9rem, var(--min-font, 0px));
	}
	/* The board's main button: it signs with the passkey here. */
	.approve {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--bg);
		font-weight: 600;
	}
	.deny {
		background: none;
		color: var(--danger);
	}
	.deny:hover {
		border-color: var(--danger);
	}
	.page {
		margin-left: auto;
		font-size: max(0.75rem, var(--min-font, 0px));
		color: var(--muted);
		text-underline-offset: 0.2em;
	}
	.page:hover {
		color: var(--text);
	}
	/* Folded: one line that opens it again. */
	.pd-badge {
		display: block;
		flex: none;
		width: 100%;
		margin-bottom: 0.5rem;
		padding: 0.35rem 0.75rem;
		text-align: left;
		font-size: max(0.85rem, var(--min-font, 0px));
		font-weight: 600;
		border-left: 3px solid var(--warn);
	}
	.pd-badge::before {
		display: inline-block;
		margin-right: 0.45rem;
		vertical-align: 0.05em;
	}
	.pd-badge::after {
		content: '展開 ▾';
		content: '展開 ▾' / '';
		float: right;
		font-weight: 400;
		color: var(--muted);
	}
	.pd-badge .count {
		margin-left: 0.15rem;
	}
	/* Light theme: no tint, a heavier line under the heading instead. */
	:global(:root[data-theme='light']) header {
		background: var(--surface);
		border-bottom-width: 2px;
	}
	@media (max-width: 480px) {
		dl {
			grid-template-columns: 1fr;
		}
		dt:not(:first-child) {
			margin-top: 0.3rem;
		}
		.actions > button {
			flex: 1;
		}
	}
</style>
