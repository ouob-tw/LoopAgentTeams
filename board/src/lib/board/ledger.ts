// A controller's work ledger as its page shows it. The helper reads it with `lat-ledger show
// --json` (ADR 0003); the board never reads the ledger file itself. The page shows one line per
// ticket (the ticket layer lat-ledger builds) and, expanded, the rows that make it up.

/** A commit or report file a row names as evidence, with where the page opens it; null when it
 *  cannot be opened from the board (the server fills `href` in, see ledger-evidence.ts). */
export interface EvidenceLink {
	text: string;
	href: string | null;
}

export interface LedgerEvidence {
	commits: EvidenceLink[];
	files: EvidenceLink[];
	gates: string[];
}

/** One item (row) of the ledger. */
export interface LedgerRow {
	id: number;
	ticket: string;
	/** The stage and the status as lat-ledger names them, e.g. 實作 and 進行中. */
	stage: string;
	status: string;
	/** The status key, e.g. in_progress, for the row's look. */
	statusKey: string;
	/** The agent's full HCOM name; null while it is not given to anyone. */
	agent: string | null;
	/** What the agent ran on, as lat-ledger writes it ("model・effort", 未查證 when unread). */
	settings: string;
	estimate: string | null;
	/** Whole minutes past the estimate at the read, while it still applies, as lat-ledger counts
	 *  them. The deadline lat-ledger keeps only drives stall alarms and is not shown. */
	late: { estimate?: number };
	progress: string | null;
	blockedReason: string | null;
	cancelReason: string | null;
	/** When the row was started (or assigned, if never started), and when it closed. */
	startedAt: string | null;
	closedAt: string | null;
	/** The local project the row's commits are in; null for the ledger's workspace. */
	repo: string | null;
	evidence: LedgerEvidence;
	/** When the item last changed; null when its history is empty. */
	updatedAt: string | null;
}

export type StepState = 'done' | 'active' | 'pending' | 'skipped';

/** One ticket line: the rows of the ledger that name this ticket. */
export interface LedgerTicket {
	key: string;
	/** Short reference shown on the line, e.g. #548; the text item itself when not numbered. */
	ref: string;
	/** The tracker page, for a ticket of a GitHub repository. */
	href: string | null;
	title: string;
	state: string;
	stateLabel: string;
	steps: { key: string; label: string; state: StepState }[];
	/** What it is doing now, as lat-ledger writes it: stage, agent, progress, blocked reason,
	 *  minutes past the estimate; or the outcome. */
	now: string;
	/** What each stage ran on: "實作" with "opus-5.5・medium" and so on. */
	settings: { label: string; text: string }[];
	minutes: number | null;
	running: boolean;
	/** Rounds of rework once lat-ledger counts them (#550); 0 when none or not counted. */
	reworkRounds: number;
	rows: number[];
	/** Problems found per stage, as lat-ledger counts them: every stage with one, and 0 for a
	 *  stage whose step is done. `severe` when a 甲 or 乙 is among them. */
	findings: FindingCount[];
	/** The ids of this ticket's problems, in the order they were recorded. */
	problems: string[];
}

export type Level = '甲' | '乙' | '丙';
export const LEVELS: Level[] = ['甲', '乙', '丙'];

export interface FindingCount {
	stage: string;
	label: string;
	count: number;
	levels: Record<Level, number>;
	/** How many a test caught. */
	caught: number;
	severe: boolean;
}

/** One problem of the project's problem log, in its current state. */
export interface LedgerProblem {
	id: string;
	ticket: string;
	stage: string;
	finder: string;
	level: Level;
	text: string;
	caught: boolean;
	/** What became of it, as lat-ledger writes it (已修 <commit>, 列為已知限制…); empty while open. */
	resolution: string;
}

export type LedgerView =
	| { state: 'none' }
	| { state: 'error'; reason: string }
	| {
			state: 'ok';
			updatedAt: string | null;
			/** When lat-ledger read it; the ticket times are counted to then, and so are the rows'. */
			readAt: string | null;
			/** The ledger's workspace, where its rows' commits and report files are. */
			workspace: string | null;
			items: LedgerRow[];
			tickets: LedgerTicket[];
			/** Ticket counts per state, in lat-ledger's order, only states with tickets. */
			counts: { state: string; label: string; count: number }[];
			/** This ledger's problems (its tickets', and those of unknown cause recorded here). */
			problems: LedgerProblem[];
			/** "Which stage found how many problems": one entry per stage, each problem once. */
			summary: FindingCount[];
			/** The project's problem log, watched with the ledger; null from a lat-ledger before it. */
			problemsPath: string | null;
	  };

/** lat-ledger's ticket states in the order it lists them. */
const STATE_ORDER = ['in_progress', 'blocked', 'assigned', 'unassigned', 'deployed', 'merged', 'done', 'cancelled'];
const STEP_STATES = new Set<string>(['done', 'active', 'pending', 'skipped']);

