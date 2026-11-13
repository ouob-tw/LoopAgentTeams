// Unattended mode as the board shows and edits it. lat-unattended.py owns the settings, the grant
// and every check; here is only what a page needs: one controller's state from `status --json`,
// the settings files from `settings --json`, and the words for them.

export type UnattendedMode = 'manual' | 'unattended';
/** Where a value comes from, as lat-unattended names the layers. */
export type UnattendedLayer = 'controller' | 'project' | 'global' | 'default';

export const SCOPE_KEYS = ['ticket_confirmation', 'assume_defaults', 'prototype_decide'] as const;
export type ScopeKey = (typeof SCOPE_KEYS)[number];
export type UnattendedScope = Record<ScopeKey, boolean>;

/** What the advisors may decide, as the form and the settings say it to the user. */
export const SCOPE_LABEL: Record<ScopeKey, string> = {
	ticket_confirmation: '短流程的票，照你說過的話代為確認',
	assume_defaults: '選得回頭的預設值，記成「假設」',
	prototype_decide: '能先做示意頁的，就先做，不問你'
};
/** The tool's `--scope` word of each. */
export const SCOPE_WORD: Record<ScopeKey, string> = {
	ticket_confirmation: 'ticket-confirmation',
	assume_defaults: 'assume-defaults',
	prototype_decide: 'prototype'
};

export const MODE_LABEL: Record<UnattendedMode, string> = { manual: '人工確認', unattended: '無人模式' };

/** The badge's 「來自…」 of the layer the mode comes from. */
export const FROM_LABEL: Record<UnattendedLayer, string> = {
	controller: '這個主控',
	project: '這個專案',
	global: '全域預設',
	default: '初始值'
};

export interface GrantVersion {
	version: number;
	goal: string;
	done: string[];
	scope: UnattendedScope;
	stop: { quota: boolean; max_hours: number };
	source: string;
	started_at: string;
	ended_at: string | null;
	/** Set on a default start: the controller drafted the goal. */
	note?: string;
}

export interface UnattendedDraft {
	goal: string;
	done: string[];
}

/** One controller's unattended mode, as the board snapshot carries it. */
export type UnattendedView =
	| { state: 'unknown' }
	| { state: 'error'; reason: string }
	| {
			/** `active`: a grant is in effect. `pending-goal`: a default start whose goal the controller has
			 *  not written yet; no grant counts. `none`: manual, or the grant ended. */
			state: 'active' | 'pending-goal' | 'none';
			mode: UnattendedMode;
			/** The layer the mode comes from. */
			layer: UnattendedLayer;
			scope: UnattendedScope;
			maxHours: number;
			/** Each layer's own mode; null where a layer sets none. The project's may be follow-global. */
			layerModes: { controller: string | null; project: string | null; global: string | null };
			version: GrantVersion | null;
			endsAt: string | null;
			draft: UnattendedDraft | null;
			/** The settings have errors, so the mode counts as manual. */
			problems: string[];
	  };

/** Whether the controller is in unattended mode: what the roster's 無人 mark and the badge show. */
export const isUnattended = (view: UnattendedView | undefined): boolean => view?.state === 'active' || view?.state === 'pending-goal';

const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
const textOf = (value: unknown) => (typeof value === 'string' ? value : null);
const LAYERS: UnattendedLayer[] = ['controller', 'project', 'global', 'default'];

/** `lat-unattended status --json` of one controller, as the board keeps it. */
export function unattendedFrom(entry: unknown): UnattendedView {
	const given = record(entry);
	if (given.status !== 'ok') return { state: 'error', reason: textOf(given.reason) ?? '無人模式工具的輸出不是預期的格式' };
	const settings = record(given.settings);
	const value = (key: string) => record(settings[key]).value;
	const layer = textOf(record(settings.mode).layer) as UnattendedLayer;
	const state = given.state;
	const modes = record(given.layer_modes);
	const draft = record(given.draft);
	if ((state !== 'active' && state !== 'pending-goal' && state !== 'none') || !LAYERS.includes(layer) || typeof value('max_hours') !== 'number') {
		return { state: 'error', reason: '無人模式工具的輸出不是預期的格式' };
	}
	return {
		state,
		mode: value('mode') === 'unattended' ? 'unattended' : 'manual',
		layer,
		scope: Object.fromEntries(SCOPE_KEYS.map((key) => [key, value(key) === true])) as UnattendedScope,
		maxHours: value('max_hours') as number,
		layerModes: { controller: textOf(modes.controller), project: textOf(modes.project), global: textOf(modes.global) },
		version: given.version ? (given.version as GrantVersion) : null,
		endsAt: textOf(given.ends_at),
		draft: typeof draft.goal === 'string' && Array.isArray(draft.done) ? { goal: draft.goal, done: draft.done.filter((item) => typeof item === 'string') } : null,
		problems: Array.isArray(given.problems) ? given.problems.filter((item) => typeof item === 'string') : []
	};
}

/** What one layer's own mode says, in the status card's line of layers. */
export function layerModeText(mode: string | null): string {
	if (mode === 'unattended' || mode === 'manual') return MODE_LABEL[mode];
	if (mode === 'follow-global') return '跟全局';
	return '沒有另外設';
}

/** One settings file's [unattended], as `settings --json` prints it. */
export interface UnattendedLayerFile {
	path: string;
	exists: boolean;
	sha256: string;
	problems: string[];
	values: Partial<{ mode: string; ticket_confirmation: boolean; assume_defaults: boolean; prototype_decide: boolean; max_hours: number }>;
}

export interface UnattendedSettings {
	global: UnattendedLayerFile;
	projects: (UnattendedLayerFile & { root: string; name: string })[];
	initial: { mode: UnattendedMode; ticket_confirmation: boolean; assume_defaults: boolean; prototype_decide: boolean; max_hours: number };
}

/** What the form sends. */
export interface GrantForm {
	goal: string;
	/** One condition per line. */
	done: string;
	scope: UnattendedScope;
	maxHours: number;
}

export const doneLines = (done: string) =>
	done
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);

/** Why the form cannot be sent yet; null when it can. */
export function formProblem(form: GrantForm): string | null {
	const missing = [!form.goal.trim() && '這一輪的目標', !doneLines(form.done).length && '怎麼算做完'].filter(Boolean);
	if (missing.length) return `還沒寫${missing.join('和')}，主控要靠它判斷什麼時候算做完。`;
	if (!Number.isInteger(form.maxHours) || form.maxHours < 1) return '時間上限要是 1 以上的整數小時。';
	return null;
}

/** The form for turning it on, from the controller's draft and the settings in effect; for 修改,
 *  from the version in effect. */
export function formFor(view: Extract<UnattendedView, { mode: UnattendedMode }>, editing: boolean): GrantForm {
	const from = editing && view.version ? view.version : null;
	const draft = from ?? view.draft;
	return {
		goal: draft?.goal ?? '',
		done: draft?.done.join('\n') ?? '',
		scope: { ...(from?.scope ?? view.scope) },
		maxHours: from?.stop.max_hours ?? view.maxHours
	};
}
