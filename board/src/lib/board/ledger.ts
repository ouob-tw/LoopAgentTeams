// A controller's work ledger as its page shows it. The helper reads it with `lat-ledger show
// --json` (ADR 0003); the board never reads the ledger file itself.

/** One item of the ledger. */
export interface LedgerRow {
	id: number;
	ticket: string;
	/** The stage and the status as lat-ledger names them, e.g. 實作 and 進行中. */
	stage: string;
	status: string;
	/** The agent's full HCOM name; null while it is not given to anyone. */
	agent: string | null;
	estimate: string | null;
	/** Whole minutes past the estimate at the read, while it still applies, as lat-ledger counts
	 *  them. The deadline lat-ledger keeps only drives stall alarms and is not shown. */
	late: { estimate?: number };
	/** When the item last changed; null when its history is empty. */
	updatedAt: string | null;
}

export type LedgerView =
	| { state: 'none' }
	| { state: 'error'; reason: string }
	| { state: 'ok'; updatedAt: string | null; items: LedgerRow[] };

const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
const minutes = (value: unknown) => (typeof value === 'number' && value > 0 ? value : undefined);

function rowFrom(value: unknown): LedgerRow | null {
	if (typeof value !== 'object' || value === null) return null;
	const item = value as Record<string, unknown>;
	if (typeof item.id !== 'number' || typeof item.ticket !== 'string') return null;
	const late = (typeof item.late_minutes === 'object' && item.late_minutes) || {};
	const pastEstimate = minutes((late as Record<string, unknown>).estimate);
	const history = Array.isArray(item.history) ? item.history : [];
	const latest = history.at(-1) as { at?: unknown } | undefined;
	return {
		id: item.id,
		ticket: item.ticket,
		stage: text(item.stage_label) ?? text(item.stage) ?? '',
		status: text(item.status_label) ?? text(item.status) ?? '',
		agent: text(item.agent),
		estimate: text(item.estimate),
		late: pastEstimate === undefined ? {} : { estimate: pastEstimate },
		updatedAt: text(latest?.at)
	};
}

/** One entry of `board ledger`'s output as the page shows it; anything not in that shape is an
 *  error saying so. */
export function ledgerFrom(entry: { status?: unknown; reason?: unknown; ledger?: unknown }): LedgerView {
	if (entry.status === 'none') return { state: 'none' };
	if (entry.status !== 'ok') return { state: 'error', reason: text(entry.reason) ?? '輔助工具的輸出不是預期的格式' };
	const ledger = entry.ledger as { items?: unknown; updated_at?: unknown } | null;
	const items = Array.isArray(ledger?.items) ? ledger.items.map(rowFrom) : null;
	if (!items || items.includes(null)) return { state: 'error', reason: '總表的輸出不是預期的格式' };
	return { state: 'ok', updatedAt: text(ledger?.updated_at), items: items as LedgerRow[] };
}

/** How far past its estimate an item is, as `lat-ledger show` writes it in the status:
 *  `超過預計 125 分`; empty when it is not past. */
export function lateText(late: LedgerRow['late']): string {
	return late.estimate === undefined ? '' : `超過預計 ${late.estimate} 分`;
}
