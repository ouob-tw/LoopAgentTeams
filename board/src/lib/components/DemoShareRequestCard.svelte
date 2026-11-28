<script lang="ts">
	// An agent's request to share a demo without the login (`demo.py share`), at the top of the 待辦
	// list: a yellow edge and label like the cards that wait for the user, the demo's name, who asked
	// and when, its page to look at first, and 拒絕 and 確認公開. 確認公開 asks for a passkey that
	// checks who holds it (fingerprint, face, PIN); only a passed check shares the page
	// (routes/api/demo-share/requests). A cancelled or failed passkey leaves the request as it was.
	// The card goes once the board's next snapshot no longer has the request.
	import KeyRound from '@lucide/svelte/icons/key-round';
	import { startAuthentication } from '@simplewebauthn/browser';
	import { request } from '#lib/board/api.ts';
	import { clock } from '#lib/board/clock.svelte.ts';
	import { noticeTime } from '#lib/board/format.ts';
	import { TIME_ZONE } from '#lib/board/automation.ts';
	import { passkeyBlocked, passkeyRefusal, reportPasskeyRefusal } from '#lib/board/passkey-here.ts';
	import { testDevice } from '#lib/board/test-device.svelte.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';
	import type { DemoShareRequest } from '#lib/board/types.ts';

	let { share, ondone }: { share: DemoShareRequest; ondone: () => void } = $props();

	let busy = $state<'confirm' | 'reject' | null>(null);
	let failure = $state('');
	const path = $derived(`/api/demo-share/requests/${encodeURIComponent(share.name)}`);

	/** What a failed request means for this card. */
	function refused(result: { kind: string; body?: unknown }): string {
		if (result.kind !== 'http') return '沒有送出，請檢查網路後再按一次。';
		const { error, origin } = (result.body ?? {}) as { error?: string; origin?: string | null };
		if (error === 'passkey_unavailable') return passkeyBlocked(origin ?? null) || '這裡不能用 passkey，請從看板網址打開。';
		if (error === 'no_passkey') return '還沒有登記 passkey：到「設定」登記後再確認。';
		if (error === 'no_request') return '這個申請已經不在了。';
		if (error === 'passkey_failed') return 'passkey 沒有通過，頁面沒有公開，請再按一次。';
		return '看板沒有存到，請稍後再按一次。';
	}

	async function confirm() {
		busy = 'confirm';
		failure = '';
		const options = await request<Parameters<typeof startAuthentication>[0]['optionsJSON']>(`${path}/options`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ folder: share.folder })
		});
		if (!options.ok) {
			busy = null;
			if (!options.unpaired) failure = refused(options);
			return;
		}
		let answer;
		try {
			answer = await startAuthentication({ optionsJSON: options.value });
		} catch (error) {
			reportPasskeyRefusal('demo_share', error);
			failure = passkeyRefusal(error, false);
			busy = null;
			return;
		}
		const done = await request(`${path}/confirm`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ response: answer })
		});
		busy = null;
		if (done.ok) {
			toasts.show('ok', `已公開 ${share.name}`);
			ondone();
		} else if (!done.unpaired) failure = refused(done);
	}

	async function reject() {
		busy = 'reject';
		failure = '';
		const done = await request(path, { method: 'DELETE' });
		busy = null;
		if (done.ok || (!done.unpaired && (done.body as { error?: string } | null)?.error === 'no_request')) ondone();
		else if (!done.unpaired) failure = refused(done);
	}
</script>

<div class="row" data-share-request={share.name}>
	<p class="clamp">
		<span class="kind">分享申請</span>
		<a class="title" href="/demo/{share.name}/" target="_blank" rel="noopener noreferrer" title="先看這一頁">{share.name}<span class="away" aria-hidden="true">↗</span></a>
	</p>
	<div class="under">
		<span class="by" title={share.by ? `@${share.by}` : undefined}>{share.by ? `@${share.by}` : 'Agent'}</span>
		<time datetime={share.at}>{noticeTime(share.at, clock.now, TIME_ZONE)}</time>
	</div>
	<div class="actions">
		<button type="button" class="reject" disabled={busy !== null || testDevice.view !== null} onclick={() => void reject()}>{busy === 'reject' ? '拒絕中…' : '拒絕'}</button>
		<button
			type="button"
			class="primary"
			disabled={busy !== null || testDevice.view !== null}
			title="用 passkey 確認後，拿到網址的人不必登入就能看這一頁"
			onclick={() => void confirm()}><KeyRound size="1em" aria-hidden="true" />{busy === 'confirm' ? '確認中…' : '確認公開'}</button
		>
	</div>
	{#if failure}<p class="failed" role="alert">{failure}</p>{/if}
</div>

<style>
	.row {
		padding: 0.5rem 0.6rem 0.5rem 0.9rem;
		border: 1px solid var(--line);
		border-left: 6px solid var(--ask-fill);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		line-height: 1.6;
	}
	.clamp {
		margin: 0;
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
		overflow-wrap: anywhere;
	}
	.kind {
		display: inline-block;
		margin-right: 0.5rem;
		padding: 0 0.45rem;
		border-radius: var(--radius-pill);
		background: var(--ask-fill);
		color: var(--ask-ink);
		font-weight: 700;
		white-space: nowrap;
	}
	.title {
		font-weight: 700;
		color: inherit;
	}
	.away {
		margin-left: 0.25rem;
		color: var(--accent);
		font-weight: 400;
	}
	.under {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 0.2rem 0.6rem;
		margin-top: 0.2rem;
		color: var(--muted);
	}
	.by {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 0.4rem;
	}
	.actions button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.35rem;
		min-height: 44px;
		min-width: 5.5rem;
		white-space: nowrap;
	}
	.failed {
		margin: 0.4rem 0 0;
		color: var(--danger);
		overflow-wrap: anywhere;
	}
</style>
