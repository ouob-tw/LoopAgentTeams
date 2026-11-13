<script lang="ts">
	// The mode a new controller starts in, with what the advisors may decide and the time limit, and
	// each project's own mode, in the settings dialog's 全局設置. Each change is saved as it is made,
	// through lat-unattended; a change on another device reads them again here.
	import { request } from '#lib/board/api.ts';
	import { testDevice } from '#lib/board/test-device.svelte.ts';
	import { unattendedUi } from '#lib/board/unattended-ui.svelte.ts';
	import { MODE_LABEL, SCOPE_KEYS, SCOPE_LABEL, type ScopeKey, type UnattendedLayerFile, type UnattendedSettings } from '#lib/board/unattended.ts';

	let settings = $state.raw<UnattendedSettings | null>(null);
	let refusal = $state<string | null>(null);
	let busy = $state(false);
	/** The time limit as typed, saved when it is left. */
	let hours = $state('');
	let read = 0;

	/** Read the files again; called when the dialog opens, and when some device changed them. */
	export async function load() {
		const mine = ++read;
		const result = await request<UnattendedSettings>('/api/unattended/settings');
		if (mine !== read) return;
		if (result.ok) show(result.value);
		else if (!result.unpaired) refusal = failureReason(result) ?? '讀不到無人模式設定，請檢查網路後再試。';
	}

	/** What the server said when it answered with an error (`reason` from a write, `message` from a read); null when no answer came back. */
	function failureReason(result: { kind: string; body?: unknown }): string | null {
		if (result.kind !== 'http') return null;
		const body = result.body as { reason?: unknown; message?: unknown } | null;
		const said = body?.reason ?? body?.message;
		return typeof said === 'string' ? said : null;
	}

	function show(next: UnattendedSettings) {
		settings = next;
		hours = String(next.global.values.max_hours ?? next.initial.max_hours);
		refusal = null;
	}

	let heard = unattendedUi.settingsChanges;
	$effect(() => {
		if (unattendedUi.settingsChanges === heard) return;
		heard = unattendedUi.settingsChanges;
		if (settings) void load();
	});

	/** Saves run one at a time, each naming the hash of the file as the one before it left it, so
	 *  quick changes do not refuse one another. */
	let saving: Promise<unknown> = Promise.resolve();

	/** Save the changes to the global file (no `root`) or that project's; whether they were saved. */
	function save(root: string | null, changes: Record<string, unknown>): Promise<boolean> {
		const next = saving.then(async () => {
			const file = root === null ? settings?.global : settings?.projects.find((project) => project.root === root);
			if (!file) return false;
			busy = true;
			const result = await request<UnattendedSettings>('/api/unattended/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ layer: root === null ? 'global' : 'project', project: root ?? undefined, sha256: file.sha256, changes })
			});
			busy = false;
			if (result.ok) {
				show(result.value);
				return true;
			}
			if (!result.unpaired) {
				refusal = failureReason(result) ?? '沒有送出，請檢查網路後再改一次。';
			}
			return false;
		});
		saving = next;
		return next;
	}

	/** A checkbox shows what the file holds: one whose save failed goes back. */
	async function saveCheck(key: ScopeKey, box: HTMLInputElement) {
		if (!(await save(null, { [key]: box.checked }))) box.checked = scopeOn(key);
	}

	const globalMode = $derived(settings?.global.values.mode === 'unattended' ? 'unattended' : 'manual');
	const scopeOn = (key: ScopeKey) => settings?.global.values[key] ?? settings?.initial[key] ?? true;

	function saveHours() {
		if (!settings) return;
		const value = Number(hours);
		if (!Number.isInteger(value) || value < 1) {
			hours = String(settings.global.values.max_hours ?? settings.initial.max_hours);
			refusal = '時間上限要是 1 以上的整數小時。';
			return;
		}
		if (value !== (settings.global.values.max_hours ?? settings.initial.max_hours)) void save(null, { max_hours: value });
	}

	/** A project's own choice: 跟全局 when it sets no mode. */
	const projectMode = (file: UnattendedLayerFile) => (file.values.mode === 'manual' || file.values.mode === 'unattended' ? file.values.mode : 'follow');
	const PROJECT_CHOICES = [
		{ value: 'follow', label: '跟全局', write: null },
		{ value: 'manual', label: MODE_LABEL.manual, write: 'manual' },
		{ value: 'unattended', label: MODE_LABEL.unattended, write: 'unattended' }
	] as const;
	const locked = $derived(testDevice.view !== null);
