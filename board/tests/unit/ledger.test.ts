// A controller's work ledger as the page shows it, from one entry of the helper's `board ledger`,
// and how late an item is written.
import { expect, test } from 'bun:test';
import { duration, lateText, ledgerFrom } from '../../src/lib/board/ledger.ts';

/** One item as `lat-ledger show --json` prints it. */
const item = (overrides: Record<string, unknown> = {}) => ({
	id: 1,
	ticket: '#302',
	stage: 'impl',
	stage_label: '實作',
	status: 'in_progress',
	status_label: '進行中',
	agent: 'tevu-impl302-zaga',
	estimate: '2026-10-24T12:00:00Z',
	deadline: '2026-10-24T13:00:00Z',
	late_minutes: { estimate: 125, deadline: 65 },
	history: [{ at: '2026-10-24T10:00:00Z' }, { at: '2026-10-24T11:00:00Z' }],
	...overrides
});

test('a read ledger keeps each row the page shows, with its latest change and lateness', () => {
	const view = ledgerFrom({ status: 'ok', ledger: { updated_at: '2026-10-24T11:00:00Z', now: '2026-10-24T14:05:00Z', items: [item()] } });

	expect(view).toEqual({
		state: 'ok',
		updatedAt: '2026-10-24T11:00:00Z',
		items: [
			{
				id: 1,
				ticket: '#302',
				stage: '實作',
				status: '進行中',
				agent: 'tevu-impl302-zaga',
				estimate: '2026-10-24T12:00:00Z',
				deadline: '2026-10-24T13:00:00Z',
				late: { estimate: 125, deadline: 65 },
				updatedAt: '2026-10-24T11:00:00Z'
			}
		]
	});
});

test('an item not late, unassigned or with no history has nothing made up', () => {
	const view = ledgerFrom({ status: 'ok', ledger: { items: [item({ agent: null, estimate: null, late_minutes: {}, history: [] })] } });

	expect(view).toMatchObject({ state: 'ok', updatedAt: null, items: [{ agent: null, estimate: null, late: {}, updatedAt: null }] });
});

test('no ledger, a failed read and output not in shape each say so', () => {
	expect(ledgerFrom({ status: 'none' })).toEqual({ state: 'none' });
	expect(ledgerFrom({ status: 'error', reason: 'seal mismatch' })).toEqual({ state: 'error', reason: 'seal mismatch' });
	expect(ledgerFrom({ status: 'error' })).toEqual({ state: 'error', reason: '輔助工具的輸出不是預期的格式' });
	expect(ledgerFrom({ status: 'ok', ledger: { items: [{ id: 'one' }] } })).toEqual({ state: 'error', reason: '總表的輸出不是預期的格式' });
	expect(ledgerFrom({ status: 'ok' })).toEqual({ state: 'error', reason: '總表的輸出不是預期的格式' });
});

test('lateness reads as lat-ledger prints it, the deadline first', () => {
	expect(duration(45)).toBe('45m');
	expect(duration(65)).toBe('1h05m');
	expect(lateText({ estimate: 10, deadline: 125 })).toBe('超過期限 2h05m；超過預計 10m');
	expect(lateText({ estimate: 10 })).toBe('超過預計 10m');
	expect(lateText({})).toBe('');
});
