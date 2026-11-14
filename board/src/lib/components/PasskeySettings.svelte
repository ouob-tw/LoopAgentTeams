<script lang="ts">
	// The board's passkeys in the settings dialog's 全局設置: each registered one, a new one made by
	// this browser with no code from the host, and deleting one after a confirmation. Only at the
	// board's https address; a test device sees them and changes nothing.
	import KeyRound from '@lucide/svelte/icons/key-round';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { startRegistration } from '@simplewebauthn/browser';
	import { request, type ApiResult } from '#lib/board/api.ts';
	import { TIME_ZONE } from '#lib/board/automation.ts';
	import { PASSKEY_ALREADY_HERE, passkeyAlreadyHere, passkeyBlocked, passkeyRefusal, reportPasskeyRefusal } from '#lib/board/passkey-here.ts';
	import { passkeyName } from '#lib/board/passkey-name.ts';
	import { testDevice } from '#lib/board/test-device.svelte.ts';

	type Listed = { id: string; label: string; createdAt: string; lastUsedAt: string | null };

	let passkeys = $state.raw<Listed[] | null>(null);
	/** Why this page cannot make a passkey; empty when it can. */
	let blocked = $state('');
	let failure = $state('');
	/** This device already holds one of the board's passkeys: nothing failed, nothing to add. */
	let alreadyHere = $state(false);
	let adding = $state(false);
	/** The passkey whose delete waits for a confirmation, and whether it is being deleted. */
	let confirming = $state<string | null>(null);
	let deleting = $state(false);
	let read = 0;
	const locked = $derived(testDevice.view !== null);

	/** Read the list again with nothing failed yet; called when the dialog opens. */
	export async function load() {
		failure = '';
		alreadyHere = false;
		await refresh();
	}

	/** Read the list again, keeping what an add or delete just reported. */
	async function refresh() {
		const mine = ++read;
		const result = await request<{ origin: string | null; passkeys: Listed[] }>('/api/passkeys');
		if (mine !== read) return;
		if (result.ok) {
			passkeys = result.value.passkeys;
			blocked = passkeyBlocked(result.value.origin);
		} else if (!result.unpaired) failure = refusal(result);
	}

	/** What the server's refusal means to the person at the screen. */
	function refusal(result: Extract<ApiResult<unknown>, { ok: false }>): string {
		if (result.kind !== 'http') return '沒有送出，請檢查網路後再按一次。';
		const body = result.body as { error?: string; reason?: string } | null;
		if (body?.error === 'test_device' && body.reason) return body.reason;
		if (body?.error === 'passkeys_unreadable') return '失敗：看板的 passkey 檔讀不出來，請看主機上看板的紀錄。';
		if (body?.error === 'passkey_failed') return '沒有建立 passkey，請再按一次。';
		if (body?.error === 'enroll_expired') return '超過 5 分鐘沒建立 passkey，請再按一次。';
		if (body?.error === 'passkey_unavailable') return '這個網址不能用 passkey。';
		return `失敗：看板伺服器回報錯誤（${result.status}）。`;
	}

	const post = <T,>(path: string, body: object) =>
		request<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

	async function add() {
		if (adding || locked) return;
		adding = true;
		failure = '';
		alreadyHere = false;
		confirming = null;
		const started = await post<{ options: Parameters<typeof startRegistration>[0]['optionsJSON']; enrollment: string }>('/api/passkeys/options', {});
		if (!started.ok) {
			if (!started.unpaired) failure = refusal(started);
			adding = false;
			return;
		}
		let created;
		try {
			created = await startRegistration({ optionsJSON: started.value.options });
		} catch (error) {
			reportPasskeyRefusal('settings', error);
			if (passkeyAlreadyHere(error)) alreadyHere = true;
			else failure = passkeyRefusal(error, true);
			adding = false;
			return;
		}
		const saved = await post('/api/passkeys', { enrollment: started.value.enrollment, response: created });
		if (!saved.ok && !saved.unpaired) failure = refusal(saved);
		await refresh();
		adding = false;
	}

	async function remove(id: string) {
		if (deleting || locked) return;
		deleting = true;
		failure = '';
		alreadyHere = false;
		const result = await request(`/api/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' });
		// One already gone is what was asked for.
		if (!result.ok && !result.unpaired && result.status !== 404) failure = refusal(result);
		confirming = null;
		deleting = false;
		await refresh();
	}

	const day = new Intl.DateTimeFormat('zh-TW', { timeZone: TIME_ZONE, month: 'numeric', day: 'numeric' });
	const dayAndTime = new Intl.DateTimeFormat('zh-TW', { timeZone: TIME_ZONE, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
</script>

<section class="passkeys" aria-label="passkey">
	<h4>passkey</h4>
	{#if passkeys}
		{#if passkeys.length}
			<ul>
				{#each passkeys as passkey (passkey.id)}
					<li data-passkey={passkey.id}>
						<div class="row">
							<KeyRound size="1em" aria-hidden="true" />
							<span class="name">{passkeyName(passkey.label)}</span>
							<code title={passkey.label}>{passkey.id}</code>
							{#if confirming !== passkey.id}
								<button
									class="delete"
									aria-label={`刪除 passkey ${passkey.id}`}
									title="刪除"
									disabled={locked || deleting || adding}
									onclick={() => {
										confirming = passkey.id;
										failure = '';
									}}><Trash2 size="1em" aria-hidden="true" /></button
								>
							{/if}
						</div>
						<p class="note">
							登記 {day.format(Date.parse(passkey.createdAt))}・{passkey.lastUsedAt ? `最後使用 ${dayAndTime.format(Date.parse(passkey.lastUsedAt))}` : '還沒用過'}
						</p>
						{#if confirming === passkey.id}
							<div class="confirm" role="group" aria-label="確認刪除">
								<p class="warn">刪除後這把 passkey 不能再登入。</p>
								<div class="choices">
									<button class="danger" disabled={deleting} onclick={() => void remove(passkey.id)}>{deleting ? '刪除中…' : '確認刪除'}</button>
									<button disabled={deleting} onclick={() => (confirming = null)}>取消</button>
								</div>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<p class="note">還沒有登記 passkey。</p>
		{/if}
		{#if blocked}
			<p class="note blocked"><TriangleAlert size="1em" aria-hidden="true" />{blocked}</p>
		{:else}
			<div class="choices">
				<button class="add" disabled={locked || adding || deleting} onclick={() => void add()}>
					<Plus size="1em" aria-hidden="true" />{adding ? '建立中…' : '新增 passkey'}
				</button>
			</div>
		{/if}
	{/if}
	{#if alreadyHere}
		<p class="here" role="status"><KeyRound size="1em" aria-hidden="true" />{PASSKEY_ALREADY_HERE}</p>
	{/if}
	{#if failure}
		<p class="failed" role="alert">{failure}</p>
	{/if}
</section>

<style>
	h4 {
		margin: 0 0 0.35rem;
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	ul {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin: 0 0 0.5rem;
		padding: 0;
		list-style: none;
	}
	li {
		padding: 0.4rem 0.6rem;
		border: 1px solid var(--line);
		border-radius: var(--radius);
	}
	.row {
		display: flex;
		gap: 0.4rem;
		align-items: center;
	}
	.row :global(svg) {
		flex: none;
	}
	.name {
		min-width: 0;
		overflow-wrap: anywhere;
	}
	code {
		color: var(--muted);
		font-family: var(--mono);
		font-size: max(0.8rem, var(--min-font, 0px));
	}
	.delete {
		display: inline-grid;
		place-items: center;
		min-width: 2.75rem;
		min-height: 2.75rem;
		margin: -0.3rem -0.4rem -0.3rem auto;
		padding: 0;
		border: none;
		background: none;
		color: var(--muted);
	}
	.delete:not(:disabled):hover {
		color: var(--danger);
	}
	.note {
		margin: 0.2rem 0 0;
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.blocked {
		display: flex;
		gap: 0.35em;
		align-items: baseline;
	}
	.blocked :global(svg) {
		flex: none;
		align-self: center;
	}
	.confirm {
		margin-top: 0.4rem;
	}
	.warn {
		margin: 0 0 0.35rem;
		color: var(--warn);
		font-size: max(0.85rem, var(--min-font, 0px));
	}
	.choices {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		align-items: center;
	}
	.add {
		display: inline-flex;
		gap: 0.35rem;
		align-items: center;
	}
	button.danger {
		color: var(--danger);
		border-color: var(--danger);
	}
	.here {
		display: flex;
		gap: 0.35em;
		align-items: baseline;
		margin: 0.35rem 0 0;
		font-size: max(1rem, var(--min-font, 0px));
		text-wrap: balance;
	}
	.here :global(svg) {
		flex: none;
		align-self: center;
	}
	.failed {
		margin: 0.35rem 0 0;
		color: var(--danger);
		font-size: max(0.85rem, var(--min-font, 0px));
	}
	:global(:root[data-theme='light']) .warn {
		font-weight: 700;
	}
</style>
