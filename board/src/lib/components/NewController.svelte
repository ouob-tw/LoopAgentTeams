<script lang="ts">
	// The new-controller page: pick the client, a folder controllers have run in and the first
	// message, then follow the recent launches below until each controller is running.
	import { formatTime } from '#lib/board/format.ts';
	import { CLIENT_LABEL, LAUNCH_CLIENTS, LAUNCH_STATE_TEXT, latCommand, type LaunchClient, type LaunchView } from '#lib/board/launch.ts';
	import { launching, type StartResult } from '#lib/board/launching.svelte.ts';
	import { enterMakesNewline } from '#lib/board/messaging.svelte.ts';
	import type { Controller } from '#lib/board/types.ts';
	import MessageBox from './MessageBox.svelte';

	let {
		controllers,
		stamp,
		onopen
	}: {
		controllers: Controller[];
		/** Changes with every new board data: a launch may have become a controller. */
		stamp: string;
		onopen: (controllerId: string) => void;
	} = $props();

	/** How often the list is read again while the page is open: a launch's wait runs out with no new data. */
	const POLL_MS = 15_000;

	$effect(() => {
		void stamp;
		void launching.load();
	});
	$effect(() => {
		const timer = setInterval(() => void launching.load(), POLL_MS);
		return () => clearInterval(timer);
	});

	const projects = $derived(launching.list?.projects ?? []);
	const options = $derived(launching.list?.modelOptions[launching.client]);

	/** The lists differ per client, so a choice made for the other one is dropped. */
	function chooseClient(client: LaunchClient) {
		if (client === launching.client) return;
		launching.client = client;
		launching.model = '';
		launching.effort = '';
	}
	const launches = $derived(launching.list?.launches ?? []);
	const selected = $derived(projects.find((project) => project.path === launching.folder));
	// A folder chosen by browsing is judged by the browser's answer, which resolves links like a launch does.
	const needsInit = $derived(
		launching.browsedGit !== null
			? launching.browsedGit === false
			: selected !== undefined && selected.exists && !selected.git
	);

	let sending = $state(false);
	let outcome = $state<StartResult | null>(null);
	const ready = $derived(!sending && launching.folder !== '' && launching.text.trim() !== '' && (!needsInit || launching.gitInit));

	const name = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path;

	function pick(path: string, browsedGit: boolean | null = null) {
		launching.folder = path;
		launching.browsedGit = browsedGit;
		// Consent to `git init` is for one folder only.
		launching.gitInit = false;
		outcome = null;
	}

	let browserOpen = $state(false);
	function toggleBrowser() {
		browserOpen = !browserOpen;
		if (browserOpen && !launching.browse) void launching.open();
	}

	async function submit() {
		if (!ready) return;
		const sentText = launching.text;
		sending = true;
		outcome = null;
		const result = await launching.start();
		sending = false;
		// Only a launch that was made clears the message; anything typed meanwhile stays too.
		if (result.ok && launching.text === sentText) {
			launching.text = '';
			launching.gitInit = false;
		}
		outcome = result;
	}

	function stateText(launch: LaunchView): string {
		if (launch.state === 'failed') return `✗ 失敗：${launch.error ?? '原因不明'}`;
		const text = LAUNCH_STATE_TEXT[launch.state];
		// Without a name nothing more can be said than to look in Herdr.
		return launch.state === 'starting' && launch.error ? `${text}（${launch.error}）` : text;
	}
	const onRoster = (id: string | null) => id !== null && controllers.some((controller) => controller.id === id);
</script>

