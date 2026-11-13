// Unattended mode from the board: the settings page's reads and writes, and turning a controller's
// grant on, changing it or turning it off. Everything goes through lat-unattended by way of the
// helper. A form the user sends is first written to the sent log as the device's request, which the
// tool checks the grant against; the outcome is then logged as an action on the controller, so it
// shows in its 操作紀錄.
import { randomUUID } from 'node:crypto';
import type { AgentAction, AgentActionResponse } from '../board/agent-actions.ts';
import { everyController, type Controller } from '../board/types.ts';
import { SCOPE_KEYS, SCOPE_WORD, type UnattendedScope, type UnattendedSettings } from '../board/unattended.ts';
import type { Board } from './board.ts';
import { changeUnattendedGrant, readUnattendedSettings, writeUnattendedSettings } from './helper.ts';
import { appendSent, type UnattendedRequest } from './sent-log.ts';

/** The workspaces of every controller the board lists: the projects the settings page offers. */
async function listedWorkspaces(board: Board): Promise<string[]> {
	return [...new Set(everyController(await board.current()).map((controller) => controller.workspace))];
}

export async function unattendedSettings(board: Board): Promise<{ ok: true; settings: UnattendedSettings } | { ok: false; reason: string }> {
	return readUnattendedSettings(board.config, await listedWorkspaces(board));
}

const LAYER_KEYS = ['mode', ...SCOPE_KEYS, 'max_hours'];

export type SettingsWriteResult = { status: number; body: unknown };

/** Write the changes to one layer: the global file, or a listed project's. Every open page is told. */
export async function writeSettings(board: Board, body: { layer?: unknown; project?: unknown; sha256?: unknown; changes?: unknown } | null): Promise<SettingsWriteResult> {
	const { layer, project, sha256, changes } = body ?? {};
	if (
		(layer !== 'global' && layer !== 'project') ||
		typeof sha256 !== 'string' ||
		typeof changes !== 'object' ||
		changes === null ||
		!Object.keys(changes).length ||
		Object.keys(changes).some((key) => !LAYER_KEYS.includes(key))
	) {
		return { status: 400, body: { reason: '無人模式設定的改動格式不對' } };
	}
	let root: string | null = null;
	if (layer === 'project') {
		const read = await unattendedSettings(board);
		if (!read.ok) return { status: 500, body: { reason: `讀不到無人模式設定：${read.reason}` } };
		root = read.settings.projects.find((candidate) => candidate.root === project)?.root ?? null;
		if (!root) return { status: 404, body: { reason: '看板上沒有這個專案的主控' } };
	}
	const written = await writeUnattendedSettings(board.config, { layer, project: root, sha256, changes: changes as Record<string, unknown> });
	if (!written.ok) {
		const status = written.status === 'conflict' ? 409 : written.status === 'invalid' || written.status === 'refused' ? 422 : 500;
		return { status, body: { reason: written.reason, problems: written.problems } };
	}
	board.unattendedChanged();
	const after = await unattendedSettings(board);
	if (!after.ok) return { status: 500, body: { reason: `已寫入，但讀不回設定：${after.reason}` } };
	return { status: 200, body: after.settings };
}

interface GrantBody {
	controllerId?: unknown;
	op?: unknown;
	goal?: unknown;
	done?: unknown;
	scope?: unknown;
	maxHours?: unknown;
}

type Checked = { op: 'close' } | { op: 'create' | 'update'; goal: string; done: string[]; scope: UnattendedScope; maxHours: number };

/** The form as the tool will store it, or why it cannot be sent. */
function checkForm(body: GrantBody): Checked | string {
	if (body.op === 'close') return { op: 'close' };
	if (body.op !== 'create' && body.op !== 'update') return '不知道要開啟、修改還是關掉';
	const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
	const done = Array.isArray(body.done) ? body.done.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : [];
	const scope = body.scope as Record<string, unknown> | null;
	if (!goal || !done.length) return '目標和怎麼算做完都要寫';
	if (typeof scope !== 'object' || scope === null || SCOPE_KEYS.some((key) => typeof scope[key] !== 'boolean')) return '代決範圍的格式不對';
	if (typeof body.maxHours !== 'number' || !Number.isInteger(body.maxHours) || body.maxHours < 1) return '時間上限要是 1 以上的整數小時';
	return { op: body.op, goal, done, scope: Object.fromEntries(SCOPE_KEYS.map((key) => [key, scope[key] as boolean])) as UnattendedScope, maxHours: body.maxHours };
}

function toolArgs(form: Checked, requestId: string): string[] {
	if (form.op === 'close') return ['close', '--reason=off'];
	const words = SCOPE_KEYS.filter((key) => form.scope[key]).map((key) => SCOPE_WORD[key]);
	return [
		form.op,
		`--goal=${form.goal}`,
		...form.done.map((item) => `--done=${item}`),
		'--scope',
		...(words.length ? words : ['none']),
		`--max-hours=${form.maxHours}`,
		`--source=${form.op === 'create' ? 'board-form' : 'user-edit'}`,
		`--evidence=board-action:${requestId}`
	];
}

const ACTION_TEXT = { create: '開啟', update: '修改', close: '關掉' } as const;

/** What the 操作紀錄 shows of it: what was done, and the goal and conditions sent. */
function actionText(form: Checked): string {
	if (form.op === 'close') return '關掉無人模式';
	return [`${ACTION_TEXT[form.op]}無人模式`, `目標：${form.goal}`, ...form.done.map((item) => `・${item}`), `時間上限 ${form.maxHours} 小時`].join('\n');
}

/** Turn a controller's grant on, change it, or turn it off. */
export async function changeGrant(board: Board, body: GrantBody | null): Promise<{ status: number; body: AgentActionResponse | { reason: string } }> {
	const controller: Controller | undefined = everyController(await board.current()).find((candidate) => candidate.id === body?.controllerId);
	if (!controller) return { status: 404, body: { reason: '找不到這個主控' } };
	const form = checkForm(body ?? {});
	if (typeof form === 'string') return { status: 422, body: { reason: form } };
	const { stateDir } = board.config;
	let request: UnattendedRequest | null = null;
	let logError: string | null = null;
	if (form.op !== 'close') {
		request = { kind: 'unattended-request', id: randomUUID(), time: new Date().toISOString(), controllerId: controller.id, op: form.op, goal: form.goal, done: form.done, scope: form.scope, maxHours: form.maxHours };
		try {
			appendSent(stateDir, request);
		} catch (error) {
			// Without the request in the log the tool has nothing to check the grant against.
			return { status: 500, body: { reason: `操作紀錄寫不進去，沒有送出：${(error as Error).message}` } };
		}
	}
	const done = await changeUnattendedGrant(board.config, { workspace: controller.workspace, sessionId: controller.id }, toolArgs(form, request?.id ?? ''));
	const reason = done.ok ? null : done.reason;
	const entry: AgentAction = {
		id: randomUUID(),
		kind: 'agent-action',
		action: 'unattended',
		time: new Date().toISOString(),
		agentId: controller.id,
		name: controller.hcomName,
		route: null,
		pane: null,
		text: actionText(form),
		ok: done.ok,
		error: reason,
		...(request && { request: request.id })
	};
	try {
		appendSent(stateDir, entry);
	} catch (error) {
		logError = (error as Error).message;
	}
	board.agentActed(controller.id);
	board.unattendedChanged();
	const status = done.ok ? 200 : done.status === 'refused' ? 409 : 502;
	return { status, body: { ok: done.ok, reason, entry, logError } };
}
