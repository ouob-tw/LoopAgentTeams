// What the page keeps about starting new controllers, and plain agents from the Herdr tab: each
// form as filled in (it survives a failed launch and leaving the page), the folders to choose from
// and the recent launches.
import { request } from './api.ts';
import { latestOnly, typedFolder } from './folder-search.ts';
import type { FolderSearch, LaunchClient, LaunchList, LaunchResponse } from './launch.ts';
import type { LaunchDefaults } from './models.ts';

export interface StartResult {
	ok: boolean;
	reason: string | null;
	/** The launch's ID in the sent log, when one was made. */
	launchId?: string;
}

/** No answer came back, so a controller may or may not have been started. */
const UNKNOWN_OUTCOME = '沒有收到看板伺服器的回應，不確定有沒有開始新建；重送前請先看下方的新建紀錄。';

class Launching {
	/** The plain-agent form's Herdr workspace; null for the new-controller form. */
	workspace = $state<string | null>(null);
	/** The plain agent's tab name; '' keeps the default one. */
	tabName = $state('');
	/** A plain agent's launch whose message and tab name are cleared from the form only once it
	 *  appears in Herdr, and only if they are still as sent; kept on a time-out. */
	sent = $state<{ launchId: string; text: string; tabName: string } | null>(null);
	client = $state<LaunchClient>('claude');
	/** The folder box as typed: a full path, `~` for the home folder. */
	folder = $state('');
	/** Whether the folder box was typed in since it was last filled in. */
	folderEdited = $state(false);
	text = $state('');
	gitInit = $state(false);
	/** '' starts the client with its own default. */
	model = $state('');
	effort = $state('');
	/** Null until the list is loaded. */
	list = $state<LaunchList | null>(null);
	loadFailed = $state(false);
	#loads = 0;
	/** The answer to the latest search of the folder box, with the text it was for. */
	search = $state<FolderSearch | null>(null);
	/** The text whose search failed; null when the latest one did not. */
	searchFailed = $state<string | null>(null);
	/** Whether folders the projects do not know are in a Git project, as asked; null when it could not be told. */
	gitOf = $state<Record<string, boolean | null>>({});
	/** What each client uses by default, read for this folder; null until read. */
	defaults = $state<{ folder: string; clients: LaunchDefaults } | null>(null);
	defaultsFailed = $state(false);
	#defaultsReads = 0;

	/** The folder the box names, normalized; null when it is not a full path, or names the home
	 *  folder before the board said which one that is. */
	get folderPath(): string | null {
		if (!this.list && this.folder.trim().startsWith('~')) return null;
		return typedFolder(this.folder, this.list?.home ?? '');
	}

	/** Search for what is typed in the folder box (a full path). Only the latest search counts: an
	 *  answer to an earlier one that comes back later is dropped. */
	async find(input: string): Promise<void> {
		const { current, value } = await this.#search(input);
		if (!current) return;
		if (value) this.search = value;
		this.searchFailed = value ? null : input;
	}
	#search = latestOnly(async (input: string): Promise<FolderSearch | undefined> => {
		const result = await request<FolderSearch>(`/api/browse?q=${encodeURIComponent(input)}`);
		// A failure is reported by `find`, unless a newer search has taken over.
		return result.ok ? result.value : undefined;
	});

	/** Ask whether a folder is in a Git project, once. */
	async checkGit(path: string): Promise<void> {
		this.gitOf[path] = null;
		const result = await request<FolderSearch>(`/api/browse?q=${encodeURIComponent(path)}`);
		// A failure leaves it unknown: the row just does not say.
		if (result.ok && result.value.target.state === 'folder') this.gitOf[path] = result.value.target.git;
	}

	/** Read the clients' defaults for a folder ('' for the user's settings alone). A failed read
	 *  drops what was read before: the settings may have changed since. */
	async loadDefaults(folder: string): Promise<void> {
		const read = ++this.#defaultsReads;
		const result = await request<LaunchDefaults>(`/api/launches/defaults?folder=${encodeURIComponent(folder)}`);
		if (!result.ok && result.unpaired) return;
		// A failure is reported below, unless a newer read has taken over.
		const clients = result.ok ? result.value : undefined;
		if (read !== this.#defaultsReads) return;
		this.defaults = clients ? { folder, clients } : null;
		this.defaultsFailed = !clients;
	}

	async load(): Promise<void> {
		const load = ++this.#loads;
		const result = await request<LaunchList>('/api/launches');
		if (!result.ok && result.unpaired) return;
		// A failure is reported below, unless a newer load has taken over.
		const list = result.ok ? result.value : undefined;
		if (load !== this.#loads) return;
		if (list) this.list = list;
		this.loadFailed = !list;
	}

	/** One attempt with the form as it is; the form is kept when it fails. */
	async start(): Promise<StartResult> {
		const result = await request<LaunchResponse>('/api/launches', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				client: this.client,
				folder: this.folderPath ?? this.folder,
				text: this.text,
				gitInit: this.workspace === null && this.gitInit,
				model: this.model || null,
				effort: this.effort || null,
				agent: this.workspace === null ? null : { workspace: this.workspace, tabName: this.tabName.trim() }
			})
		});
		if (!result.ok && result.kind === 'network') {
			void this.load();
			return { ok: false, reason: UNKNOWN_OUTCOME };
		}
		if (!result.ok && result.unpaired) return { ok: false, reason: '這台裝置已不是登入狀態，沒有送出。' };
		if (!result.ok && result.status === 400) return { ok: false, reason: '看板伺服器不接受這份表單，沒有送出。' };
		const body = (result.ok ? result.value : result.body) as LaunchResponse | null | undefined;
		void this.load();
		if (!body) return { ok: false, reason: UNKNOWN_OUTCOME };
		const logNote = body.logError ? `（送出紀錄寫入失敗：${body.logError}）` : '';
		return { ok: body.ok, reason: body.ok ? logNote || null : body.reason + logNote, launchId: body.entry?.id };
	}
}

export const launching = new Launching();
/** The new-agent form of the Herdr tab, kept apart from the new controller's. */
export const agentLaunching = new Launching();
