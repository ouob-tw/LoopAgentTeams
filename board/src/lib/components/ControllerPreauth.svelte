<script lang="ts">
	// A controller's pre-authorization tab: for each action the project's setting and what it comes to
	// once merged with the global file, which is edited in the settings dialog. A result the global
	// file decides opens the dialog there. Each change is saved as it is made.
	import { untrack } from 'svelte';
	import { PreauthEditor, globalFile } from '#lib/board/preauth-editor.svelte.ts';
	import { PREAUTH_ACTIONS, outcomeOf, valueOf, type PreauthOrigin } from '#lib/board/preauth.ts';
	import { openSettings } from '#lib/board/settings-link.ts';
	import PreauthAllow from './PreauthAllow.svelte';
	import PreauthChips from './PreauthChips.svelte';
	import PreauthNotices from './PreauthNotices.svelte';

	let { controller }: { controller: string } = $props();

	// One editor for one controller: the tab is mounted anew for another.
	const editor = new PreauthEditor(untrack(() => controller));
	export const opened = () => editor.opened();

	const settings = $derived(editor.settings);
	const broken = $derived(!!settings?.problems.length);
	const form = $derived(editor.form);
	/** The project file can be edited, unless there is none or it has errors. */
	const editable = $derived(!!form && !editor.layer?.problems.length);

	$effect(() => {
		if (globalFile.saves) untrack(() => void editor.opened());
	});

	/** What is in effect for one action; nothing when a file has errors, as then none of it counts. */
	const inEffect = (name: string): Record<string, PreauthOrigin> => settings?.effective.actions[name] ?? {};
	const saveTarget = (event: KeyboardEvent) => {
		if (event.key !== 'Enter' || event.isComposing) return;
		event.preventDefault();
		void editor.save();
	};
</script>