const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
const minutes = (value: unknown) => (typeof value === 'number' && value > 0 ? value : undefined);
const strings = (value: unknown) => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry !== '') : []);
const record = (value: unknown) => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
const count = (value: unknown) => (typeof value === 'number' && value > 0 ? value : 0);
const isLevel = (value: unknown): value is Level => LEVELS.includes(value as Level);

/** Per-stage counts as lat-ledger gives them; entries not in that shape are left out. A
 *  lat-ledger before the problem log gives none. */
function findingCounts(value: unknown): FindingCount[] {
	return (Array.isArray(value) ? value : []).map(record).flatMap((entry) => {
		const stage = text(entry.stage);
		const label = text(entry.label);
		if (!stage || !label) return [];
		const levels = record(entry.levels);
		return [{ stage, label, count: count(entry.count), levels: { 甲: count(levels.甲), 乙: count(levels.乙), 丙: count(levels.丙) }, caught: count(entry.caught), severe: entry.severe === true }];
	});
}

function problemFrom(value: unknown): LedgerProblem[] {
	const problem = record(value);
	const id = text(problem.id);
	const ticket = text(problem.ticket);
	if (!id || !ticket || !isLevel(problem.level)) return [];
	return [
		{
			id,
			ticket,
			stage: text(problem.stage_label) ?? text(problem.stage) ?? '',
			finder: text(problem.finder) ?? '',
			level: problem.level,
			text: text(problem.text) ?? '',
			caught: problem.caught === true,
			resolution: text(problem.resolution_text) ?? ''
		}
	];
}

function rowFrom(value: unknown): LedgerRow | null {
	if (typeof value !== 'object' || value === null) return null;
	const item = value as Record<string, unknown>;
	if (typeof item.id !== 'number' || typeof item.ticket !== 'string') return null;
	const pastEstimate = minutes(record(item.late_minutes).estimate);
	const history = (Array.isArray(item.history) ? item.history : []).map(record);
	const status = text(item.status) ?? '';
	// As lat-ledger finds it: the latest done (or cancel) entry of a closed row.
	const closing = status === 'done' ? 'done' : status === 'cancelled' ? 'cancel' : null;
	const closedAt = closing ? text(history.findLast((entry) => entry.action === closing)?.at) : null;
	const evidence = record(item.evidence);
	return {
		id: item.id,
		ticket: item.ticket,
		stage: text(item.stage_label) ?? text(item.stage) ?? '',
		status: text(item.status_label) ?? status,
		statusKey: status,
		agent: text(item.agent),
		settings: text(item.settings_text) ?? '',
		estimate: text(item.estimate),
		late: pastEstimate === undefined ? {} : { estimate: pastEstimate },
		progress: text(item.progress),
		blockedReason: text(item.blocked_reason),
		cancelReason: text(item.cancel_reason),
		startedAt: text(item.started_at) ?? text(item.assigned_at),
		closedAt,
		repo: text(item.repo),
		evidence: {
			commits: strings(evidence.commit).map((sha) => ({ text: sha, href: null })),
			files: strings(evidence.file).map((path) => ({ text: path, href: null })),
			gates: strings(evidence.gate)
		},
		updatedAt: text(history.at(-1)?.at)
	};
}

/** The tracker page of `owner/repo#N`. */
export function ticketHref(key: string): string | null {
	const match = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(key);
	return match ? `https://github.com/${match[1]}/${match[2]}/issues/${match[3]}` : null;
}

function ticketFrom(value: unknown, shortRefs: boolean): LedgerTicket | null {
	const ticket = record(value);
	const key = text(ticket.key);
	if (!key || !Array.isArray(ticket.steps) || !Array.isArray(ticket.items)) return null;
	const steps = ticket.steps.map(record).map((step) => ({ key: text(step.key) ?? '', label: text(step.label) ?? '', state: step.state as StepState }));
	if (steps.some((step) => !STEP_STATES.has(step.state))) return null;
	const number = typeof ticket.number === 'number' ? ticket.number : null;
	const repo = text(ticket.repo);
	return {
		key,
		ref: number === null ? key : shortRefs || !repo ? `#${number}` : `${repo.split('/').at(-1)}#${number}`,
		href: ticketHref(key),
		title: number === null ? '' : (text(ticket.title) ?? ''),
		state: text(ticket.state) ?? '',
		stateLabel: text(ticket.state_label) ?? text(ticket.state) ?? '',
		steps,
		now: text(ticket.now) ?? '',
		settings: (Array.isArray(ticket.settings) ? ticket.settings : []).map(record).flatMap((stage) => {
			const label = text(stage.label);
			const settings = text(stage.text);
			return label && settings ? [{ label, text: settings }] : [];
		}),
		minutes: typeof ticket.total_minutes === 'number' ? ticket.total_minutes : null,
		running: ticket.running === true,
		reworkRounds: minutes(ticket.rework_rounds) ?? 0,
		rows: ticket.items.filter((id): id is number => typeof id === 'number'),
		findings: findingCounts(record(ticket.findings).stages),
		problems: strings(record(ticket.findings).problems)
	};
}

