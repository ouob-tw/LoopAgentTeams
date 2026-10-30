// The pre-authorization settings as the board edits and shows them. The helper owns the files, their
// checks and their comments; here is only what the page needs: one layer's values, what the form
// changes from them, and what the merged result comes to in words.
export const PREAUTH_ACTIONS = [
	{ name: 'merge', label: '合併', branches: true, target: false },
	{ name: 'push', label: '推送', branches: true, target: false },
	{ name: 'deploy-test', label: '部署測試版', branches: false, target: true },
	{ name: 'deploy-prod', label: '部署正式版', branches: false, target: false },
	{ name: 'install-host', label: '更新主機技能', branches: false, target: false }
] as const;

export const ALLOW_CHOICES = [
	{ value: 'allow', label: '允許', mark: '✓' },
	{ value: 'ask', label: '要問', mark: '?' },
	{ value: 'inherit', label: '沿用上層', mark: '↑' }
] as const;

export type AllowChoice = (typeof ALLOW_CHOICES)[number]['value'];

export type PreauthScope = 'global' | 'project';

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
	layer: PreauthScope;
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
	const unchanged = (saved ?? []).map((item) => item.trim()).filter(Boolean);
	if (JSON.stringify(items) === JSON.stringify(unchanged)) return undefined;
	return items.length ? items : null;
}

/** Each layer sends only what the board edits there: `target` the project's, [advisor] the global's. */
export function changesFrom(layer: PreauthLayer, form: PreauthForm, scope: PreauthScope): PreauthChanges {
	const changes: PreauthChanges = {};
	for (const { name, branches, target } of PREAUTH_ACTIONS) {
		const saved = layer.actions[name] ?? {};
		const edited = form.actions[name];
		const allow = edited.allow === 'inherit' ? undefined : edited.allow === 'allow';
		const action: NonNullable<PreauthChanges['actions']>[string] = {};
		if (allow !== saved.allow) action.allow = allow ?? null;
		const list = branches ? changedList(saved.branches, edited.branches) : undefined;
		if (list !== undefined) action.branches = list;
		if (scope === 'project' && target && form.target.trim() !== (saved.target ?? '').trim()) action.target = form.target.trim() || null;
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

const fromLayer = (origin: PreauthOrigin) => `來自${LAYER_LABELS[origin.layer]}`;

/** What ends up happening for one action. `fromGlobal`: the global file decides it. */
export interface PreauthOutcome {
	asks: boolean;
	text: string;
	note: string;
	fromGlobal: boolean;
}

/** The answer `lat-preauth.py check` would give, as far as settings alone tell: the fixed conditions
 *  and whether it is inside a time window are for when it runs. It wants a branch from the list, so
 *  an empty list is as good as none, but only that a target is written, even blank. `broken` means a
 *  file has errors, which makes every query ask. */
export function outcomeOf(name: string, values: Record<string, PreauthOrigin> = {}, broken = false): PreauthOutcome {
	const asks = (note: string, fromGlobal = false): PreauthOutcome => ({ asks: true, text: '會問你', note, fromGlobal });
	if (broken) return asks('設定檔有錯');
	const { allow } = values;
	if (!allow) return asks('沒有設定');
	const fromGlobal = allow.layer === 'global';
	if (allow.value !== true) return asks(fromLayer(allow), fromGlobal);
	const { branches, target } = PREAUTH_ACTIONS.find((action) => action.name === name)!;
	if (branches && !(values.branches?.value as string[] | undefined)?.length) return asks('缺分支清單', fromGlobal);
	if (target && !values.target) return asks('缺測試環境', fromGlobal);
	return { asks: false, text: '不問直接做', note: `${fromLayer(allow)}${values.hours ? '，時段外會問你' : ''}`, fromGlobal };
}

/** The form after a refused save: back to the file, except what was edited after that save was sent. */
export function revertedForm(saved: PreauthForm, sent: PreauthForm, now: PreauthForm): PreauthForm {
	const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
	const form = structuredClone(saved);
	for (const { name } of PREAUTH_ACTIONS) {
		if (!same(sent.actions[name].allow, now.actions[name].allow)) form.actions[name].allow = now.actions[name].allow;
		if (!same(sent.actions[name].branches, now.actions[name].branches)) form.actions[name].branches = now.actions[name].branches;
	}
	if (sent.target !== now.target) form.target = now.target;
	if (!same(sent.may_settle, now.may_settle)) form.may_settle = now.may_settle;
	if (!same(sent.must_ask, now.must_ask)) form.must_ask = now.must_ask;
	return form;
}

/** One value in effect, as the page shows it under an action. */
export interface PreauthValue {
	text: string;
	note: string;
	fromGlobal: boolean;
}

export function valueOf(origin: PreauthOrigin | undefined): PreauthValue {
	if (!origin) return { text: '', note: '未設定', fromGlobal: false };
	const { value, layer } = origin;
	return { text: (Array.isArray(value) ? value.join('、') : String(value)) || '（空）', note: fromLayer(origin), fromGlobal: layer === 'global' };
}