{#snippet result(text: string, note: string, fromGlobal: boolean, anchor: string, tone = '')}
	{#if fromGlobal}
		<button class="to-global" aria-label={`${text}，${note}，到設定修改`} onclick={() => openSettings(anchor)}>
			{#if text}<b class={tone}>{text}</b>{' '}{/if}<small>{note}</small>
		</button>
	{:else}
		{#if text}<b class={tone}>{text}</b>{' '}{/if}<small>{note}</small>
	{/if}
{/snippet}

{#snippet valueRow(label: string, name: string, origin: PreauthOrigin | undefined)}
	{@const value = valueOf(origin)}
	<tr class="sub">
		<td class="action">{label}</td>
		<td data-label="專案"></td>
		<td class="result" data-label="結果">{#if !broken}{@render result(value.text, value.note, value.fromGlobal, name)}{/if}</td>
	</tr>
{/snippet}

<section class="project" aria-label="預先授權（專案）">
	<div class="head">
		<h3>專案設定</h3>
		<button class="link" onclick={() => openSettings()}>全域設定請到「設定」</button>
	</div>
	<p class="note">「不問直接做」仍要符合固定條件（測試通過、分支清單等），不符合時還是會問你。</p>

	<PreauthNotices {editor} />

	{#if settings && !editor.layer}
		<p class="note">找不到這個主控所在的 Git 專案，沒有專案設定。</p>
	{/if}

	{#if settings && (editable || !editor.layer)}
		<table>
			<thead><tr><th>動作</th><th>專案</th><th>結果</th></tr></thead>
			<tbody>
				{#each PREAUTH_ACTIONS as action (action.name)}
					{@const values = inEffect(action.name)}
					{@const outcome = outcomeOf(action.name, values, broken)}
					<tr class="main" data-action={action.name}>
						<td class="action">{action.label}</td>
						<td data-label="專案">
							{#if form}<PreauthAllow label={action.label} value={form.actions[action.name].allow} onpick={(choice) => editor.setAllow(action.name, choice)} />{/if}
						</td>
						<td class="result" data-label="結果">{@render result(outcome.text, outcome.note, outcome.fromGlobal, action.name, outcome.asks ? 'asks' : 'goes')}</td>
					</tr>
					{#if action.branches}
						{@const value = valueOf(values.branches)}
						<tr class="sub">
							<td class="action">分支</td>
							<td data-label="專案">
								{#if form}<PreauthChips label={`${action.label}分支`} items={form.actions[action.name].branches} onchange={(branches) => editor.setBranches(action.name, branches)} />{/if}
							</td>
							<td class="result" data-label="結果">{#if !broken}{@render result(value.text, value.note, value.fromGlobal, action.name)}{/if}</td>
						</tr>
					{/if}
					{#if action.target}
						{@const value = valueOf(values.target)}
						<tr class="sub">
							<td class="action">測試環境</td>
							<td data-label="專案">
								{#if form}
									<div class="target">
										<input aria-label="測試環境" bind:value={form.target} onblur={() => editor.save()} onkeydown={saveTarget} />
										<p class="note">部署測試版需要填寫測試環境才會生效</p>
									</div>
								{/if}
							</td>
							<td class="result" data-label="結果">{#if !broken}{@render result(value.text, value.note, value.fromGlobal, action.name)}{/if}</td>
						</tr>
					{/if}
					<!-- A time window is not edited here, but the result depends on it. -->
					{#if values.hours}{@render valueRow('時段', action.name, values.hours)}{/if}
					{#if values.timezone}{@render valueRow('時區', action.name, values.timezone)}{/if}
				{/each}
			</tbody>
		</table>
	{/if}

	<section class="advisor" aria-label="參謀範圍">
		<h3><button class="to-global" onclick={() => openSettings('advisor')}>參謀範圍（全域）</button></h3>
		{#if settings?.project_advisor}<p class="note warn">專案檔的 [advisor] 不生效</p>{/if}
		{#if settings && !broken}
			{#each [{ title: '參謀可自行定案', origin: settings.effective.advisor.may_settle }, { title: '參謀仍要問', origin: settings.effective.advisor.must_ask }] as { title, origin } (title)}
				<div>
					<h4>{title}</h4>
					{#if Array.isArray(origin?.value) && origin.value.length}
						<ul>
							{#each origin.value as item}<li>{item}</li>{/each}
						</ul>
					{:else}
						<p class="note">未設定</p>
					{/if}
				</div>
			{/each}
		{/if}
	</section>
</section>

<style>
	.project {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		container-type: inline-size;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		align-items: center;
		justify-content: space-between;
	}
	h3 {
		margin: 0;
		font-size: max(1rem, var(--min-font, 0px));
	}
	h4 {
		margin: 0 0 0.2rem;
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.note {
		margin: 0;
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.warn {
		color: var(--warn);
	}
	.link {
		padding: 0;
		background: none;
		border: 0;
		color: var(--accent);
		font-size: max(0.85rem, var(--min-font, 0px));
	}
	.link:hover {
		text-decoration: underline;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: max(0.85rem, var(--min-font, 0px));
	}
	th {
		padding: 0.25rem 0.5rem;
		border-bottom: 1px solid var(--line);
		font-size: max(0.75rem, var(--min-font, 0px));
		font-weight: 600;
		text-align: left;
		color: var(--muted);
	}
	td {
		padding: 0.35rem 0.5rem;
		vertical-align: top;
	}
	.main td {
		padding-top: 0.5rem;
		border-top: 1px solid var(--line);
	}
	tbody .main:first-child td {
		border-top: 0;
	}
	.sub td {
		padding-top: 0.1rem;
	}
	.action {
		font-weight: 600;
		white-space: nowrap;
	}
	.sub .action {
		padding-left: 1rem;
		font-weight: 400;
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.result {
		min-width: 7.5rem;
		overflow-wrap: anywhere;
	}
	.result b {
		display: block;
		font-weight: 400;
	}
	.result b.goes,
	.result b.asks {
		font-weight: 600;
	}
	.result b.goes {
		color: var(--ok);
	}
	.result b.asks {
		color: var(--warn);
	}
	small {
		display: block;
		font-size: max(0.75rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.target input {
		width: 100%;
		padding: 0.3rem 0.5rem;
	}
	.to-global {
		padding: 0;
		background: none;
		border: 0;
		font-size: inherit;
		font-weight: inherit;
		text-align: left;
		text-decoration: underline dotted var(--accent);
		text-underline-offset: 3px;
	}
	.to-global:hover {
		color: var(--accent);
	}
	.advisor {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--line);
	}
	ul {
		margin: 0;
		padding-left: 1.1rem;
		font-size: max(0.85rem, var(--min-font, 0px));
		overflow-wrap: anywhere;
	}

	/* At a phone's width each action is a block of labelled lines. */
	@container (max-width: 520px) {
		table,
		tbody,
		tr,
		td {
			display: block;
		}
		thead {
			display: none;
		}
		.main {
			margin-top: 0.6rem;
			padding-top: 0.6rem;
			border-top: 1px solid var(--line);
		}
		tbody .main:first-child {
			margin-top: 0;
			padding-top: 0;
			border-top: 0;
		}
		.main td,
		.sub td,
		td {
			padding: 0.15rem 0;
			border: 0;
		}
		.sub {
			margin-top: 0.3rem;
			padding-left: 0.75rem;
		}
		.sub .action {
			padding-left: 0;
		}
		td[data-label] {
			display: flex;
			gap: 0.5rem;
			align-items: baseline;
		}
		td[data-label]:empty {
			display: none;
		}
		td[data-label]::before {
			content: attr(data-label);
			flex: none;
			width: 2.4rem;
			font-size: max(0.75rem, var(--min-font, 0px));
			color: var(--muted);
		}
		td[data-label] > :global(*) {
			flex: 1;
			min-width: 0;
		}
		.result b,
		.result small {
			display: inline;
			margin-right: 0.4rem;
		}
	}
</style>
