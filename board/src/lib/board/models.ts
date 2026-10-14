// A controller's model and effort: the choices the board offers, the client arguments that carry
// them, and how a switch is shown and checked against the turns that follow it. Shared by the
// server and the page.
import type { SentEntry } from './answers.ts';
import type { LaunchClient } from './launch.ts';

export interface ClientOptions {
	models: string[];
	efforts: string[];
}

export type ModelOptions = Record<LaunchClient, ClientOptions>;

/** The built-in lists; `LAT_BOARD_MODEL_OPTIONS` replaces any of them. Only what the forms offer:
 *  the board never checks that a model is really available. */
export const DEFAULT_MODEL_OPTIONS: ModelOptions = {
	claude: {
		models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
		efforts: ['low', 'medium', 'high', 'xhigh']
	},
	codex: {
		models: ['gpt-6.1-sol', 'gpt-6-astra'],
		efforts: ['low', 'medium', 'high', 'xhigh']
	}
};

/** A model and effort to use. Null leaves that one as it is: the client's default for a new
 *  controller, the current setting for a switch or a wake. */
export interface ModelChoice {
	model: string | null;
	effort: string | null;
}

export const NO_CHOICE: ModelChoice = { model: null, effort: null };

export const chose = (choice: ModelChoice | undefined | null): choice is ModelChoice =>
	!!choice && (choice.model !== null || choice.effort !== null);

/** Whether the choice holds only values the lists offer this client. */
export function offered(options: ClientOptions, choice: ModelChoice): boolean {
	return (choice.model === null || options.models.includes(choice.model)) && (choice.effort === null || options.efforts.includes(choice.effort));
}

/**
 * The client arguments for a choice. Claude takes `--model` and `--effort`. Codex only ever gets
 * `-c` overrides: an explicit `--model` would beat every later `-c model=`, and of several `-c`
 * for one key the last counts, so a switch can still override what the board set before.
 */
export function modelArgs(client: LaunchClient, choice: ModelChoice): string[] {
	const args: string[] = [];
	if (client === 'claude') {
		if (choice.model !== null) args.push('--model', choice.model);
		if (choice.effort !== null) args.push('--effort', choice.effort);
	} else {
		if (choice.model !== null) args.push('-c', `model=${JSON.stringify(choice.model)}`);
		if (choice.effort !== null) args.push('-c', `model_reasoning_effort=${JSON.stringify(choice.effort)}`);
	}
	return args;
}

/**
 * The settings a resume carries: the choice, and when it changes the model but keeps the effort,
 * the effort the latest turn used, so the new model does not fall back to its own default. That
 * carried effort is not something the user chose. Left out when it is not known.
 */
export function resumeChoice(choice: ModelChoice, current: CurrentSettings | null): ModelChoice {
	if (choice.model === null || choice.effort !== null) return choice;
	return { model: choice.model, effort: current?.effort ?? null };
}

/** Whether a choice changes the model and keeps the effort, so the current effort is carried. */
export const carriesEffort = (choice: ModelChoice) => choice.model !== null && choice.effort === null;

export const EFFORT_UNKNOWN_TEXT = '無法確認目前的思考強度，換模型後可能改用該模型的預設';

/** Whether Codex launch arguments name a model outright (`--model`, `-m`, `--model=…`, `--oss`):
 *  hcom repeats them on every resume, and they beat any `-c model=`, so its model cannot change. */
export function fixedModel(args: string[]): boolean {
	for (const arg of args) {
		if (arg === '--') return false;
		if (arg === '--model' || arg.startsWith('--model=') || arg === '--oss' || /^-m(?:$|[^-])/.test(arg)) return true;
	}
	return false;
}

/** The model and effort of the latest turn, and when that turn started; read by the helper from
 *  the client's own record. A field it could not tell is null. */
export interface CurrentSettings {
	model: string | null;
	effort: string | null;
	time: string | null;
}

