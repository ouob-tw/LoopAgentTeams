// The pre-authorization settings as the board edits and shows them. The helper owns the files, their
// checks and their comments; here is only what the page needs: one layer's values, what the form
// changes from them, and the merged result in words.
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
	/** No `project` when no controller was asked for, or its workspace is not in a Git repository. */
	layers: { global: PreauthLayer; project?: PreauthLayer };
	problems: string[];
	effective: { actions: Record<string, Record<string, PreauthOrigin>>; advisor: Record<string, PreauthOrigin> };
	/** The project file has an [advisor] section, which is not in effect. */
	project_advisor: boolean;
}

export type PreauthScope = 'global' | 'project';

export interface PreauthForm {
	actions: Record<string, { allow: AllowChoice; branches: string[] }>;
	target: string;
	may_settle: string[];
	must_ask: string[];
}

/** What a save sends: only changed keys, where null deletes the key. */
export interface PreauthChanges {
	actions?: Record<string, { allow?: boolean | null; branches?: string[] | null; target?: string | null }>;
	advisor?: { may_settle?: string[] | null; must_ask?: string[] | null };
}

export function formFrom(layer: PreauthLayer): PreauthForm {
	const choice = (allow: boolean | undefined): AllowChoice => (allow === undefined ? 'inherit' : allow ? 'allow' : 'ask');
	return {
		actions: Object.fromEntries(
			PREAUTH_ACTIONS.map(({ name }) => [name, { allow: choice(layer.actions[name]?.allow), branches: [...(layer.actions[name]?.branches ?? [])] }])
		),
		target: layer.actions['deploy-test']?.target ?? '',
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

/** Each layer sends only what the board edits there: `target` the project's, [advisor] the global's. */
export function changesFrom(layer: PreauthLayer, form: PreauthForm, scope: PreauthScope = 'global'): PreauthChanges {
	const changes: PreauthChanges = {};
	for (const { name, branches } of PREAUTH_ACTIONS) {
		const saved = layer.actions[name] ?? {};
		const edited = form.actions[name];
		const allow = edited.allow === 'inherit' ? undefined : edited.allow === 'allow';
		const action: NonNullable<PreauthChanges['actions']>[string] = {};
		if (allow !== saved.allow) action.allow = allow ?? null;
		const list = branches ? changedList(saved.branches, edited.branches) : undefined;
		if (list !== undefined) action.branches = list;
		if (scope === 'project' && name === 'deploy-test' && form.target.trim() !== (saved.target ?? '').trim()) action.target = form.target.trim() || null;
		if (Object.keys(action).length) (changes.actions ??= {})[name] = action;
	}
	if (scope === 'global') {
		for (const key of ['may_settle', 'must_ask'] as const) {
			const list = changedList(layer.advisor[key], form[key]);
			if (list !== undefined) (changes.advisor ??= {})[key] = list;
		}
	}
	return changes;
}

const LAYER_LABELS = { project: '專案', global: '全域' } as const;

const inWords = (value: unknown, separator: string) => (typeof value === 'boolean' ? (value ? '允許' : '要問') : Array.isArray(value) ? value.join(separator) : String(value));

/** One value in effect and where it comes from, as the page shows it. */
export function originText(origin: PreauthOrigin | undefined, separator = '、'): string {
	return origin ? `${inWords(origin.value, separator)}，來自${LAYER_LABELS[origin.layer]}` : '未設定';
}

/** What one action has in effect. A time window is not edited here, but "allowed" without it would mislead. */
export function effectiveRows(name: string, values: Record<string, PreauthOrigin> = {}): { label: string; text: string }[] {
	const { branches } = PREAUTH_ACTIONS.find((action) => action.name === name)!;
	return [
		{ label: '授權', text: originText(values.allow) },
		...(branches ? [{ label: '分支', text: originText(values.branches) }] : []),
		...(name === 'deploy-test' ? [{ label: '測試環境', text: originText(values.target) }] : []),
		...(values.hours ? [{ label: '時段', text: originText(values.hours) }] : []),
		...(values.timezone ? [{ label: '時區', text: originText(values.timezone) }] : [])
	];
}