<section class="new">
	<h2>新建主控</h2>
	<form
		onsubmit={(event) => {
			event.preventDefault();
			void submit();
		}}
	>
		<fieldset class="clients">
			<legend>Client</legend>
			{#each LAUNCH_CLIENTS as client (client)}
				<label>
					<input type="radio" name="client" value={client} checked={launching.client === client} onchange={() => chooseClient(client)} />
					{CLIENT_LABEL[client]}
				</label>
			{/each}
		</fieldset>

		<fieldset class="settings">
			<legend>模型與思考強度</legend>
			<label>
				模型
				<select bind:value={launching.model}>
					<option value="">client 預設</option>
					{#each options?.models ?? [] as option (option)}
						<option value={option}>{option}</option>
					{/each}
				</select>
			</label>
			<label>
				思考強度
				<select bind:value={launching.effort}>
					<option value="">client 預設</option>
					{#each options?.efforts ?? [] as option (option)}
						<option value={option}>{option}</option>
					{/each}
				</select>
			</label>
		</fieldset>

		<fieldset class="folders">
			<legend>資料夾（曾開過主控的專案，最近使用的在前）</legend>
			{#if launching.loadFailed && !launching.list}
				<p class="failed" role="alert">專案清單讀取失敗。</p>
			{:else if launching.list?.projectsError}
				<p class="failed" role="alert">專案清單讀取失敗：{launching.list.projectsError}</p>
			{/if}
			{#each projects as project (project.path)}
				<label class="project">
					<input
						type="radio"
						name="folder"
						value={project.path}
						checked={launching.folder === project.path}
						onchange={() => pick(project.path)}
					/>
					<span>
						<strong>{name(project.path)}</strong>
						<span class="path">{project.path}</span>
						<span class="when">
							最近 {formatTime(project.lastUsedAt)}{#if !project.exists}・資料夾已不存在{:else if !project.git}・不在 Git 專案裡{/if}
						</span>
					</span>
				</label>
			{:else}
				{#if launching.list}<p class="none">還沒有主控回報過的專案。</p>{/if}
			{/each}
		</fieldset>

		<fieldset class="browser">
			<legend>其他資料夾</legend>
			{#if launching.folder && !selected}
				<p class="chosen">已選：<span class="path">{launching.folder}</span></p>
			{/if}
			<button type="button" class="toggle" aria-expanded={browserOpen} onclick={toggleBrowser}>
				{browserOpen ? '收起瀏覽' : '從家目錄逐層瀏覽…'}
			</button>
			{#if browserOpen}
				{#if launching.browseFailed}
					<p class="failed" role="alert">資料夾清單讀取失敗，請再試一次。</p>
				{/if}
				{#if launching.browse}
					{@const level = launching.browse}
					<div class="level" class:busy={launching.browsing}>
						<p class="path here">{level.path}{level.git ? '・在 Git 專案裡' : '・不在 Git 專案裡'}</p>
						<div class="nav">
							<button type="button" disabled={level.parent === null || launching.browsing} onclick={() => void launching.open(level.parent!)}>↑ 上一層</button>
							<button type="button" disabled={level.path === level.home || launching.browsing} onclick={() => void launching.open()}>⌂ 家目錄</button>
							<button type="button" class="use" disabled={launching.folder === level.path} onclick={() => {
									pick(level.path, level.git);
									browserOpen = false;
								}}>
								{launching.folder === level.path ? '已選這個資料夾' : '選這個資料夾'}
							</button>
						</div>
						{#if level.error}
							<p class="failed" role="alert">讀不到這個資料夾：{level.error}</p>
						{:else}
							<ul>
								{#each level.entries as entry (entry.path)}
									<li>
										<button type="button" onclick={() => void launching.open(entry.path)}>
											<span>{entry.name}</span>{#if entry.git}<span class="tag">Git</span>{/if}
										</button>
									</li>
								{:else}
									<li class="none">這裡沒有可見的資料夾。</li>
								{/each}
							</ul>
						{/if}
					</div>
				{/if}
			{/if}
		</fieldset>

		{#if needsInit}
			<div class="init">
				<p>這個資料夾不在 Git 專案裡，主控在這裡不能啟用。勾選後看板會先在這裡執行一次 <code>git init</code>，成功才開啟主控。</p>
				<label><input type="checkbox" bind:checked={launching.gitInit} /> 先 git init 再開</label>
			</div>
		{/if}

		<div class="first">
			<MessageBox
				bind:value={launching.text}
				label="第一句話"
				placeholder={`第一句話（${enterMakesNewline.current ? 'Enter 換行，按鈕送出' : 'Enter 送出，Shift+Enter 換行'}）`}
				onsend={submit}
			/>
			<p class="note">
				送出的第一則訊息會是 <code>{latCommand(launching.client, '你的話')}</code>。看板會在該專案的 Herdr 工作區開一個新分頁，主控開始後就會用到額度；第一次在某個資料夾開 Claude 時，可能要先到 Herdr 分頁確認信任這個資料夾。
			</p>
		</div>

		<button class="primary" disabled={!ready}>{sending ? '新建中…' : '新建主控'}</button>
		{#if outcome?.ok}
			<p class="note" role="status">✓ 已開始新建{outcome.reason ?? ''}，狀態見下方的新建紀錄。</p>
		{:else if outcome}
			<p class="note failed" role="alert">✗ {outcome.reason}（表單內容保留著）</p>
		{/if}
	</form>
</section>

<section class="launches">
	<h3>最近新建</h3>
	{#if launching.list?.logError}
		<p class="failed" role="alert">新建紀錄讀取失敗：{launching.list.logError}</p>
	{/if}
	{#if launches.length}
		<ol>
			{#each launches as launch (launch.id)}
				<li data-state={launch.state}>
					<p class="meta">
						<time datetime={launch.time}>{formatTime(launch.time)}</time>
						<span>{CLIENT_LABEL[launch.client]}</span>
						{#if launch.hcomName}<span>@{launch.hcomName}</span>{/if}
						{#if launch.herdrWorkspace}
							<span>Herdr 工作區 {launch.herdrWorkspaceLabel || launch.herdrWorkspace}{launch.workspaceCreated ? '（新建）' : ''}</span>
						{/if}
						{#if launch.gitInit}<span>已 git init</span>{/if}
					</p>
					<p class="title">{launch.folder}</p>
					{#if launch.model || launch.effort}
						<p class="title">模型 {launch.model ?? 'client 預設'}・思考強度 {launch.effort ?? 'client 預設'}</p>
					{/if}
					<p class="state" class:failed={launch.state === 'failed'} class:warn={launch.state === 'overdue' || launch.state === 'uncertain'}>
						{stateText(launch)}
					</p>
					{#if launch.state === 'active' && onRoster(launch.controllerId)}
						<button class="open" onclick={() => onopen(launch.controllerId!)}>看主控資訊 →</button>
					{/if}
					<p class="text">{latCommand(launch.client, launch.text)}</p>
				</li>
			{/each}
		</ol>
	{:else if launching.list}
		<p class="none">還沒有從看板新建過主控。</p>
	{/if}
</section>

<style>
	.new,
	.launches,
	form {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	h2 {
		margin: 0;
		font-size: 1.1rem;
	}
	h3,
	legend {
		margin: 0;
		padding: 0;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--muted);
	}
	fieldset {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		margin: 0;
		padding: 0;
		border: 0;
		min-width: 0;
	}
	.clients,
	.settings {
		flex-direction: row;
		flex-wrap: wrap;
		gap: 0.35rem 1.2rem;
	}
	.clients legend,
	.settings legend {
		width: 100%;
		margin-bottom: 0.35rem;
	}
	.settings label {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: 0.85rem;
	}
	.project {
		display: flex;
		gap: 0.6rem;
		align-items: flex-start;
		padding: 0.5rem 0.7rem;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		cursor: pointer;
	}
	.project > span {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.path,
	.when {
		font-size: 0.8rem;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.path {
		font-family: var(--mono);
	}
	.chosen {
		font-size: 0.85rem;
	}
	.toggle,
	.nav button,
	.level li button {
		padding: 0.5rem 0.7rem;
		min-height: 2.5rem;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: none;
		color: inherit;
		text-align: left;
	}
	.toggle {
		align-self: flex-start;
	}
	.level {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.level.busy {
		opacity: 0.6;
	}
	.here {
		overflow-wrap: anywhere;
	}
	.nav {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.level ul {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		margin: 0;
		padding: 0;
		list-style: none;
		max-height: 50vh;
		overflow-y: auto;
	}
	.level li button {
		display: flex;
		justify-content: space-between;
		gap: 0.6rem;
		width: 100%;
		overflow-wrap: anywhere;
	}
	.tag {
		font-size: 0.75rem;
		color: var(--muted);
	}
	button:disabled {
		opacity: 0.5;
	}
	.init {
		padding: 0.5rem 0.7rem;
		border: 1px solid var(--warn);
		border-radius: var(--radius);
	}
	.init p {
		margin: 0 0 0.35rem;
		font-size: 0.85rem;
	}
	p {
		margin: 0;
	}
	.note,
	.none {
		font-size: 0.8rem;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.first {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	form > .primary {
		align-self: flex-start;
	}
	ol {
		display: grid;
		gap: 0.5rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	li {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: 0.5rem 0.7rem;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.2rem 0.8rem;
		font-size: 0.75rem;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.title {
		font-family: var(--mono);
		font-size: 0.8rem;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.state {
		font-size: 0.9rem;
		overflow-wrap: anywhere;
	}
	.text {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.open {
		align-self: flex-start;
		padding: 0;
		background: none;
		border: 0;
		font-size: 0.85rem;
		color: var(--accent);
	}
	.open:hover {
		text-decoration: underline;
	}
	.warn {
		color: var(--warn);
	}
	.failed {
		color: var(--danger);
	}
</style>