/** What `GET /api/model` answers for one controller. */
export interface ModelStatus {
	client: string;
	/** What the forms offer this client; null for a client the board cannot switch. */
	options: ClientOptions | null;
	/** Whether the controller's client is in hcom's agent list; null when the list could not be read. */
	running: boolean | null;
	/** hcom's status of the running client, e.g. `listening`. */
	status: string | null;
	/** Why the agent list could not be read. */
	reason: string | null;
	/** Codex only: whether its launch arguments fix the model, or that they could not be read. */
	lock: 'free' | 'fixed' | 'unknown' | null;
	lockReason: string | null;
}

/**
 * Where a switch stands. The client is stopped and resumed with the new settings: `stopping` logged
 * before the stop ran; `stop-failed`
 * the stop command failed; `stop-unknown` it ran out of time or the client could not be seen to be
 * gone; `stopped` gone, not resumed yet; `resuming` resumed, its session not seen yet;
 * `resume-failed` the resume failed or was found over without the session showing up; `done` the
 * session showed up again. `refused` nothing was done. `sent` and `failed` are only on switches
 * logged before Claude was switched this way, when `/model` and `/effort` were typed in.
 */
export type SwitchState =
	| 'sent'
	| 'failed'
	| 'refused'
	| 'stopping'
	| 'stop-failed'
	| 'stop-unknown'
	| 'stopped'
	| 'resuming'
	| 'resume-failed'
	| 'done';

/** One switch in the board's sent log. Later lines move a Codex switch on; see `SwitchView`. */
export interface SentSwitch {
	id: string;
	kind: 'switch';
	time: string;
	controllerId: string;
	hcomName: string;
	client: string;
	/** What the latest turn used before the switch; null when it could not be read. */
	from: CurrentSettings | null;
	to: ModelChoice;
	/** `restart` stopped and resumed; null refused. `inject` only on older Claude switches, typed in. */
	route: 'inject' | 'restart' | null;
	state: SwitchState;
	error: string | null;
	/** The Herdr pane the Codex client ran in before the stop: it must be gone before a resume. */
	pane: string | null;
}

export interface SwitchView extends SentSwitch {
	/** A Codex switch that is not over: 「繼續切換」 picks it up again. */
	open: boolean;
	/** When the settings last went out: typed in, or the latest resume that carried them. Only a
	 *  turn after this can show whether they took. Null while nothing went out. */
	appliedAt: string | null;
	/** The resume that carries this switch's settings, the latest one. */
	wakeId: string | null;
}

/** What `POST /api/model` takes. Both null on a switch that is open continues it as it is. */
export interface SwitchRequest extends ModelChoice {
	controllerId: string;
}

/** What `POST /api/model` answers. */
export interface SwitchResponse {
	ok: boolean;
	reason: string | null;
	entry: SwitchView | null;
	/** The open resume attempt the user may give up, when it is what stopped this switch. */
	abandon: string | null;
	logError: string | null;
}

export const NOT_RUNNING_REASON = '主控目前沒有在跑，請在喚醒時一起選';
export const BUSY_REASON = '主控正在工作或狀態不明，等這回合結束再改';
export const OWN_PANE_REASON =
	'hcom 記的主控窗格就是看板自己所在的 Herdr 窗格，停止會關掉看板的窗格，沒有切換；請到 Herdr 查看主控實際在哪個分頁';
export const FIXED_MODEL_REASON = '這個 Codex 主控啟動時指定了模型，接回後無法換模型，只能改思考強度';
export const LOCK_UNKNOWN_TEXT = '無法確認這個主控能否換模型';
export const NOT_OFFERED_REASON = '這個模型或思考強度不在這個 client 的選項裡，沒有送出';
export const SWITCH_UNSETTLED_REASON = '這個主控有一次模型切換還沒確認已停止，請先到資訊頁按「繼續切換」，沒有送出';
export const WAKE_RUNNING_CHOICE_REASON = '主控還在跑，模型與思考強度請改用資訊頁的「修改」，沒有送出';