/** One entry of `board ledger`'s output as the page shows it; anything not in that shape is an
 *  error saying so. */
export function ledgerFrom(entry: { status?: unknown; reason?: unknown; ledger?: unknown }): LedgerView {
	if (entry.status === 'none') return { state: 'none' };
	if (entry.status !== 'ok') return { state: 'error', reason: text(entry.reason) ?? '輔助工具的輸出不是預期的格式' };
	const ledger = record(entry.ledger);
	const items = Array.isArray(ledger.items) ? ledger.items.map(rowFrom) : null;
	if (!items || items.includes(null)) return { state: 'error', reason: '總表的輸出不是預期的格式' };
	// A lat-ledger from before the ticket layer: say so rather than show nothing.
	if (!Array.isArray(ledger.tickets)) return { state: 'error', reason: '總表工具沒有輸出票，請更新 LAT' };
	// Numbers alone when every numbered ticket is in one repository; the repository's name too
	// when two could share a number.
	const repos = new Set(ledger.tickets.map((ticket) => typeof record(ticket).number === 'number' && text(record(ticket).repo)).filter(Boolean));
	const tickets = ledger.tickets.map((ticket) => ticketFrom(ticket, repos.size <= 1));
	if (tickets.includes(null)) return { state: 'error', reason: '總表的輸出不是預期的格式' };
	const counted = record(ledger.ticket_counts);
	const labels = new Map((tickets as LedgerTicket[]).map((ticket) => [ticket.state, ticket.stateLabel]));
	const states = [...STATE_ORDER, ...Object.keys(counted).filter((state) => !STATE_ORDER.includes(state))];
	return {
		state: 'ok',
		updatedAt: text(ledger.updated_at),
		readAt: text(ledger.now),
		workspace: text(ledger.workspace),
		items: items as LedgerRow[],
		tickets: tickets as LedgerTicket[],
		counts: states.flatMap((state) => {
			const count = counted[state];
			return typeof count === 'number' && count > 0 ? [{ state, label: labels.get(state) ?? state, count }] : [];
		}),
		problems: (Array.isArray(ledger.problems) ? ledger.problems : []).flatMap(problemFrom),
		summary: findingCounts(ledger.finding_summary),
		problemsPath: text(ledger.problems_path)
	};
}

/** How far past its estimate an item is, as `lat-ledger show` writes it in the status:
 *  `超過預計 125 分`; empty when it is not past. */
export function lateText(late: LedgerRow['late']): string {
	return late.estimate === undefined ? '' : `超過預計 ${late.estimate} 分`;
}

/** Minutes as lat-ledger writes them: `48 分`, `2 小時 5 分`. */
export function minutesText(total: number): string {
	const hours = Math.floor(total / 60);
	return hours ? `${hours} 小時 ${total % 60} 分` : `${total % 60} 分`;
}

/** A ticket's time: total once finished, so far while running, with rounds of rework past 0. */
export function ticketTime(ticket: Pick<LedgerTicket, 'minutes' | 'running' | 'reworkRounds'>): string {
	const parts = [];
	if (ticket.minutes !== null) parts.push((ticket.running ? '已 ' : '') + minutesText(ticket.minutes));
	if (ticket.reworkRounds > 0) parts.push(`修 ${ticket.reworkRounds} 輪`);
	return parts.join('・');
}

/** Whole minutes a row took, or has taken so far while open; null before it starts. */
export function rowMinutes(row: Pick<LedgerRow, 'startedAt' | 'closedAt' | 'statusKey'>, now: number): number | null {
	if (!row.startedAt) return null;
	const end = row.closedAt ? Date.parse(row.closedAt) : ['done', 'cancelled'].includes(row.statusKey) ? null : now;
	if (end === null) return null;
	return Math.max(0, Math.floor((end - Date.parse(row.startedAt)) / 60_000));
}

/** The "N 張票：…" summary line lat-ledger prints, from the counts. */
export function countsText(view: { tickets: unknown[]; counts: { label: string; count: number }[] }): string {
	return `${view.tickets.length} 張票：${view.counts.map((entry) => `${entry.count} 張${entry.label}`).join('、')}`;
}

/** A stage's count as the ticket line writes it: `審查 2（乙 1）`, naming 甲 and 乙 only. */
export function findingText(entry: FindingCount): string {
	const severe = (['甲', '乙'] as const).filter((level) => entry.levels[level]).map((level) => `${level} ${entry.levels[level]}`);
	return `${entry.label} ${entry.count}` + (severe.length ? `（${severe.join('、')}）` : '');
}
