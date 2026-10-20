<script lang="ts">
	// The new-controller page: the folder controllers have run in, typed with suggestions as it is,
	// then the first message and the client's settings in one row, then follow the recent launches
	// below until each controller is running: a launch's row leads to its agent's page once Herdr
	// runs it, and to the controller's information page once it is active. With a Herdr workspace
	// as its target it is the Herdr tab's new-agent form instead: a plain agent in that workspace,
	// with an optional tab name and first message, no LAT start command and no Git project needed,
	// followed until Herdr lists it. A folder that is not there yet is created when the form is sent.
	import { untrack } from 'svelte';
	import { folderName, listKey, pathMatches, shownSearch, suggestedFolders } from '#lib/board/folder-search.ts';
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
	/** How long typing pauses before the folder box is searched. */
	const SEARCH_DELAY_MS = 120;

	$effect(() => {
		void stamp;
		void form.load();
	});
	// The defaults follow the folder, and settings edited meanwhile.
	$effect(() => {
		void stamp;
		void form.loadDefaults(form.folderPath ?? '');
	});
	$effect(() => {
		const shown = form;
		const timer = setInterval(() => {
			void shown.load();
			void shown.loadDefaults(shown.folderPath ?? '');
		}, POLL_MS);
		return () => clearInterval(timer);
	});

	const projects = $derived(form.list?.projects ?? []);
	const options = $derived(form.list?.modelOptions[form.client]);
	/** What the client uses when a field is left to it, as its settings give it for this folder. */
	const defaults = $derived(form.defaults?.folder === (form.folderPath ?? '') ? form.defaults.clients[form.client] : undefined);
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

	// --- The folder box ------------------------------------------------------------------------

	// Search the folder as typed once typing pauses; only the answer for the text now in the box counts.
	$effect(() => {
		const shown = form;
		const input = shown.folder;
		if (shown.folderPath === null) return;
		const timer = setTimeout(() => void shown.find(input), SEARCH_DELAY_MS);
		return () => clearTimeout(timer);
	});
	const found = $derived(shownSearch(form.search, form.folder));
	const typed = $derived(found?.target ?? null);
	const searchFailed = $derived(form.searchFailed === form.folder);

	/** One row of the folder list: a known folder, or one under the typed level. */
	interface Row {
		path: string;
		/** In a Git project; null when not known. */
		git: boolean | null;
		inWorkspace: boolean;
		project: Project | undefined;
	}
	const known = (path: string): Row => {
		const project = projects.find((candidate) => candidate.path === path);
		const git = project ? (project.exists ? project.git : null) : (form.gitOf[path] ?? null);
		return { path, git, inWorkspace: target?.folders.includes(path) ?? false, project };
	};
	/** Before anything is typed, the most recent folders; then the known folders matching what is
	 *  typed, and the folders under the typed level, each once. */
	const rows = $derived.by<Row[]>(() => {
		const all = [...(target?.folders ?? []), ...projects.map((project) => project.path)];
		if (!form.folderEdited || form.folder.trim() === '') return suggestedFolders(target?.folders ?? [], projects.map((project) => project.path)).map(known);
		const home = form.list?.home ?? '';
		const entries = found?.entries ?? [];
		// A folder found under the typed level says whether it is in Git, a known one included.
		const withGit = (row: Row): Row => {
			const entry = entries.find((candidate) => candidate.path === row.path);
			return entry ? { ...row, git: entry.git } : row;
		};
		const matched = [...new Set(all)].filter((path) => pathMatches(path, form.folder, home)).map((path) => withGit(known(path)));
		const listed = entries.filter((entry) => !matched.some((row) => row.path === entry.path)).map((entry) => withGit(known(entry.path)));
		return [...matched, ...listed];
	});

	/** What a row says about its folder: whether the workspace uses it, when it was last used or
	 *  that it is gone, and whether it is in a Git project. */
	function rowFacts(row: Row): string {
		const facts: string[] = [];
		if (row.inWorkspace) facts.push('這個工作區的 Agent 在用');
		if (row.project) facts.push(row.project.exists ? `最近 ${formatTime(row.project.lastUsedAt)}` : '資料夾已不存在');
		if (row.git !== null) facts.push(row.git ? '在 Git 專案裡' : '不在 Git 專案裡');
		return facts.join('・');
	}

	let listOpen = $state(false);
	/** The row the arrow keys are on; -1 for none. */
	let active = $state(-1);
	const shownRows = $derived(listOpen ? rows : []);
	// A folder the projects do not know, such as one a workspace's agent works in, is asked about.
	$effect(() => {
		for (const row of shownRows) if (row.git === null && !row.project && !(row.path in form.gitOf)) void form.checkGit(row.path);
	});
	// The row the arrows are on stays in sight, and is dropped when the list no longer has it.
	$effect(() => {
		if (active >= shownRows.length) active = -1;
		else if (active >= 0) document.getElementById(`folder-row-${active}`)?.scrollIntoView({ block: 'nearest' });
	});

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
			} else if (agentLaunching.folder === '' && !agentLaunching.folderEdited && fallback) pick(fallback);
		});
	});
	// A new controller starts from the most recent folder, unless the box was typed in.
	$effect(() => {
		if (target) return;
		const fallback = recentFolder;
		untrack(() => {
			if (launching.folder === '' && !launching.folderEdited && fallback) pick(fallback);
		});
	});

	function pick(path: string) {
		form.folder = path;
		form.folderEdited = false;
		// Consent to `git init` is for one folder only.
		form.gitInit = false;
	}

	function typing() {
		form.folderEdited = true;
		form.gitInit = false;
		listOpen = true;
		active = -1;
	}

	function choose(row: Row) {
		pick(row.path);
		listOpen = false;
		active = -1;
	}

	/** Arrows move along the list, Tab takes the folder and goes on into it, Enter takes it, Esc
	 *  closes the list (`listKey`). Enter never sends the form from here. */
	function keydown(event: KeyboardEvent) {
		const done = listKey(event.key, event.shiftKey, { open: listOpen, active, count: shownRows.length });
		if (!done.handled) return;
		event.preventDefault();
		const rowsNow = shownRows;
		listOpen = done.open;
		active = done.active;
		if (done.choose !== null) choose(rowsNow[done.choose]!);
		if (done.complete !== null) {
			form.folder = `${rowsNow[done.complete]!.path.replace(/\/$/, '')}/`;
			typing();
		}
	}

	// A plain agent needs no Git project; a folder still to be created is made one with the controller.
	const needsInit = $derived(target === null && typed?.state === 'folder' && !typed.git);
	const willCreate = $derived(typed?.state === 'missing' && typed.cannotCreate === null);
	/** Why the folder cannot be sent as it is typed; null when it can. */
	const folderProblem = $derived.by(() => {
		if (form.folder.trim() === '') return '請輸入資料夾。';
		if (form.folderPath === null) return form.list ? '請輸入完整路徑（以 / 或 ~ 開頭）。' : null;
		if (typed?.state === 'not-folder') return '這不是資料夾。';
		if (typed?.state === 'missing' && typed.cannotCreate) return `這個資料夾不存在，也不能建立：${typed.cannotCreate}。`;
		return null;
	});
	// Until the search says how the folder stands it cannot be sent, unless the search failed:
	// then the server judges it.
	const folderKnown = $derived(typed !== null || searchFailed);

	let sending = $state(false);
	const ready = $derived(
		!sending &&
			folderProblem === null &&
			folderKnown &&
			(target !== null || (form.text.trim() !== '' && (!needsInit || form.gitInit)))
	);

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
		const sentFolder = sent.folder;
		sending = true;
		const result = await sent.start();
		sending = false;
		// The folder may have been created: what the box says about it is read again.
		if (sent.folder === sentFolder && sent.folderPath !== null) void sent.find(sentFolder);
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
		<div class="folder">
			<label for="folder-box">資料夾</label>
			<div class="combo">
				<input
					id="folder-box"
					role="combobox"
					autocomplete="off"
					spellcheck="false"
					aria-autocomplete="list"
					aria-expanded={shownRows.length > 0}
					aria-controls="folder-list"
					aria-activedescendant={active >= 0 && active < shownRows.length ? `folder-row-${active}` : undefined}
					placeholder="~/專案資料夾"
					bind:value={form.folder}
					oninput={typing}
					onfocus={() => (listOpen = true)}
					onblur={() => {
						listOpen = false;
						active = -1;
					}}
					onkeydown={keydown}
				/>
				{#if shownRows.length}
					<!-- Pressing a row keeps the focus in the box, so the list is not closed before the click. -->
					<ul id="folder-list" role="listbox" aria-label="符合的資料夾" onmousedown={(event) => event.preventDefault()}>
						{#each shownRows as row, index (row.path)}
							<li id={`folder-row-${index}`} role="option" aria-selected={index === active} class:active={index === active}>
								<button type="button" tabindex="-1" onclick={() => choose(row)}>
									<strong>{folderName(row.path)}</strong>
									<span class="path">{row.path}</span>
									<span class="when">{rowFacts(row)}</span>
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
			{#if form.loadFailed && !form.list}
				<p class="failed" role="alert">專案清單讀取失敗。</p>
			{:else if form.list?.projectsError}
				<p class="failed" role="alert">專案清單讀取失敗：{form.list.projectsError}</p>
			{/if}
			{#if folderProblem && form.folderEdited}
				<p class="failed">{folderProblem}</p>
			{:else if willCreate}
				<p class="note">這個資料夾還不存在，送出時會建立{target === null ? '並 git init' : ''}。</p>
			{:else if searchFailed}
				<p class="note">讀不到這個資料夾的狀態，送出時由看板確認。</p>
			{/if}
			{#if needsInit}
				<label class="init"><input type="checkbox" bind:checked={form.gitInit} /> 不在 Git 專案裡：先 git init 再開</label>
			{/if}
		</div>

		<MessageBox
			bind:value={form.text}
			label={target ? '第一則訊息（選填）' : '第一句話'}
			placeholder={`${target ? '第一則訊息（選填）' : '第一句話'}（${enterMakesNewline.current ? 'Enter 換行，按鈕送出' : 'Enter 送出，Shift+Enter 換行'}）`}
			onsend={submit}
		/>

		<div class="settings">
			<div class="clients" role="radiogroup" aria-label="Client">
				{#each LAUNCH_CLIENTS as client (client)}
					<label>
						<input type="radio" name="client" value={client} checked={form.client === client} onchange={() => chooseClient(client)} />
						{CLIENT_LABEL[client]}
					</label>
				{/each}
			</div>
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
			{#if target}
				<label class="tab-name">
					分頁名稱（選填）
					<input bind:value={form.tabName} maxlength={TAB_NAME_MAX} placeholder="留空用預設名稱" />
				</label>
			{/if}
		</div>

		<button class="primary" disabled={!ready}>{target ? (sending ? '開新中…' : '開新 Agent') : sending ? '新建中…' : '新建主控'}</button>
		<p class="note">
			{#if target}
				不送 LAT 啟動指令，Agent 開始後就會用到額度；第一次在某個資料夾開 Claude 時，可能要先到 Herdr 分頁確認信任這個資料夾。
			{:else}
				第一則訊息會是 <code>{latCommand(form.client, '你的話')}</code>，主控開始後就會用到額度；第一次在某個資料夾開 Claude 時，可能要先到 Herdr 分頁確認信任這個資料夾。
			{/if}
		</p>
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
						{#if launch.folderCreated}<span>已新建資料夾</span>{/if}
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
						{@const link = launchLink(launch, form.list?.launches ?? [], controllers, agents)}
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
	.folder > label {
		margin: 0;
		padding: 0;
		font-size: max(0.8rem, var(--min-font, 0px));
		font-weight: 600;
		color: var(--muted);
	}
	.folder {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		min-width: 0;
	}
	.combo {
		position: relative;
	}
	.combo input {
		width: 100%;
		box-sizing: border-box;
		font-family: var(--mono);
	}
	.combo ul {
		position: absolute;
		z-index: 5;
		top: calc(100% + 2px);
		left: 0;
		right: 0;
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0.2rem;
		list-style: none;
		max-height: 50vh;
		overflow-y: auto;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--radius);
	}
	.combo li button {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.1rem;
		width: 100%;
		min-height: 2.5rem;
		padding: 0.4rem 0.6rem;
		border: 0;
		background: none;
		color: inherit;
		text-align: left;
		overflow-wrap: anywhere;
	}
	.combo li.active button,
	.combo li button:hover {
		background: var(--bg);
		outline: 1px solid var(--accent);
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
	.init {
		align-self: flex-start;
		padding: 0.4rem 0.6rem;
		border: 1px solid var(--warn);
		border-radius: var(--radius);
		font-size: max(0.85rem, var(--min-font, 0px));
	}
	.settings {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.5rem 1rem;
	}
	.settings > label {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		min-width: 0;
		font-size: max(0.85rem, var(--min-font, 0px));
	}
	.settings select {
		max-width: 100%;
	}
	.clients {
		display: flex;
		gap: 0.8rem;
		padding-bottom: 0.4rem;
	}
	.tab-name {
		flex: 1 1 12rem;
	}
	button:disabled {
		opacity: 0.5;
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
	ol > li {
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
