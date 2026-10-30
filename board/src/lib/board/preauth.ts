// The pre-authorization settings as the settings dialog edits them. The helper owns the file, its
// checks and its comments; here is only what a form needs: one layer's values, and what the form
// changes from them.
export const PREAUTH_ACTIONS = [
	{ name: 'merge', label: '合併', branches: true },
	{ name: 'push', label: '推送', branches: true },
	{ name: 'deploy-test', label: '部署測試版', branches: false },
	{ name: 'deploy-prod', label: '部署正式版', branches: false },
	{ name: 'install-host', label: '更新主機技能', branches: false }
] as const;

export const ALLOW_CHOICES = [
	{ value: 'allow', label: '允許' },
	{ value: 'ask', label: '要問' },
	{ value: 'inherit', label: '沿用上層' }
] as const;

export type AllowChoice = (typeof ALLOW_CHOICES)[number]['value'];

/** One settings file as `board preauth-read` prints it; no settings when `problems` has any. */
export interface PreauthLayer {
	path: string;
	exists: boolean;
	sha256: string;
	problems: string[];
	actions: Record<string, { allow?: boolean; branches?: string[]; target?: string }>;
	advisor: { may_settle?: string[]; must_ask?: string[] };
}

/** One value in effect and the layer it comes from. */
export interface PreauthOrigin {
	value: unknown;
	layer: 'project' | 'global';
	source: string | null;
}

/** All of `board preauth-read`: each file, and the merged result (empty when a file has errors). */
export interface PreauthSettings {
	layers: { global: PreauthLayer; project?: PreauthLayer };
	problems: string[];
	effective: { actions: Record<string, Record<string, PreauthOrigin>>; advisor: Record<string, PreauthOrigin> };
	/** The project file has an [advisor] section, which is not in effect. */
	project_advisor: boolean;
}

export interface PreauthForm {
	actions: Record<string, { allow: AllowChoice; branches: string[] }>;
	may_settle: string[];
	must_ask: string[];
}

/** What a save sends: only changed keys, where null deletes the key. */
export interface PreauthChanges {
	actions?: Record<string, { allow?: boolean | null; branches?: string[] | null }>;
	advisor?: { may_settle?: string[] | null; must_ask?: string[] | null };
}

export function formFrom(layer: PreauthLayer): PreauthForm {
	const choice = (allow: boolean | undefined): AllowChoice => (allow === undefined ? 'inherit' : allow ? 'allow' : 'ask');
	return {
		actions: Object.fromEntries(
			PREAUTH_ACTIONS.map(({ name }) => [name, { allow: choice(layer.actions[name]?.allow), branches: [...(layer.actions[name]?.branches ?? [])] }])
		),
		may_settle: [...(layer.advisor.may_settle ?? [])],
		must_ask: [...(layer.advisor.must_ask ?? [])]
	};
}

/** The list as it will be saved, or undefined when that is what the file has; empty deletes the key. */
function changedList(saved: string[] | undefined, edited: string[]): string[] | null | undefined {
	const items = edited.map((item) => item.trim()).filter(Boolean);
	if (JSON.stringify(items) === JSON.stringify(saved ?? [])) return undefined;
	return items.length ? items : null;
}

export function changesFrom(layer: PreauthLayer, form: PreauthForm): PreauthChanges {
	const changes: PreauthChanges = {};
	for (const { name, branches } of PREAUTH_ACTIONS) {
		const saved = layer.actions[name] ?? {};
		const edited = form.actions[name];
		const allow = edited.allow === 'inherit' ? undefined : edited.allow === 'allow';
		const action: NonNullable<PreauthChanges['actions']>[string] = {};
		if (allow !== saved.allow) action.allow = allow ?? null;
		const list = branches ? changedList(saved.branches, edited.branches) : undefined;
		if (list !== undefined) action.branches = list;
		if (Object.keys(action).length) (changes.actions ??= {})[name] = action;
	}
	for (const key of ['may_settle', 'must_ask'] as const) {
		const list = changedList(layer.advisor[key], form[key]);
		if (list !== undefined) (changes.advisor ??= {})[key] = list;
	}
	return changes;
}
