// The pd 待核准 section's data: the requests pd's daemon holds for the user's approval, as the
// server last read them from `pd pending --json`, and how the section words them. Only these fields
// ever reach a page; pd itself never lists a secret value. 核准 signs pd's challenge with the user's
// passkey in the page; the board server only relays it, and pd's daemon decides.

/** Who asked as pd's daemon checked it against the process tree (`caller_info`). The name, group and
 *  controller flag are what the requester says; `verified` covers the process only, and is not proof
 *  against a program of the same account that means to fake it. */
export interface PdCaller {
	name: string;
	client: string;
	group: string | null;
	/** True for an HCOM agent without a tag, false with one, null when unknown. */
	orchestrator: boolean | null;
	source: string;
	verified: boolean;
	notice: string;
}

/** What a request asks pd to do: read an item's secret to run a command, add, edit or delete an item. */
export type PdAction = 'read' | 'add' | 'edit' | 'delete' | 'attach' | 'detach';
/** An attachment a request names: an upload (`attach`, or an `add` that brings a file) or a removal
 *  (`detach`). `size` is null for a command's output, which has no size until it has run. `source`
 *  is where an upload's bytes come from (null for a removal); `replaces` is the same-named
 *  attachment an upload would overwrite, null when it adds a new one. */
export interface PdAttachment {
	name: string;
	size: number | null;
	source: { kind: 'file'; path: string } | { kind: 'output'; command: string[]; cwd: string } | null;
	replaces: { size: number | null } | null;
}
/** Where a secret to be written comes from; pd never lists the value itself. */
export type PdSecret =
	| { field: string; source: 'generate'; length: number }
	| { field: string; source: 'output'; command: string[]; cwd: string };

export interface PdRequest {
	id: number;
	/** A PdAction, or the word a newer pd gave ('' when it gave no word); a pd that does not say reads as `read`. */
	action: string;
	/** The item type pd printed for a write (login, note, card, identity, sshKey, unknown, or a newer one); null for a read. */
	type: string | null;
	/** The non-secret values an add or edit writes, in pd's order. */
	values: { field: string; value: string }[];
	/** The secret fields an add or edit writes, and where each comes from. */
	writes: PdSecret[];
	/** Who asked, as the requester declared it: not verified. */
	caller: string;
	/** The daemon's check of the caller; null from a pd that does not give one. */
	callerInfo: PdCaller | null;
	item: string;
	fields: string[];
	/** The attachments a read asks to have as files, name and size; empty when it asks for none. */
	files: { name: string; size: number | null }[];
	/** The attachment an `attach`, `detach` or attaching `add` is about; null otherwise. */
	attachment: PdAttachment | null;
	/** The command the request would run, word by word, with any value pd recognised masked. */
	command: string[];
	cwd: string;
	/** Seconds the request had waited when it was read. */
	waiting: number;
	/** Seconds it had left before timing out when it was read; null from a pd that does not say. */
	remaining: number | null;
	/** The request's page on the passkey site; null when pd gave none that is a web address. The
	 *  board approves in its own panel and no longer links to it. */
	approvalUrl: string | null;
	/** Which start of pd's daemon holds it: numbers begin at 1 again with each start. Null from a
	 *  pd that does not say. */
	daemon: string | null;
}

/** WebAuthn request options from `pd passkey challenge <id>`, binary values in base64url. */
export interface PdChallenge {
	challenge: string;
	rpId: string;
	userVerification: 'required';
	timeout: number;
	allowCredentials: { type: 'public-key'; id: string }[];
}

/** A WebAuthn assertion as `pd passkey approve <id>` reads it, binary values in base64url. */
export interface PdAssertion {
	id: string;
	rawId: string;
	type: 'public-key';
	response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle: string | null };
}