</script>

<section class="unattended" aria-label="新主控一開始的模式">
	<h4>新主控一開始的模式</h4>
	{#if refusal}
		<div role="alert">
			<p>{refusal}</p>
			<button disabled={busy} onclick={() => void load()}>重新載入</button>
		</div>
	{/if}
	{#if settings?.global.problems.length}
		<div role="alert">
			<p>設定檔有錯，模式一律當成人工確認。修好檔案後重新載入。</p>
			<ul>
				{#each settings.global.problems as problem}<li>{problem}</li>{/each}
			</ul>
		</div>
	{:else if settings}
		<div class="choices" role="group" aria-label="新主控一開始的模式">
			{#each ['manual', 'unattended'] as const as mode (mode)}
				<button aria-pressed={globalMode === mode} disabled={locked} onclick={() => globalMode !== mode && void save(null, { mode })}>{MODE_LABEL[mode]}</button>
			{/each}
		</div>
		<p class="note">每個專案、每個主控都可以另外改。</p>

		<h4>參謀可以替你決定的事</h4>
		<div class="checks">
			{#each SCOPE_KEYS as key (key)}
				<label>
					<input type="checkbox" checked={scopeOn(key)} disabled={locked} onchange={(event) => void saveCheck(key, event.currentTarget)} />
					<span>{SCOPE_LABEL[key]}</span>
				</label>
			{/each}
		</div>

		<h4>時間上限</h4>
		<div class="hours">
			<input
				type="number"
				min="1"
				step="1"
				inputmode="numeric"
				aria-label="時間上限（小時）"
				bind:value={hours}
				disabled={locked}
				onblur={saveHours}
				onkeydown={(event) => event.key === 'Enter' && saveHours()}
			/>
			<span>小時，額度用完也會停</span>
		</div>

		{#if settings.projects.length}
			<h4>各專案</h4>
			<ul class="projects">
				{#each settings.projects as project (project.root)}
					<li class="project" data-project={project.name}>
						<strong title={project.root}>{project.name}</strong>
						{#if project.problems.length}
							<p class="problem" role="alert">設定檔有錯：{project.problems.join('；')}</p>
						{:else}
							<div class="choices" role="group" aria-label={`${project.name} 的模式`}>
								{#each PROJECT_CHOICES as choice (choice.value)}
									<button
										aria-pressed={projectMode(project) === choice.value}
										disabled={locked}
										onclick={() => projectMode(project) !== choice.value && void save(project.root, { mode: choice.write })}>{choice.label}</button
									>
								{/each}
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	{:else if !refusal}
		<p class="note">讀取中…</p>
	{/if}
</section>

<style>
	.unattended {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	h4 {
		margin: 0.5rem 0 0;
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	h4:first-child {
		margin-top: 0;
	}
	/* A finger's width on a phone (ui-baseline). */
	button {
		min-height: 44px;
	}
	.choices {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.note {
		margin: 0;
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.checks {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	label {
		display: flex;
		gap: 0.5rem;
		align-items: flex-start;
	}
	label input {
		flex: none;
		width: 1.2rem;
		height: 1.2rem;
		margin: 0.15rem 0 0;
	}
	.hours {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
	}
	.hours input {
		width: 5.5rem;
	}
	.projects {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.project {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		min-width: 0;
		padding: 0.5rem 0.6rem;
		border: 1px solid var(--line);
		border-radius: var(--radius);
	}
	.project strong {
		overflow-wrap: anywhere;
	}
	.problem,
	[role='alert'] p {
		margin: 0;
		color: var(--danger);
		overflow-wrap: anywhere;
	}
	[role='alert'] ul {
		margin: 0.2rem 0;
	}
</style>
