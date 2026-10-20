<script lang="ts">
	// The new-controller page: pick the client, a folder controllers have run in and the first
	// message, then follow the recent launches below until each controller is running: a launch's
	// row leads to its agent's page once Herdr runs it, and to the controller's information page
	// once it is active. With a
	// Herdr workspace as its target it is the Herdr tab's new-agent form instead: a plain agent in
	// that workspace, with an optional tab name and first message, no LAT start command and no Git
	// project needed, followed until Herdr lists it.
	import { untrack } from 'svelte';
	import { formatTime } from '#lib/board/format.ts';
	import {
		AGENT_LAUNCH_STATE_TEXT,
		CLIENT_LABEL,
		LAUNCH_CLIENTS,
		LAUNCH_STATE_TEXT,
		latCommand,
		launchLink,
		launchSettingsText,
		TAB_NAME_MAX,
		type LaunchClient,
		type LaunchView,
		type Project
	} from '#lib/board/launch.ts';
	import { agentLaunching, launching } from '#lib/board/launching.svelte.ts';
	import { enterMakesNewline } from '#lib/board/messaging.svelte.ts';
	import { DEFAULT_UNREADABLE_TEXT, defaultEffort, modelShort } from '#lib/board/models.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';
	import type { Agent, Controller } from '#lib/board/types.ts';
	import MessageBox from './MessageBox.svelte';

	let {
		controllers,
		agents,
		stamp,
		onopen,
		onagent,
		target = null
	}: {
		controllers: Controller[];
		/** Herdr's agents, as the board data lists them: a launch's tab may have appeared. */
		agents: Agent[];
		/** Changes with every new board data: a launch may have become a controller. */
		stamp: string;
		onopen: (controllerId: string) => void;
		/** Opens an agent's page on the board. */
		onagent: (agentId: string) => void;
		/** The Herdr workspace a plain agent is to open in, with the folders its agents work in, the
		 *  most used first; null for a new controller. */
		target?: { workspace: string; label: string; folders: string[] } | null;
	} = $props();

	const form = $derived(target ? agentLaunching : launching);

	/** How often the list is read again while the page is open: a launch's wait runs out with no new data. */
	const POLL_MS = 15_000;

	$effect(() => {
		void stamp;
		void form.load();
	});
	// The defaults follow the folder, and settings edited meanwhile.
	$effect(() => {
		void stamp;
		void form.loadDefaults(form.folder);
	});
	$effect(() => {
		const shown = form;
		const timer = setInterval(() => {
			void shown.load();
			void shown.loadDefaults(shown.folder);
		}, POLL_MS);
		return () => clearInterval(timer);
	});

	const projects = $derived(form.list?.projects ?? []);
	const options = $derived(form.list?.modelOptions[form.client]);
	/** What the client uses when a field is left to it, as its settings give it for this folder. */
	const defaults = $derived(form.defaults?.folder === form.folder ? form.defaults.clients[form.client] : undefined);
	/** The first option of a field: the value the client's settings give, said outright. */
	function defaultOption(value: string | null | undefined): string {
		if (!defaults) return form.defaultsFailed ? '預設：看板讀取 client 設定失敗' : '預設：讀取中…';
		return `預設：${value ?? DEFAULT_UNREADABLE_TEXT}`;
	}
	/** A model by its short name, with the ID the other options use when that differs. */
	const named = (model: string) => (modelShort(model) === model ? model : `${modelShort(model)}（${model}）`);

	/** The lists differ per client, so a choice made for the other one is dropped. */
	function chooseClient(client: LaunchClient) {
		if (client === form.client) return;
		form.client = client;
		form.model = '';
		form.effort = '';
	}
	const launches = $derived((form.list?.launches ?? []).filter((launch) => (launch.role === 'agent') === (target !== null)));
	const selected = $derived(projects.find((project) => project.path === form.folder));
	// A folder chosen by browsing is judged by the browser's answer, which resolves links like a launch does.
	// A plain agent needs no Git project.
	const needsInit = $derived(
		target === null &&
			(form.browsedGit !== null ? form.browsedGit === false : selected !== undefined && selected.exists && !selected.git)
	);

	/** The folders to pick from: for a plain agent those of the workspace's agents come first. */
	const choices = $derived<{ path: string; inWorkspace: boolean; project: Project | undefined }[]>([
		...(target?.folders ?? []).map((path) => ({ path, inWorkspace: true, project: projects.find((project) => project.path === path) })),
		...projects.filter((project) => !target?.folders.includes(project.path)).map((project) => ({ path: project.path, inWorkspace: false, project }))
	]);
	const chosenListed = $derived(choices.some((choice) => choice.path === form.folder));

	/** The folder used most recently: a controller's project or a plain agent's folder. */
	const recentFolder = $derived.by(() => {
		const project = projects.find((candidate) => candidate.exists);
		const agent = launches.find((launch) => launch.role === 'agent' && launch.state !== 'failed');
		if (!agent || (project && Date.parse(project.lastUsedAt) >= Date.parse(agent.time))) return project?.path ?? '';
		return agent.folder;
	});

	// Another workspace's form starts over from its own folder and tab name; the message is kept.
	// Before the lists are read, a workspace without agents gets the most recent folder once they are.
	$effect(() => {
		if (!target) return;
		const fallback = target.folders[0] ?? recentFolder;
		untrack(() => {
			if (agentLaunching.workspace !== target.workspace) {
				agentLaunching.workspace = target.workspace;
				agentLaunching.tabName = '';
				pick(fallback);
			} else if (agentLaunching.folder === '' && fallback) pick(fallback);
		});
	});

	let sending = $state(false);
	const ready = $derived(
		!sending && form.folder !== '' && (target !== null || (form.text.trim() !== '' && (!needsInit || form.gitInit)))
	);

	const name = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path;

	function pick(path: string, browsedGit: boolean | null = null) {
		form.folder = path;
		form.browsedGit = browsedGit;
		// Consent to `git init` is for one folder only.
		form.gitInit = false;
	}

	let browserOpen = $state(false);
	function toggleBrowser() {
		browserOpen = !browserOpen;
		if (browserOpen && !form.browse) void form.open();
	}

	// A plain agent's message and tab name stay until it appears in Herdr: a time-out keeps them to send again.
	$effect(() => {
		const pending = agentLaunching.sent;
		const launch = pending && (agentLaunching.list?.launches ?? []).find((candidate) => candidate.id === pending.launchId);
		if (!pending || !launch || launch.state === 'starting') return;
		untrack(() => {
			if (launch.state === 'appeared') {
				if (agentLaunching.text === pending.text) agentLaunching.text = '';
				if (agentLaunching.tabName === pending.tabName) agentLaunching.tabName = '';
			}
			agentLaunching.sent = null;
		});
	});

	async function submit() {
		if (!ready) return;
		const sent = form;
		const sentText = sent.text;
		const sentTab = sent.tabName;
		sending = true;
		const result = await sent.start();
		sending = false;
		if (target) {
			if (result.ok && result.launchId) sent.sent = { launchId: result.launchId, text: sentText, tabName: sentTab };
		} else if (result.ok && sent.text === sentText) {
			// Only a launch that was made clears the message; anything typed meanwhile stays too.
			sent.text = '';
			sent.gitInit = false;
		}
		const what = target ? '開新 Agent' : '新建';
		toasts.show(
			result.ok ? 'ok' : 'failed',
			result.ok ? `已開始${what}${result.reason ?? ''}，狀態見${target ? '最近開新' : '最近新建'}。` : `${result.reason}（表單內容保留著）`
		);
	}

	function stateText(launch: LaunchView): string {
		if (launch.state === 'failed') return `✗ 失敗：${launch.error ?? '原因不明'}`;
		const agent = launch.role === 'agent';
		if (agent && launch.state === 'overdue' && launch.follow?.error) return `沒有等到它出現在 Herdr：${launch.follow.error}`;
		const text = (agent && AGENT_LAUNCH_STATE_TEXT[launch.state]) || LAUNCH_STATE_TEXT[launch.state];
		// Without a name nothing more can be said than to look in Herdr.
		return launch.state === 'starting' && launch.error ? `${text}（${launch.error}）` : text;
	}
