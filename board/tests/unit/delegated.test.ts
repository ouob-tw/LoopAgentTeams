// The controller page's 代決 cards (#663): what the helper's cards read into, the detail showing
// only the lines a record has, and the host's seen marks counted for the roster's 代決 N.
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cardsFrom, detailRows, unseenCount, withSeen, type DelegatedCard } from '../../src/lib/board/delegated.ts';
import { unattendedFrom } from '../../src/lib/board/unattended.ts';
import { loadDelegatedSeen, markDelegatedSeen } from '../../src/lib/server/delegated-state.ts';

const OPINIONS = [
	{ who: 'puma（claude opus）', stance: 'agree', text: '只改命名' },
	{ who: 'kiwi（codex gpt-6）', stance: 'agree', text: '屬固定清單' }
];
const RAW = [
	{ id: 'LAT-AS', kind: 'assumed', title: '元件叫 SignIn', question: '元件要叫什麼', decision: '叫 SignIn', opinions: OPINIONS, revert_to: '改成 LoginPanel', checks: [], sample: null, state: 'open', state_label: '照這樣做了', grant_version: 1 },
	{ id: 'LAT-PC', kind: 'proxy-confirmed', title: '#577 開工', question: '可以開工嗎', decision: null, opinions: OPINIONS, revert_to: null, checks: ['按鈕叫儲存 ← 「改成儲存」'], sample: null, state: 'open', state_label: '照這樣做了', grant_version: 1 },
	{ id: 'LAT-PR', kind: 'prototype-decided', title: '用卡片版', question: null, decision: '卡片版', opinions: [], revert_to: null, checks: [], sample: '.lat/runs/issue-1/proto/', state: 'overturned', state_label: '已由你推翻（2026-11-16T01:00:00+00:00）', grant_version: 1 },
	{ id: 'LAT-X', kind: 'parked' },
	'not a card'
];

test('the helper cards read into cards, leaving out what is not one', () => {
	const cards = cardsFrom(RAW);
	expect(cards.map((card) => [card.id, card.kind, card.state, card.seen])).toEqual([
		['LAT-AS', 'assumed', 'open', false],
		['LAT-PC', 'proxy-confirmed', 'open', false],
		['LAT-PR', 'prototype-decided', 'overturned', false]
	]);
	expect(cards[0].opinions[0]).toEqual({ who: 'puma（claude opus）', agree: true, text: '只改命名' });
	expect(cardsFrom(undefined)).toEqual([]);
});

test('each kind shows its own lines and never an empty field', () => {
	const [assumed, confirmed, sample] = cardsFrom(RAW);
	const labels = (card: DelegatedCard) => detailRows(card).map((row) => row.label);
	expect(labels(assumed)).toEqual(['原本要問', '參謀決定', '兩位參謀', '可以改成']);
	expect(labels(confirmed)).toEqual(['原本要問', '兩位參謀', '驗收對照']);
	expect(labels(sample)).toEqual(['參謀決定', '樣品']);
	for (const card of [assumed, confirmed, sample]) for (const row of detailRows(card)) expect(row.text?.trim() || row.lines?.length).toBeTruthy();
	expect(detailRows(confirmed)[1].lines).toEqual(['puma（claude opus）：同意；只改命名', 'kiwi（codex gpt-6）：同意；屬固定清單']);
});

const status = (delegated: unknown) =>
	unattendedFrom({
		status: 'ok',
		state: 'active',
		settings: { mode: { value: 'unattended', layer: 'controller' }, max_hours: { value: 12 } },
		layer_modes: {},
		review: { state: 'ok', path: '/r.md', count: 3, parked: 0, stamp: 1, delegated }
	});

test('the status read carries the cards, and the seen marks count for 代決 N', () => {
	const controller = { id: 's-1', unattended: status(RAW) };
	expect(unseenCount(controller)).toBe(3);
	const marked = withSeen(controller, { 's-1:LAT-AS': '2026-11-16T00:00:00.000Z', 's-2:LAT-PC': '2026-11-16T00:00:00.000Z' });
	expect(unseenCount(marked)).toBe(2);
	// The view the sources keep is not changed in place.
	expect(unseenCount(controller)).toBe(3);
	const none = { id: 's-1', unattended: status([]) };
	expect(withSeen(none, {})).toBe(none);
	expect(unseenCount(none)).toBe(0);
});

test('the seen marks are kept in the state folder, and an unusable file is not started over', () => {
	const dir = mkdtempSync(join(tmpdir(), 'lat-delegated-seen-'));
	try {
		expect(loadDelegatedSeen(dir)).toEqual({});
		const now = Date.parse('2026-11-16T00:00:00Z');
		markDelegatedSeen(dir, 's-1:LAT-OLD', now - 61 * 24 * 3600 * 1000);
		markDelegatedSeen(dir, 's-1:LAT-AS', now);
		// Marks of a round long over are dropped at the next write.
		expect(Object.keys(loadDelegatedSeen(dir))).toEqual(['s-1:LAT-AS']);
		expect(JSON.parse(readFileSync(join(dir, 'delegated-seen.json'), 'utf8')).seen['s-1:LAT-AS']).toBe('2026-11-16T00:00:00.000Z');
		writeFileSync(join(dir, 'delegated-seen.json'), '{"seen": [1]}');
		expect(() => loadDelegatedSeen(dir)).toThrow('格式不正確');
		expect(() => markDelegatedSeen(dir, 's-1:LAT-PC', now)).toThrow();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('the 回顧 tab counts what still needs the user: unseen 代決, unanswered questions while the controller runs, open parked items (#664)', async () => {
	const { reviewTabCount } = await import('../../src/lib/board/review.ts');
	const view = (review: Record<string, unknown>) => unattendedFrom({ status: 'ok', state: 'active', settings: { mode: { value: 'unattended', layer: 'controller' }, max_hours: { value: 12 } }, layer_modes: {}, review });
	const base = { state: 'ok', path: '/r.md', count: 3, stamp: 1 };
	// One of the three cards seen: two unseen, plus two questions and one parked item.
	const both = withSeen({ id: 's-1', unattended: view({ ...base, parked: 1, asked_open: 2, delegated: RAW }) }, { 's-1:LAT-AS': 'x' });
	expect(reviewTabCount(both, false)).toBe(5);
	// The controller has ended: its questions can no longer be answered, the 代決 still can be overturned.
	expect(reviewTabCount(both, true)).toBe(3);
	// A round after #661 that only asked: not 0.
	expect(reviewTabCount({ unattended: view({ ...base, parked: 0, asked_open: 1, delegated: [] }) }, false)).toBe(1);
	// A helper from before #664 sends no asked_open.
	expect(reviewTabCount({ unattended: view({ ...base, parked: 2, delegated: [] }) }, false)).toBe(2);
	expect(reviewTabCount({ unattended: view({ state: 'none' }) }, false)).toBeNull();
});
