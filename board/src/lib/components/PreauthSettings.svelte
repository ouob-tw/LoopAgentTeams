<script lang="ts">
	// The global pre-authorization file, in the settings dialog. The form follows the file only when
	// it loads or saves, so a change made elsewhere meanwhile is refused at saving rather than lost.
	import { request } from '#lib/board/api.ts';
	import { ALLOW_CHOICES, PREAUTH_ACTIONS, changesFrom, formFrom, type PreauthForm, type PreauthLayer, type PreauthSettings } from '#lib/board/preauth.ts';

	type Refusal = { reason?: string; problems?: string[]; current?: string | null; toUndo?: string[]; message?: string };

	let layer = $state<PreauthLayer | null>(null);
	let form = $state<PreauthForm | null>(null);
	let refusal = $state<Refusal | null>(null);
	let saved = $state(false);
	let busy = $state(false);

	const changes = $derived(layer && form ? changesFrom(layer, form) : {});
	const dirty = $derived(Object.keys(changes).length > 0);

	function show(settings: PreauthSettings) {
		layer = settings.layers.global;
		form = formFrom(layer);
		refusal = null;
	}

	function refused(result: { kind: string; body?: unknown }, noAnswer: string) {
		refusal = result.kind === 'http' ? ((result.body as Refusal | null) ?? {}) : { reason: noAnswer };
	}

	/** Read the file again. */
	async function reload() {
		busy = true;
		saved = false;
		const result = await request<PreauthSettings>('/api/preauth');
		busy = false;
		if (result.ok) show(result.value);
		else if (!result.unpaired) refused(result, '讀不到設定，請檢查網路後再試。');
	}

	/** Called when the dialog opens: edits not yet saved stay, also those made while it reads. */
	export async function opened() {
		saved = false;
		if (dirty) return;
		const result = await request<PreauthSettings>('/api/preauth');
		if (dirty) return;
		if (result.ok) show(result.value);
		else if (!result.unpaired) refused(result, '讀不到設定，請檢查網路後再試。');
	}

	async function save() {
		if (!layer) return;
		busy = true;
		saved = false;
		const result = await request<PreauthSettings>('/api/preauth', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ layer: 'global', sha256: layer.sha256, changes })
		});
		busy = false;
		if (result.ok) {
			show(result.value);
			saved = true;
		} else if (!result.unpaired) {
			refused(result, '沒有送出，請檢查網路後再按一次。');
		}
	}
</script>

{#snippet list(items: string[], name: string, multiline: boolean)}
	<ul aria-label={name}>
		{#each items as _, index (index)}
			<li>
				{#if multiline}
					<textarea rows="3" aria-label={`${name}第 ${index + 1} 條`} bind:value={items[index]}></textarea>
				{:else}
					<input aria-label={`${name}第 ${index + 1} 條`} bind:value={items[index]} />
				{/if}
				<button aria-label={`刪除${name}第 ${index + 1} 條`} onclick={() => items.splice(index, 1)}>刪除</button>
			</li>
		{/each}
	</ul>
	<button onclick={() => items.push('')}>新增{name}</button>
{/snippet}

<section class="preauth" aria-label="預先授權（全域）">
	<h3>預先授權（全域）</h3>
	<p class="note">專案設定優先；全域選「沿用上層」等於沒設定，會要問。</p>

	{#if layer?.problems.length}
		<div role="alert">
			<p>設定檔有錯，所有查詢都會要問。修好檔案後重新載入。</p>
			<ul class="problems">
				{#each layer.problems as problem}<li>{problem}</li>{/each}
			</ul>
		</div>
	{:else if form}
		{#each PREAUTH_ACTIONS as action (action.name)}
			<section>
				<h4>{action.label}</h4>
				<div class="choices" role="group" aria-label={action.label}>
					{#each ALLOW_CHOICES as choice (choice.value)}
						<button aria-pressed={form.actions[action.name].allow === choice.value} onclick={() => (form!.actions[action.name].allow = choice.value)}>
							{choice.label}
						</button>
					{/each}
				</div>
				{#if action.branches}
					{@render list(form.actions[action.name].branches, `${action.label}分支`, false)}
				{/if}
			</section>
		{/each}
		<section>
			<h4>參謀可自行定案</h4>
			{@render list(form.may_settle, '可自行定案', true)}
		</section>
		<section>
			<h4>參謀仍要問</h4>
			{@render list(form.must_ask, '仍要問', true)}
		</section>
	{/if}

	{#if refusal}
		<div role="alert">
			<p>{refusal.reason ?? refusal.message ?? '沒有寫入，請重新載入。'}</p>
			{#if refusal.problems?.length}
				<ul class="problems">
					{#each refusal.problems as problem}<li>{problem}</li>{/each}
				</ul>
			{/if}
			{#if refusal.toUndo?.length}
				<p>要手動改回：</p>
				<ul class="problems">
					{#each refusal.toUndo as line}<li>{line}</li>{/each}
				</ul>
			{/if}
			{#if refusal.current}
				<p>設定檔目前內容：</p>
				<pre>{refusal.current}</pre>
			{/if}
		</div>
	{/if}

	<div class="choices">
		{#if form && !layer?.problems.length}
			<button class="primary" disabled={busy || !dirty} onclick={save}>儲存</button>
		{/if}
		<button disabled={busy} onclick={reload}>重新載入</button>
		{#if saved && !dirty}<span role="status">已儲存</span>{/if}
	</div>
</section>

<style>
	.preauth {
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
		padding-top: 0.9rem;
		border-top: 1px solid var(--line);
	}
	.preauth > .note {
		margin: -0.6rem 0 0;
	}
	h3 {
		margin: 0;
		font-size: max(1rem, var(--min-font, 0px));
	}
	h4 {
		margin: 0 0 0.35rem;
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.choices {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		align-items: center;
	}
	.note {
		margin: 0.35rem 0 0;
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	ul {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		margin: 0.4rem 0;
		padding: 0;
		list-style: none;
	}
	ul:empty {
		display: none;
	}
	li {
		display: flex;
		gap: 0.4rem;
		align-items: flex-start;
	}
	li input,
	li textarea {
		flex: 1;
		min-width: 0;
	}
	[role='alert'] p {
		margin: 0.35rem 0;
	}
	.problems {
		display: block;
		font-size: max(0.8rem, var(--min-font, 0px));
		overflow-wrap: anywhere;
	}
	pre {
		margin: 0;
		max-height: 12rem;
		overflow: auto;
		font-size: max(0.8rem, var(--min-font, 0px));
	}
</style>