export const SWITCH_STATE_TEXT: Record<SwitchState, string> = {
	sent: '已送出切換',
	failed: '切換沒有送出',
	refused: '沒有切換',
	stopping: '正在停止主控，結果不明',
	'stop-failed': '停止失敗，沒有接回',
	'stop-unknown': '停止結果不明，沒有接回',
	stopped: '已停止，尚未接回',
	resuming: '已停止並接回，等主控出現',
	'resume-failed': '接回失敗，主控目前沒有在跑',
	done: '已接回'
};

export const settingsText = (settings: Partial<ModelChoice> | null | undefined) =>
	`模型 ${settings?.model ?? '不明'}・思考強度 ${settings?.effort ?? '不明'}`;

/** A choice as a switch shows it: what it changes, and that the rest is kept. */
export const choiceText = (choice: ModelChoice) =>
	`模型 ${choice.model ?? '保持目前'}・思考強度 ${choice.effort ?? '保持目前'}`;

/** The latest settings sent to the controller: a switch typed in or resumed, or a wake that
 *  resumed with a choice. Entries come newest first. */
export function lastApplied(entries: readonly SentEntry[]): { time: string; to: ModelChoice } | null {
	for (const entry of entries) {
		if (entry.kind === 'switch' && (entry.state === 'sent' || entry.state === 'resuming' || entry.state === 'done')) {
			return { time: entry.appliedAt ?? entry.time, to: entry.to };
		}
		if (
			entry.kind === 'wake' &&
			!entry.switchId &&
			entry.route === 'resume' &&
			(entry.outcome === 'started' || entry.outcome === 'pending') &&
			chose(entry.choice)
		) {
			return { time: entry.time, to: entry.choice };
		}
	}
	return null;
}

/**
 * What the record says about the latest settings sent: `waiting` until a turn started after them;
 * then `took` when every chosen value is what that turn used, or `missed` with what it used.
 */
export function switchCheck(applied: { time: string; to: ModelChoice } | null, current: CurrentSettings | null): 'waiting' | 'took' | 'missed' | null {
	if (!applied) return null;
	if (!current?.time || Date.parse(current.time) <= Date.parse(applied.time)) return 'waiting';
	const { model, effort } = applied.to;
	return (model === null || model === current.model) && (effort === null || effort === current.effort) ? 'took' : 'missed';
}

export const SWITCH_WAITING_TEXT = '已送出切換，等下一回合確認';
export const SWITCH_MISSED_TEXT = '切換沒有生效';

/** The lists as `LAT_BOARD_MODEL_OPTIONS` gives them: a JSON object with `claude` and `codex`
 *  entries, each of which may give `models` and `efforts`; what it leaves out stays built in. */
export function parseModelOptions(text: string | undefined): ModelOptions {
	if (!text) return DEFAULT_MODEL_OPTIONS;
	const parsed: unknown = JSON.parse(text);
	const fail = () => {
		throw new Error('LAT_BOARD_MODEL_OPTIONS must be a JSON object like {"claude": {"models": [...], "efforts": [...]}}');
	};
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail();
	const given = parsed as Record<string, unknown>;
	const result = structuredClone(DEFAULT_MODEL_OPTIONS);
	for (const client of Object.keys(given)) {
		if (client !== 'claude' && client !== 'codex') fail();
		const lists = given[client] as Record<string, unknown>;
		if (typeof lists !== 'object' || lists === null || Array.isArray(lists)) fail();
		for (const key of Object.keys(lists)) {
			const list = lists[key];
			if ((key !== 'models' && key !== 'efforts') || !Array.isArray(list) || list.some((value) => typeof value !== 'string' || !value)) fail();
			result[client as LaunchClient][key as keyof ClientOptions] = list as string[];
		}
	}
	return result;
}