</script>

<section class="new">
	<h2>{target ? `在 ${target.label} 開新 Agent` : '新建主控'}</h2>
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
					<input type="radio" name="client" value={client} checked={form.client === client} onchange={() => chooseClient(client)} />
					{CLIENT_LABEL[client]}
				</label>
			{/each}
		</fieldset>

		<fieldset class="settings">
			<legend>模型與思考強度</legend>
			<label>
				模型
				<select bind:value={form.model}>
					<option value="">{defaultOption(defaults?.model && named(defaults.model))}</option>
					{#each options?.models ?? [] as option (option)}
						<option value={option}>{option}</option>
					{/each}
				</select>
			</label>
			<label>
				思考強度
				<select bind:value={form.effort}>
					<option value="">{defaultOption(defaults && defaultEffort(defaults, form.model || null))}</option>
					{#each options?.efforts ?? [] as option (option)}
						<option value={option}>{option}</option>
					{/each}
				</select>
			</label>
		</fieldset>

		<fieldset class="folders">
			<legend>{target ? '資料夾（這個工作區的 Agent 在用的在前，再來是曾開過主控的專案）' : '資料夾（曾開過主控的專案，最近使用的在前）'}</legend>
			{#if form.loadFailed && !form.list}
				<p class="failed" role="alert">專案清單讀取失敗。</p>
			{:else if form.list?.projectsError}
				<p class="failed" role="alert">專案清單讀取失敗：{form.list.projectsError}</p>
			{/if}
			{#each choices as choice (choice.path)}
				<label class="project">
					<input type="radio" name="folder" value={choice.path} checked={form.folder === choice.path} onchange={() => pick(choice.path)} />
					<span>
						<strong>{name(choice.path)}</strong>
						<span class="path">{choice.path}</span>
						<span class="when">
							{#if choice.inWorkspace}這個工作區的 Agent 在用{#if choice.project}・{/if}{/if}{#if choice.project}最近 {formatTime(choice.project.lastUsedAt)}{#if !choice.project.exists}・資料夾已不存在{:else if !choice.project.git && !target}・不在 Git 專案裡{/if}{/if}
						</span>
					</span>
				</label>
			{:else}
				{#if form.list}<p class="none">還沒有主控回報過的專案。</p>{/if}
			{/each}
		</fieldset>

		<fieldset class="browser">
			<legend>其他資料夾</legend>
			{#if form.folder && !chosenListed}
				<p class="chosen">已選：<span class="path">{form.folder}</span></p>
			{/if}
			<button type="button" class="toggle" aria-expanded={browserOpen} onclick={toggleBrowser}>
				{browserOpen ? '收起瀏覽' : '從家目錄逐層瀏覽…'}
			</button>
			{#if browserOpen}
				{#if form.browseFailed}
					<p class="failed" role="alert">資料夾清單讀取失敗，請再試一次。</p>
				{/if}
				{#if form.browse}
					{@const level = form.browse}
					<div class="level" class:busy={form.browsing}>
						<p class="path here">{level.path}{level.git ? '・在 Git 專案裡' : '・不在 Git 專案裡'}</p>
						<div class="nav">
							<button type="button" disabled={level.parent === null || form.browsing} onclick={() => void form.open(level.parent!)}>↑ 上一層</button>
							<button type="button" disabled={level.path === level.home || form.browsing} onclick={() => void form.open()}>⌂ 家目錄</button>
							<button type="button" class="use" disabled={form.folder === level.path} onclick={() => {
									pick(level.path, level.git);
									browserOpen = false;
								}}>
								{form.folder === level.path ? '已選這個資料夾' : '選這個資料夾'}
							</button>
						</div>
						{#if level.error}
							<p class="failed" role="alert">讀不到這個資料夾：{level.error}</p>
						{:else}
							<ul>
								{#each level.entries as entry (entry.path)}
									<li>
										<button type="button" onclick={() => void form.open(entry.path)}>
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
				<label><input type="checkbox" bind:checked={form.gitInit} /> 先 git init 再開</label>
			</div>
		{/if}

		{#if target}
			<label class="tab-name">
				分頁名稱（選填）
				<input bind:value={form.tabName} maxlength={TAB_NAME_MAX} placeholder="留空就用 HCOM 與 Herdr 預設的名稱" />
			</label>
		{/if}

		<div class="first">
			<MessageBox
				bind:value={form.text}
				label={target ? '第一則訊息（選填）' : '第一句話'}
				placeholder={`${target ? '第一則訊息（選填）' : '第一句話'}（${enterMakesNewline.current ? 'Enter 換行，按鈕送出' : 'Enter 送出，Shift+Enter 換行'}）`}
				onsend={submit}
			/>
			<p class="note">
				{#if target}
					看板會經 HCOM 在 {target.label} 開一個新分頁，不送 LAT 啟動指令；出現在 Herdr 後{form.tabName.trim() ? '改成上面的分頁名稱，再' : ''}移到這個工作區最前面。Agent 開始後就會用到額度；第一次在某個資料夾開 Claude 時，可能要先到 Herdr 分頁確認信任這個資料夾。
				{:else}
					送出的第一則訊息會是 <code>{latCommand(form.client, '你的話')}</code>。看板會在該專案的 Herdr 工作區開一個新分頁，主控開始後就會用到額度；第一次在某個資料夾開 Claude 時，可能要先到 Herdr 分頁確認信任這個資料夾。
				{/if}
			</p>
		</div>

		<button class="primary" disabled={!ready}>{target ? (sending ? '開新中…' : '開新 Agent') : sending ? '新建中…' : '新建主控'}</button>
	</form>
</section>

<section class="launches">
	<h3>{target ? '最近開新的 Agent' : '最近新建'}</h3>
	{#if form.list?.logError}
		<p class="failed" role="alert">{target ? '開新' : '新建'}紀錄讀取失敗：{form.list.logError}</p>
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
						{#if launch.tabName}<span>分頁名稱 {launch.tabName}</span>{/if}
					</p>
					<p class="title">{launch.folder}</p>
					{#if launchSettingsText(launch)}
						<p class="title">{launchSettingsText(launch)}</p>
					{/if}
					<p class="state" class:failed={launch.state === 'failed'} class:warn={launch.state === 'overdue' || launch.state === 'uncertain'}>
						{stateText(launch)}
					</p>
					<!-- Neither step failing undoes the launch. A controller's state goes by its binding,
					     so why its tab was not moved is said apart. -->
					{#each [launch.follow?.renameError, launch.follow?.moveError] as stepError, index (index)}
						{#if stepError}<p class="state warn">{stepError}（{launch.role === 'agent' ? 'Agent 仍算開成功' : '不影響主控啟動'}）</p>{/if}
					{/each}
					{#if launch.role !== 'agent' && launch.follow?.error && launch.state !== 'active'}
						<p class="state warn">{launch.follow.error}</p>
					{/if}
					{#if launch.role !== 'agent'}
						{@const link = launchLink(launch, launches, controllers, agents)}
						{#if link?.kind === 'controller'}
							<button class="open" onclick={() => onopen(link.id)}>看主控資訊 →</button>
						{:else if link}
							<button class="open" onclick={() => onagent(link.id)}>看這個 Agent →</button>
						{/if}
					{/if}
					{#if launch.role !== 'agent'}
						<p class="text">{latCommand(launch.client, launch.text)}</p>
					{:else if launch.text}
						<p class="text">{launch.text}</p>
					{/if}
				</li>
			{/each}
		</ol>
	{:else if form.list}
		<p class="none">{target ? '還沒有從看板開過新 Agent。' : '還沒有從看板新建過主控。'}</p>
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
		font-size: max(1.1rem, var(--min-font, 0px));
	}
	h3,
	legend {
		margin: 0;
		padding: 0;
		font-size: max(0.8rem, var(--min-font, 0px));
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
		font-size: max(0.85rem, var(--min-font, 0px));
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
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.path {
		font-family: var(--mono);
	}
	.chosen {
		font-size: max(0.85rem, var(--min-font, 0px));
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
		font-size: max(0.75rem, var(--min-font, 0px));
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
		font-size: max(0.85rem, var(--min-font, 0px));
	}
	p {
		margin: 0;
	}
	.note,
	.none {
		font-size: max(0.8rem, var(--min-font, 0px));
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
	.tab-name {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: max(0.85rem, var(--min-font, 0px));
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
		font-size: max(0.75rem, var(--min-font, 0px));
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.title {
		font-family: var(--mono);
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.state {
		font-size: max(0.9rem, var(--min-font, 0px));
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
		font-size: max(0.85rem, var(--min-font, 0px));
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