const fromBase64url = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4)), (c) => c.charCodeAt(0));
const toBase64url = (value: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

/** The options as `navigator.credentials.get` takes them. */
export function requestOptions(options: PdChallenge): PublicKeyCredentialRequestOptions {
	return {
		challenge: fromBase64url(options.challenge),
		rpId: options.rpId,
		userVerification: options.userVerification,
		timeout: options.timeout,
		allowCredentials: options.allowCredentials.map((credential) => ({ type: credential.type, id: fromBase64url(credential.id) }))
	};
}

/** What `navigator.credentials.get` gave, as the board server takes it. */
export function assertionJson(credential: PublicKeyCredential): PdAssertion {
	const response = credential.response as AuthenticatorAssertionResponse;
	return {
		id: credential.id,
		rawId: toBase64url(credential.rawId),
		type: 'public-key',
		response: {
			clientDataJSON: toBase64url(response.clientDataJSON),
			authenticatorData: toBase64url(response.authenticatorData),
			signature: toBase64url(response.signature),
			userHandle: response.userHandle ? toBase64url(response.userHandle) : null
		}
	};
}

export type PdSnapshot = { ok: true; requests: PdRequest[]; vault?: 'locked' | 'unavailable' } | { ok: false; reason: string };

/** Current availability only; historical failure text does not keep a warning visible. */
export function pdNotice(snapshot: PdSnapshot): string | null {
	if (!snapshot.ok || snapshot.vault === 'unavailable') return 'pd 服務不可用';
	return snapshot.vault === 'locked' ? 'pd 已鎖定' : null;
}

export const ACTION_LABEL: Record<PdAction, string> = { read: '讀取', add: '新增', edit: '修改', delete: '刪除', attach: '上傳附件', detach: '刪除附件' };
/** An action from a newer pd shows as given, never as a read. */
export const actionLabel = (action: string): string => (Object.hasOwn(ACTION_LABEL, action) ? ACTION_LABEL[action as PdAction] : action || '未知動作');
/** What the request's chip says: an upload over an attachment of the same name is 取代附件, not 上傳附件. */
export const requestLabel = (request: PdRequest): string => (request.action === 'attach' && request.attachment?.replaces ? '取代附件' : actionLabel(request.action));
/** Whether the request destroys something that cannot come back: removing an attachment, or replacing one. */
export const destroysAttachment = (request: PdRequest): boolean => request.action === 'detach' || (request.action === 'attach' && !!request.attachment?.replaces);

/** A size as a person reads it: bytes below 1 KB, then KB, then MB. Null is a size pd did not give. */
export function sizeText(size: number | null): string {
	if (size === null) return '大小不明';
	const trim = (value: number) => String(Math.round(value * 10) / 10);
	if (size < 1024) return `${size} 位元組`;
	return size < 1024 * 1024 ? `${trim(size / 1024)} KB` : `${trim(size / 1024 / 1024)} MB`;
}

/** The sentence under a destructive attachment card; null for any other request. */
export function attachmentWarning(request: PdRequest): string | null {
	if (request.action === 'detach') return '永久刪除，無法復原';
	const replaces = request.action === 'attach' ? request.attachment?.replaces : null;
	return replaces ? `會取代既有附件${replaces.size === null ? '' : `（大小 ${sizeText(replaces.size)}）`}，舊檔永久消失` : null;
}

/** The rows an attachment adds to a card's details: name, size and where an upload comes from. */
export function attachmentRows(attachment: PdAttachment): { label: string; value: string; code?: boolean }[] {
	const rows: { label: string; value: string; code?: boolean }[] = [{ label: '附件', value: attachment.name }, { label: '大小', value: attachment.size === null && attachment.source?.kind === 'output' ? '執行後才知道大小，上限 1 MB' : sizeText(attachment.size) }];
	if (attachment.source?.kind === 'file') rows.push({ label: '檔案', value: attachment.source.path, code: true });
	if (attachment.source?.kind === 'output') rows.push({ label: '指令', value: attachment.source.command.join(' '), code: true }, { label: '工作目錄', value: attachment.source.cwd, code: true });
	return rows;
}
export const TYPE_LABEL: Record<string, string> = { login: '登入資料', note: '備註', card: '卡片', identity: '身分', sshKey: 'SSH 金鑰', unknown: '未知類型' };
/** A type from a newer pd shows as given rather than disappearing. */
export const typeLabel = (type: string): string => (Object.hasOwn(TYPE_LABEL, type) ? TYPE_LABEL[type] : type);

/** The line under the caller: a read's shortened command, a write's field names (none for a delete). */
export function summaryText(request: PdRequest): string {
	if (request.action === 'read') return shortCommand(request.command);
	const attached = request.attachment ? [`附件 ${request.attachment.name}`] : [];
	return [...request.fields, ...attached].join('、');
}

/** Where a secret comes from, without its value. */
export function secretText(secret: PdSecret): string {
	return secret.source === 'generate' ? `自動產生，${secret.length} 字元` : `指令輸出：${secret.command.join(' ')}（${secret.cwd}）`;
}

/** The browser notification for a new request, naming the action. */
export function notificationText(request: PdRequest): { title: string; body: string } {
	const title = `pd 請求 #${request.id}（${requestLabel(request)}）等你核准`;
	if (request.attachment && !request.fields.length) return { title, body: `${request.item}：${request.attachment.name}` };
	if (request.action !== 'read' && !request.fields.length) return { title, body: request.type ? `${request.item}（${typeLabel(request.type)}）` : request.item };
	return { title, body: `${request.item}：${request.action === 'read' ? request.command.join(' ') : summaryText(request)}` };
}

const clockText = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/** A request's time as it reads `elapsed` milliseconds after it was read: what is left while pd says,
 *  else how long it has waited. `soon` once two minutes or less are left, `low` once 30 seconds. */
export function timeText(request: PdRequest, elapsed: number): { text: string; soon: boolean; low: boolean } {
	const passed = Math.max(0, Math.floor(elapsed / 1000));
	if (request.remaining === null) return { text: `已等待 ${clockText(request.waiting + passed)}`, soon: false, low: false };
	const left = Math.max(0, request.remaining - passed);
	return { text: left ? `剩 ${clockText(left)}` : '即將逾時', soon: left <= 120, low: left <= 30 };
}

/** A command short enough for one line: its first three words, each with a slash (a path, or a
 *  flag with one) cut to what follows the last, and `…` when more follows. The card shows the
 *  whole command on a tap. */
export function shortCommand(command: string[]): string {
	const words = command.slice(0, 3).map((word) => (word.includes('/') && !word.includes('://') ? word.replace(/\/+$/, '').split('/').pop() || word : word));
	return words.join(' ') + (command.length > 3 ? ' …' : '');
}

/** Who asked, and the mark of how far to trust it, apart so a short line can cut the name and
 *  never the mark: `dahe（claude，主控）` `✓`, `dahe-t09-vafu（codex，群組 dahe-t09）` `未通過查證`,
 *  or `codex` `（自稱）`, the declared name, from a pd without the daemon's check. */
export function callerParts(request: PdRequest): { who: string; mark: string } {
	const info = request.callerInfo;
	if (!info) return { who: request.caller, mark: '（自稱）' };
	const role = info.orchestrator ? '主控' : info.group ? `群組 ${info.group}` : null;
	const notes = [info.client, role, info.source === 'manual' ? '手動' : null].filter((note) => note !== null);
	return { who: `${info.name}（${notes.join('，')}）`, mark: info.verified ? '✓' : '未通過查證' };
}

/** What the caller's mark is worth, for its explanation: pd's own words for its check, or that the
 *  name is the caller's own claim. */
export function callerNote(request: PdRequest): string {
	return request.callerInfo ? request.callerInfo.notice : '對方自稱，未驗證';
}

export function callerText(request: PdRequest): string {
	const { who, mark } = callerParts(request);
	return who + mark;
}

/** Where the pd window lies and how big it is in the wide layout, in px from the window's top left. */
export type PdBox = { x: number; y: number; w: number; h: number };
/** The window's place once the user moved or resized it, saved in this browser. */
export const PD_WINDOW_KEY = 'lat-board-pd-window';
/** Narrow enough for a small screen, wide enough that a request's lines do not wrap. */
export const PD_MIN_WIDTH = 360;
export const PD_MIN_HEIGHT = 200;

/** The box inside a view of `view` px, at least the window's smallest size where the view allows,
 *  so it never ends up off screen. */
export function clampBox(box: PdBox, view: { w: number; h: number }): PdBox {
	const w = Math.round(Math.min(Math.max(box.w, PD_MIN_WIDTH), view.w));
	const h = Math.round(Math.min(Math.max(box.h, PD_MIN_HEIGHT), view.h));
	return { w, h, x: Math.round(Math.min(Math.max(box.x, 0), view.w - w)), y: Math.round(Math.min(Math.max(box.y, 0), view.h - h)) };
}

/** A saved box, or null for anything else. */
export function readBox(text: string): PdBox | null {
	try {
		const box = JSON.parse(text) as Partial<PdBox>;
		return [box.x, box.y, box.w, box.h].every((value) => typeof value === 'number' && Number.isFinite(value)) ? (box as PdBox) : null;
	} catch {
		return null;
	}
}
